const { LibrusAPI } = require("librus-api-rewrited");
const express = require("express");
const dotenv = require("dotenv");
const ics = require("ics");
const { getEvents, getLessons } = require("./utils");
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
};

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

let activeToken = null;
let tokenExpiry = 0;
async function ensureToken() {
  const now = Date.now();
  // Reuse token if it exists and is not expired (assuming 55 min validity)
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

app.get(["/calendar", "/events"], async (req, res) => {
  const now = Date.now();
  if (cache.events.data && now - cache.events.timestamp < CACHE_TTL) {
    return res.send(cache.events.data);
  }
  if (!(await ensureToken())) {
    return res.status(500).send("Authentication failed");
  }

  try {
    const entries = await getEvents(librusApi);
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
  const now = Date.now();
  if (cache.lessons.data && now - cache.lessons.timestamp < CACHE_TTL) {
    return res.send(cache.lessons.data);
  }

  if (!(await ensureToken())) {
    return res.status(500).send("Authentication failed");
  }

  try {
    const lessons = await getLessons(librusApi);
    const { error, value } = ics.createEvents(lessons);

    if (error) {
      console.error("ICS Error:", error);
      return res.status(500).send("Error creating lessons calendar");
    }

    cache.lessons.data = value;
    cache.lessons.timestamp = now;
    res.send(value);
  } catch (err) {
    console.error("Fetch error:", err);
    res.status(500).send("Failed to fetch lessons");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
