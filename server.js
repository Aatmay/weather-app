const express = require("express");
const axios = require("axios");
require("dotenv").config();
const app = express();

const API_KEY = process.env.OPENWEATHER_API_KEY;

app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));

// Emoji mapping function
const getEmoji = (iconCode) => {
  const code = iconCode ? iconCode.replace('n', 'd') : '01d';
  const map = {
    '01d': '☀️',
    '02d': '⛅',
    '03d': '☁️',
    '04d': '☁️',
    '09d': '🌧️',
    '10d': '🌦️',
    '11d': '⛈️',
    '13d': '❄️',
    '50d': '🌫️',
  };
  return map[code] || '🌤️';
};

// Format time helper
const formatTime = (date) => {
  const h = date.getUTCHours();
  const m = date.getUTCMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
};

// Calculate US EPA AQI from PM2.5
const calcAQI = (pm25) => {
  if (pm25 <= 12.0) return Math.round((50 / 12.0) * pm25);
  if (pm25 <= 35.4) return Math.round(((100 - 51) / (35.4 - 12.1)) * (pm25 - 12.1) + 51);
  if (pm25 <= 55.4) return Math.round(((150 - 101) / (55.4 - 35.5)) * (pm25 - 35.5) + 101);
  if (pm25 <= 150.4) return Math.round(((200 - 151) / (150.4 - 55.5)) * (pm25 - 55.5) + 151);
  if (pm25 <= 250.4) return Math.round(((300 - 201) / (250.4 - 150.5)) * (pm25 - 150.5) + 201);
  return Math.round(((500 - 301) / (500.4 - 250.5)) * (pm25 - 250.5) + 301);
};

// Get AQI category
const getAQICategory = (aqiValue) => {
  if (aqiValue <= 50) return { label: "Good", color: "good" };
  if (aqiValue <= 100) return { label: "Moderate", color: "moderate" };
  if (aqiValue <= 150) return { label: "Unhealthy for Sensitive Groups", color: "sensitive" };
  if (aqiValue <= 200) return { label: "Unhealthy", color: "unhealthy" };
  if (aqiValue <= 300) return { label: "Very Unhealthy", color: "veryunhealthy" };
  return { label: "Hazardous", color: "hazardous" };
};

// Capitalize city name
const capitalizeCity = (str) => {
  return str.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
};

// Get MAX rain probability for a given date
const getMaxRainProb = (forecasts, date) => {
  const slots = forecasts.filter(f => f.dt_txt.startsWith(date));
  if (slots.length === 0) return 0;
  return Math.round(Math.max(...slots.map(f => f.pop || 0)) * 100);
};

// Default error data
const getErrorData = () => ({
  error: null, willRain: null, temperature: null,
  description: null, humidity: null, icon: null,
  feelsLike: null, windSpeed: null, rainProb: null,
  fiveDay: [], sunrise: null, sunset: null,
  aqi: null, aqiValue: null, aqiCategory: null,
  aqiArrowPos: 2, warning: null, getEmoji
});

app.get("/", (req, res) => {
  res.render("index");
});

app.post("/weather", async (req, res) => {
  const rawCity = req.body.city ? req.body.city.trim() : "";

  if (!rawCity) {
    return res.render("result", {
      ...getErrorData(),
      city: "Unknown",
      error: "Please enter a city name!"
    });
  }

  const city = capitalizeCity(rawCity);

  try {
    const weatherUrl = `https://api.openweathermap.org/data/2.5/forecast?q=${rawCity}&appid=${API_KEY}&units=metric`;
    const weatherResponse = await axios.get(weatherUrl);
    const forecasts = weatherResponse.data.list;
    const cityData = weatherResponse.data.city;
    const timezoneOffset = cityData.timezone;

    // Get today and tomorrow dates in LOCAL city time
    const nowUtc = Date.now();
    const localNow = new Date(nowUtc + timezoneOffset * 1000);
    const todayDate = localNow.toISOString().split("T")[0];
    const localTomorrow = new Date(localNow);
    localTomorrow.setDate(localTomorrow.getDate() + 1);
    const tomorrowDate = localTomorrow.toISOString().split("T")[0];

    // Pick 12:00 PM forecast for tomorrow
    let tomorrowForecast = forecasts.find(f =>
      f.dt_txt.startsWith(tomorrowDate) && f.dt_txt.includes("12:00:00")
    );
    if (!tomorrowForecast) {
      tomorrowForecast = forecasts.find(f => f.dt_txt.startsWith(tomorrowDate));
    }

    if (!tomorrowForecast) {
      return res.render("result", {
        ...getErrorData(),
        city,
        error: "Could not fetch tomorrow's forecast. Try again!"
      });
    }

    const weather = tomorrowForecast.weather[0];
    const mainWeather = weather.main.toLowerCase();
    const temperature = Math.round(tomorrowForecast.main.temp);
    const feelsLike = Math.round(tomorrowForecast.main.feels_like);
    const description = weather.description;
    const humidity = tomorrowForecast.main.humidity;
    const icon = weather.icon;
    const windSpeed = Math.round(tomorrowForecast.wind.speed * 3.6);

    // MAX rain probability across all slots of tomorrow
    const rainProb = getMaxRainProb(forecasts, tomorrowDate);

    // Determine if it will rain
    const willRain = mainWeather === "rain" ||
      mainWeather === "drizzle" ||
      mainWeather === "thunderstorm" ||
      rainProb >= 50;

    // Correct local Sunrise & Sunset
    const sunriseFormatted = formatTime(new Date(cityData.sunrise * 1000 + timezoneOffset * 1000));
    const sunsetFormatted = formatTime(new Date(cityData.sunset * 1000 + timezoneOffset * 1000));

    // 5 Day Forecast
    const fiveDay = [];
    const seenDates = new Set();

    for (const f of forecasts) {
      const fDateLocal = new Date(f.dt * 1000 + timezoneOffset * 1000);
      const fDate = fDateLocal.toISOString().split("T")[0];
      const fHour = fDateLocal.getUTCHours();

      if (fDate === todayDate) continue;

      if (!seenDates.has(fDate) && fHour === 12) {
        seenDates.add(fDate);
        fiveDay.push({
          date: new Date(fDate + "T12:00:00Z").toLocaleDateString("en-US", {
            weekday: "short", month: "short", day: "numeric"
          }),
          temp: Math.round(f.main.temp),
          icon: f.weather[0].icon,
          description: f.weather[0].description,
          rainProb: getMaxRainProb(forecasts, fDate)
        });
      }
      if (fiveDay.length === 5) break;
    }

    // Fallback if less than 5 days
    if (fiveDay.length < 5) {
      const seenDates2 = new Set(fiveDay.map(d => d.date));
      for (const f of forecasts) {
        const fDate = f.dt_txt.split(" ")[0];
        if (fDate === todayDate) continue;
        const displayDate = new Date(fDate + "T12:00:00Z").toLocaleDateString("en-US", {
          weekday: "short", month: "short", day: "numeric"
        });
        if (!seenDates2.has(displayDate)) {
          seenDates2.add(displayDate);
          fiveDay.push({
            date: displayDate,
            temp: Math.round(f.main.temp),
            icon: f.weather[0].icon,
            description: f.weather[0].description,
            rainProb: getMaxRainProb(forecasts, fDate)
          });
        }
        if (fiveDay.length === 5) break;
      }
    }

    // AQI
    const lat = cityData.coord.lat;
    const lon = cityData.coord.lon;
    const aqiUrl = `http://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${API_KEY}`;
    const aqiResponse = await axios.get(aqiUrl);
    const aqiData = aqiResponse.data.list[0];
    const aqiScale = aqiData.main.aqi;
    const pm25 = aqiData.components.pm2_5;
    const aqiValue = calcAQI(pm25);
    const aqiCategory = getAQICategory(aqiValue);
    const aqiArrowPos = Math.min(Math.max((aqiValue / 500) * 100, 2), 98);

    // Warnings
    let warning = null;
    if (temperature >= 40) {
      warning = { type: "danger", message: "🔥 Extreme Heat Warning! Stay indoors and keep hydrated!" };
    } else if (temperature >= 35) {
      warning = { type: "warning", message: "☀️ Heat Advisory! Avoid outdoor activities during peak hours!" };
    } else if (temperature <= 0) {
      warning = { type: "info", message: "🥶 Extreme Cold Warning! Dress in warm layers!" };
    } else if (temperature <= 5) {
      warning = { type: "info", message: "❄️ Cold Advisory! Wear warm clothing!" };
    } else if (rainProb >= 80) {
      warning = { type: "rain", message: "🌊 Flood Warning! Heavy rainfall expected. Avoid low-lying areas!" };
    } else if (rainProb >= 60) {
      warning = { type: "rain", message: "🌧️ Heavy Rain Warning! Carry an umbrella and drive carefully!" };
    } else if (windSpeed >= 60) {
      warning = { type: "warning", message: "💨 Strong Wind Warning! Secure loose objects outside!" };
    } else if (aqiValue > 150) {
      warning = { type: "warning", message: "😷 Poor Air Quality! Wear a mask if going outside!" };
    }

    res.render("result", {
      city, error: null, willRain, temperature,
      description, humidity, icon, feelsLike,
      windSpeed, rainProb, fiveDay,
      sunrise: sunriseFormatted,
      sunset: sunsetFormatted,
      aqi: aqiScale, aqiValue, aqiCategory,
      aqiArrowPos, warning, getEmoji
    });

  } catch (err) {
    console.log("ERROR:", err.message);
    const statusCode = err.response ? err.response.status : 500;
    const errorMsg = statusCode === 404
      ? "City not found. Please check the spelling and try again!"
      : "Something went wrong. Please try again!";

    res.render("result", {
      ...getErrorData(),
      city,
      error: errorMsg
    });
  }
});

app.listen(3000, () => {
  console.log("Server running at http://localhost:3000");
});