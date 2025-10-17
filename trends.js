// trends.js
import express from "express";
import fetch from "node-fetch"; // install with: npm install node-fetch

const router = express.Router();

// Example: use a third-party TikTok trends API
router.get("/trends", async (req, res) => {
  try {
    // Replace with a real TikTok/third-party API endpoint
    const response = await fetch("https://api.tiktokglobaltrends.com/v1/trending?limit=10", {
      headers: {
        "Authorization": `Bearer ${process.env.TIKTOK_API_KEY}` // keep key in .env
      }
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`);
    }

    const data = await response.json();

    // Simplify response for frontend
    const trends = data.trends.map(t => ({
      hashtag: t.name,
      videos: t.stats?.videoCount,
      sound: t.music?.title
    }));

    res.json({ trends });
  } catch (error) {
    console.error("Trend fetch error:", error);
    res.status(500).json({ error: "Failed to fetch trends" });
  }
});

export default router;
