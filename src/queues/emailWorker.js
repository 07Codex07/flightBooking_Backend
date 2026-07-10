const { Worker } = require("bullmq");
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    }
});

const worker = new Worker("emailQueue", async (job) => {
    const { email, flightDetails } = job.data;

    await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: "Flight Booking Confirmation",
        text: `Your flight to ${flightDetails.to} on ${flightDetails.date} has been booked successfully.`,
    });
    console.log(`Email sent to ${email} for flight to ${flightDetails.to} on ${flightDetails.date}`);
}, {
    connection: {
        host: process.env.REDIS_HOST || "127.0.0.1",
        port: 6379,
        maxRetriesPerRequest: null,
    }
});

worker.on("completed", (job) => {
    console.log(`Email job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
    console.error(`Email job ${job.id} failed:`, err.message);
});
module.exports = worker;

