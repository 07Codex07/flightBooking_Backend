const { Queue } = require("bullmq");
const redis = require("../redis/client");

const emailQueue = new Queue("emailQueue", {
    connection: {
        host: process.env.REDIS_HOST || "127.0.0.1",
        port: 6379,
        maxRetriesPerRequest: null,
    }
});

module.exports = emailQueue;
