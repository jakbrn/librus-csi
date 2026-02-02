const { LibrusAPI } = require("librus-api-rewrited");
const express = require("express");
const dotenv = require("dotenv");
const ics = require("ics");
const {
  getEvents,
  getLessonsForWeek,
  processLessonTimetable,
} = require("./utils");
dotenv.config();

const librusApi = new LibrusAPI();
const app = express();

// Cache object
const cache = {
  events: {
    data: null,
    timestamp: 0,
  },
  lessons: {
    data: null,
    timestamp: 0,
  },
  lessonsByWeek: {}, // Store lessons by week key
};

let activeToken = null;
let tokenExpiry = 0;

// API Request Queue
class RequestQueue {
  constructor(delayBetweenRequests = 500) {
    this.queue = [];
    this.processing = false;
    this.delay = delayBetweenRequests;
  }

  async add(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;

    while (this.queue.length > 0) {
      const { task, resolve, reject } = this.queue.shift();

      try {
        const result = await task();
        resolve(result);
      } catch (error) {
        reject(error);
      }

      // Wait before processing next request
      if (this.queue.length > 0) {
        await new Promise((r) => setTimeout(r, this.delay));
      }
    }

    this.processing = false;
  }
}

const requestQueue = new RequestQueue(500); // 500ms between requests

async function ensureToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && activeToken && now < tokenExpiry) {
    return true;
  }

  try {
    console.log("Creating new Librus token...");
    const success = await librusApi.mkToken(
      process.env.LOGIN,
      process.env.PASSWORD,
    );
    if (success) {
      activeToken = true;
      tokenExpiry = now + 55 * 60 * 1000;
      return true;
    }
  } catch (error) {
    console.error("Token creation failed:", error);
  }
  return false;
}

function invalidateToken() {
  console.log("Invalidating token due to auth error");
  activeToken = null;
  tokenExpiry = 0;
}

// Helper functions for week calculations
function getWeekKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getWeekStart(weeksOffset = 0) {
  const now = new Date();
  const monday = getMonday(now);
  monday.setDate(monday.getDate() + weeksOffset * 7);
  return monday;
}

function isPreviousWeek(weekStart) {
  const currentWeekStart = getWeekStart(0);
  return weekStart < currentWeekStart;
}

// Get school year start date (September 1st)
function getSchoolYearStart() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth(); // 0-based: 0=Jan, 8=Sep

  // If we're before September, the school year started last year
  const schoolYearStartYear = currentMonth < 8 ? currentYear - 1 : currentYear;

  const startDate = new Date(schoolYearStartYear, 8, 1); // September 1st
  return getMonday(startDate); // Get the Monday of that week
}

// Get school year end date (June 30th)
function getSchoolYearEnd() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();

  // If we're in September or later, school year ends next year
  const schoolYearEndYear = currentMonth >= 8 ? currentYear + 1 : currentYear;

  const endDate = new Date(schoolYearEndYear, 5, 30); // June 30th
  return getMonday(endDate); // Get the Monday of that week
}

// Get all week starts from September 1 to June 30
function getAllSchoolWeeks() {
  const weeks = [];
  const start = getSchoolYearStart();
  const end = getSchoolYearEnd();

  let current = new Date(start);
  while (current <= end) {
    weeks.push(new Date(current));
    current.setDate(current.getDate() + 7); // Move to next week
  }

  return weeks;
}

// Categorize weeks: current/next 2 vs all others
function categorizeWeeks() {
  const allWeeks = getAllSchoolWeeks();
  const currentWeekStart = getWeekStart(0);
  const twoWeeksLater = new Date(currentWeekStart);
  twoWeeksLater.setDate(twoWeeksLater.getDate() + 14); // 2 weeks ahead

  const currentAndNext = [];
  const others = [];

  allWeeks.forEach((week) => {
    if (week >= currentWeekStart && week <= twoWeeksLater) {
      currentAndNext.push(week);
    } else {
      others.push(week);
    }
  });

  return { currentAndNext, others };
}

// Fetch lessons for a specific week
async function fetchWeekLessons(weekStart, retryCount = 0) {
  const weekKey = getWeekKey(weekStart);
  const MAX_RETRIES = 1;

  try {
    console.log(`Fetching lessons for week: ${weekKey}`);
    const lessons = await requestQueue.add(async () => {
      if (!(await ensureToken())) {
        throw new Error("Authentication failed");
      }
      return await getLessonsForWeek(librusApi, weekStart);
    });

    // Only cache if we got actual data or empty array (not error)
    cache.lessonsByWeek[weekKey] = {
      data: lessons,
      timestamp: Date.now(),
    };

    console.log(`✓ Cached ${lessons.length} lessons for week ${weekKey}`);
    return lessons;
  } catch (err) {
    // Check if it's a 401 auth error
    if (err.status === 401 || (err.response && err.response.status === 401)) {
      console.error(`Auth error for week ${weekKey}, invalidating token`);
      invalidateToken();

      // Retry once with a fresh token
      if (retryCount < MAX_RETRIES) {
        console.log(`Retrying week ${weekKey} with fresh token...`);
        await new Promise((r) => setTimeout(r, 1000)); // Wait 1 second
        return await fetchWeekLessons(weekStart, retryCount + 1);
      }
    }

    console.error(`Error fetching week ${weekKey}:`, err);
    // Don't cache errors - keep previous cache if it exists
    return cache.lessonsByWeek[weekKey]?.data || [];
  }
}

// Compile all cached lessons into ICS format
function compileLessonsCache() {
  const allLessons = [];
  Object.values(cache.lessonsByWeek).forEach((weekCache) => {
    if (weekCache.data) {
      allLessons.push(...weekCache.data);
    }
  });

  const { error, value } = ics.createEvents(allLessons);
  if (error) {
    console.error("ICS compilation error:", error);
    return null;
  }

  cache.lessons.data = value;
  cache.lessons.timestamp = Date.now();
  return value;
}

// Background refresh scheduler
async function refreshCurrentAndNextWeeks() {
  const { currentAndNext } = categorizeWeeks();
  console.log(
    `[Refresh] Current and next weeks (${currentAndNext.length} weeks)...`,
  );

  for (const week of currentAndNext) {
    await fetchWeekLessons(week);
  }

  compileLessonsCache();
  console.log("[Refresh] Current/next weeks complete");
}

async function refreshOtherWeeks() {
  const { others } = categorizeWeeks();
  console.log(`[Refresh] Other weeks (${others.length} weeks)...`);

  for (const week of others) {
    await fetchWeekLessons(week);
  }

  compileLessonsCache();
  console.log("[Refresh] Other weeks complete");
}

// Initial data fetch
async function initialFetch() {
  const allWeeks = getAllSchoolWeeks();
  const schoolYearStart = getSchoolYearStart();
  const schoolYearEnd = getSchoolYearEnd();

  console.log("[Initial] Starting initial data fetch...");
  console.log(
    `[Initial] School year: ${schoolYearStart.toISOString().split("T")[0]} to ${schoolYearEnd.toISOString().split("T")[0]}`,
  );
  console.log(`[Initial] Total weeks to fetch: ${allWeeks.length}`);

  // Fetch all weeks from September to June
  for (const week of allWeeks) {
    await fetchWeekLessons(week);
  }

  compileLessonsCache();
  console.log("[Initial] Initial fetch complete");
}

// Schedule background refreshes
function setupSchedulers() {
  // Current and next 2 weeks: every 30 minutes
  setInterval(
    () => {
      refreshCurrentAndNextWeeks().catch((err) => {
        console.error("Error in current/next weeks refresh:", err);
      });
    },
    30 * 60 * 1000,
  );

  // All other weeks (previous and future beyond 2 weeks): twice a day (every 12 hours)
  setInterval(
    () => {
      refreshOtherWeeks().catch((err) => {
        console.error("Error in other weeks refresh:", err);
      });
    },
    12 * 60 * 60 * 1000,
  );

  console.log("✓ Schedulers configured");
  console.log("  - Current + next 2 weeks: every 30 minutes");
  console.log("  - All other weeks: every 12 hours");
}

// API Endpoints
app.get(["/calendar", "/events"], async (req, res) => {
  // Set proper headers for iCalendar
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", "inline; filename=calendar.ics");

  const now = Date.now();
  const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

  if (cache.events.data && now - cache.events.timestamp < CACHE_TTL) {
    return res.send(cache.events.data);
  }

  try {
    const entries = await requestQueue.add(async () => {
      if (!(await ensureToken())) {
        throw new Error("Authentication failed");
      }
      return await getEvents(librusApi);
    });

    const { error, value } = ics.createEvents(entries);

    if (error) {
      console.error("ICS Error:", error);
      return res.status(500).send("Error creating calendar");
    }

    cache.events.data = value;
    cache.events.timestamp = now;
    res.send(value);
  } catch (err) {
    console.error("Fetch error:", err);
    res.status(500).send("Failed to fetch events");
  }
});

app.get("/lessons", async (req, res) => {
  // Set proper headers for iCalendar
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", "inline; filename=lessons.ics");

  // Always serve from cache if available
  if (cache.lessons.data) {
    return res.send(cache.lessons.data);
  }

  // If no cache, trigger immediate fetch
  try {
    await refreshCurrentAndNextWeeks();

    if (cache.lessons.data) {
      return res.send(cache.lessons.data);
    }

    return res
      .status(503)
      .send("Calendar data not ready yet, please try again in a moment");
  } catch (err) {
    console.error("Fetch error:", err);
    res.status(500).send("Failed to fetch lessons");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);

  // Start initial fetch and setup schedulers
  await initialFetch();
  setupSchedulers();
});
