const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

prisma.$connect()
  .then(() => console.log("Connected to MongoDB via Prisma"))
  .catch((err) => console.error("Prisma connection error:", err));

module.exports = prisma;