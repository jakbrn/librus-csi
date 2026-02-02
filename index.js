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

async function ensureToken() {
  const now = Date.now();
  if (activeToken && now < tokenExpiry) {
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

// Fetch lessons for a specific week
async function fetchWeekLessons(weekStart) {
  const weekKey = getWeekKey(weekStart);

  try {
    console.log(`Fetching lessons for week: ${weekKey}`);
    const lessons = await requestQueue.add(async () => {
      if (!(await ensureToken())) {
        throw new Error("Authentication failed");
      }
      return await getLessonsForWeek(librusApi, weekStart);
    });

    cache.lessonsByWeek[weekKey] = {
      data: lessons,
      timestamp: Date.now(),
    };

    console.log(`✓ Cached ${lessons.length} lessons for week ${weekKey}`);
    return lessons;
  } catch (err) {
    console.error(`Error fetching week ${weekKey}:`, err);
    return [];
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
  console.log("[Refresh] Current and next 2 weeks...");

  for (let i = 0; i <= 2; i++) {
    await fetchWeekLessons(getWeekStart(i));
  }

  compileLessonsCache();
  console.log("[Refresh] Current/next weeks complete");
}

async function refreshPreviousWeeks() {
  console.log("[Refresh] Previous weeks...");

  // Fetch 4 weeks back
  for (let i = -4; i < 0; i++) {
    await fetchWeekLessons(getWeekStart(i));
  }

  compileLessonsCache();
  console.log("[Refresh] Previous weeks complete");
}

// Initial data fetch
async function initialFetch() {
  console.log("[Initial] Starting initial data fetch...");

  // Fetch previous weeks
  await refreshPreviousWeeks();

  // Fetch current and next weeks
  await refreshCurrentAndNextWeeks();

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

  // Previous weeks: twice a day (every 12 hours)
  setInterval(
    () => {
      refreshPreviousWeeks().catch((err) => {
        console.error("Error in previous weeks refresh:", err);
      });
    },
    12 * 60 * 60 * 1000,
  );

  console.log("✓ Schedulers configured");
  console.log("  - Current/next weeks: every 30 minutes");
  console.log("  - Previous weeks: every 12 hours");
}

// API Endpoints
app.get(["/calendar", "/events"], async (req, res) => {
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
