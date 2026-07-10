const express = require("express");
const router = express.Router();
const prisma = require("../prismaClient");
const authenticate = require("../middleware/authenticate");
const emailQueue = require("../queues/emailQueue");
const validate = require("../middleware/validate");
const { bookingSchema } = require("../validators/schemas");


// booking a ticket
router.post("/", authenticate, validate(bookingSchema), async (req, res) => {
    try {
        const { flightId } = req.body;

        const flight = await prisma.flight.findUnique({where: {id: flightId}});
        if (!flight) return res.status(404).json({message: "flight not found"});
        if (flight.availableSeats === 0) return res.status(400).json({message: "Flight is full"});

        const [updatedFlight, booking] = await prisma.$transaction(async (tx) => {

            const updatedFlight = await tx.flight.update({
                where: {
                    id: flightId,
                    availableSeats: { gt: 0 }
                },
                data: {
                availableSeats: { decrement: 1 }
            }
        });
            
        const booking = await tx.booking.create({
            data: {
                userId: req.userId,
                flightId,
                status: "CONFIRMED"
            }
        });

        return [updatedFlight, booking];
    });
    await emailQueue.add("sendEmail", {
        email: req.userEmail,
        flightDetails: flight
    });
    res.status(201).json(booking);
} catch (error) {
    if (error.code === "P2025") {
        return res.status(404).json({message: "Flight not found or no seats available"});
    }
    res.status(500).json({error: error.message});
}
});

// get all bookings
router.get("/", authenticate, validate(bookingSchema), async (req, res) => {
    try {
        const bookings = await prisma.booking.findMany({
            where: {userId: req.userId},
            include: {
                flight: true}
        });
        res.json(bookings);
    } catch (error) {
        res.status(500).json({error: error.message});
    }
});

// delete a booking
router.delete("/:id", authenticate, async (req, res) => {
    try {
        const booking = await prisma.booking.findUnique({where: {id: req.params.id}});
        if (!booking) return res.status(404).json({message: "Booking not found"});
        if (booking.userId !== req.userId) return res.status(403).json({message: "Unauthorized"});
        if (booking.status !== "CONFIRMED") return res.status(400).json({message: "Booking is not confirmed"});

        await prisma.$transaction([
            prisma.booking.update({
                where: { id: req.params.id },
                data: {
                    status: "CANCELLED"
                }
            }),
            prisma.flight.update({
                where: {
                    id: booking.flightId
                },
                data: {
                    availableSeats: {
                        increment: 1
                    }
                }
            })
        ])
        res.json({message: "Booking cancelled successfully"});
    } catch (error) {
        res.status(500).json({error: error.message});
    }
});

module.exports = router;