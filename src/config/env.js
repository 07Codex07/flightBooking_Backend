const { z } = require("zod");

const envSchema = z.object({
    DATABASE_URL: z.string().min(1),
    JWT_SECRET: z.string().min(10, "JWT secret must be at least 10 characters long"),
    EMAIL_USER: z.string().email(),
    EMAIL_PASS: z.string().min(1),
    PORT: z.string().optional().default("3000"),
});

const parsed = envSchema.safeParse(process.env);

if(!parsed.success) {
    console.error("Invalid environment variables: ");
    parsed.error.issues.forEach(err => {
        console.error(`${err.path.join(".")}: ${err.message}`);
    });
    process.exit(1);
}

module.exports = parsed.data;