const { z } = require("zod");

const registerSchema = z.object({
    email: z.string().email("Invalid email address"),
    password: z.string().min(8, "Password must be at least 8 characters long"),
});

const loginSchema = z.object({
    email: z.string().email("Invalid email address"),
    password: z.string().min(1, "Password is required"),
});

const createFlightSchema = z.object({
    from: z.string().min(1, "From is required"),
    to: z.string().min(1, "To is required"),
    date: z.string().min(1, "Date is required"),
    price: z.number().positive("Price must be positive"),
    totalSeats: z.number().int().positive("Total seats must be a positive integer"),
});

const bookingSchema = z.object({
    flightId: z.string().min(1, "Flight ID is required"),
});

module.exports = {
    registerSchema,
    loginSchema,
    createFlightSchema,
    bookingSchema
};