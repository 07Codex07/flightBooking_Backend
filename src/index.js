require("dotenv").config();
require("./config/env");

const express = require("express");
const helmet = require("helmet");
const ratelimit = require("express-rate-limit");


const authRoutes = require("./routes/auth");
const flightRoutes = require("./routes/flights");
const bookingRoutes = require("./routes/bookings");

require("./queues/emailWorker");


const app = express();
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.use(helmet());
app.use(express.json());

const rateLimiter = ratelimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: {message: "Too many requests, please try again later."},
    standardHeaders: true,
    legacyHeaders: false,
});

app.use("/api/auth", rateLimiter);
app.use("/api/auth", authRoutes);
app.use("/api/flights", flightRoutes);
app.use("/api/bookings", bookingRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Server is running on port ${PORT}`));
