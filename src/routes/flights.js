const express = require("express");
const router = express.Router();
const prisma = require("../prismaClient");
const authenticate = require("../middleware/authenticate");
const redis = require("../redis/client");
const validate = require("../middleware/validate");
const { createFlightSchema } = require("../validators/schemas");


const inAdmin = (req, res, next) => {
    if (req.role !== "ADMIN") return res.status(403).json({message: "Unauthorized"});
    next();
};

router.post("/", authenticate, inAdmin, validate(createFlightSchema), async (req, res) => {
    try {
        const { from, to, date, price, totalSeats } = req.body;
        const flight = await prisma.flight.create({
            data: {
                from,
                to,
                date: new Date(date),
                price,
                totalSeats,
                availableSeats: totalSeats
            }
        });
        await redis.del("all_flights")
        res.status(201).json(flight);
    } catch (error) {
        res.status(500).json({error: error.message});
    }
});

router.get("/", authenticate, async (req, res) => {
    try {
        const {from, to, date } = req.query;

        const cacheKey = `flights:${from || "any"}:${to || "any"}:${date || "any"}`;

        const cached = await redis.get(cacheKey);
        if (cached) {
            console.log("Cache hit for flights", cacheKey);
            return res.json(JSON.parse(cached));
        }

        console.log("cache miss - hitting MongoDB:", cacheKey);

        const flights = await prisma.flight.findMany({
            where: {
                ...(from && {from}),
                ...(to && {to}),
                ...(date && {
                    date: {
                        gte: new Date(date),
                        lt: new Date(new Date(date).setDate(new Date(date).getDate() + 1))
                    }
                }),
                availableSeats: { gt: 0 }
            }
        });

        await redis.set(cacheKey, JSON.stringify(flights), "EX", 3600);
        console.log("Cache set for flights", cacheKey);

        res.json(flights);
    } catch (error) {
        res.status(500).json({error: error.message});
    }
})

module.exports = router;