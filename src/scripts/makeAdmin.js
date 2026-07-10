const prisma = require("../prismaClient");
const email = process.argv[2];

if (!email) {
    console.error("Usage: node makeAdmin.js <email>");
    process.exit(1);
}

async function makeAdmin() {
    const user = await prisma.user.update({
        where: { email },
        data: { role: "ADMIN" }
    })
    console.log(`${user.email} is now an admin`);
    await prisma.$disconnect();
}

makeAdmin().catch((err) => {
    console.error("Error making admin:", err);
    process.exit(1);
});