# Flight Booking API — Backend Guide

A beginner-friendly walkthrough of the entire backend: what each file does, how requests flow through the system, and how MongoDB, JWT auth, Prisma, Redis, BullMQ, Zod validation, and Docker work together.

---

## What does this project do?

This is a **REST API** for booking flights. Users can:

1. **Register** and **login** → receive a JWT token
2. **Search** available flights (with Redis caching)
3. **Book** a flight → seat count decreases atomically, confirmation email is queued
4. **View** and **cancel** their bookings

**Admins** can also create new flights. Use the `makeAdmin.js` script to promote a user to admin.

---

## Tech stack

| Tool | Purpose |
|------|---------|
| **Node.js** | Runs JavaScript on the server |
| **Express** | HTTP framework — routes, JSON parsing, middleware |
| **Prisma** | ORM — talks to MongoDB with clean JavaScript calls |
| **MongoDB** | Database — stores users, flights, bookings |
| **JWT** | Stateless authentication after login |
| **bcrypt** | Hashes passwords before storing them |
| **Zod** | Input validation for request bodies and env vars |
| **Helmet** | Sets security HTTP headers |
| **express-rate-limit** | Rate limits auth endpoints against brute force |
| **Redis** | Flight search caching + BullMQ job queue backend |
| **BullMQ** | Background job queue (email sending) |
| **Nodemailer** | Sends confirmation emails via Gmail |
| **Docker** | Containerized deployment with Redis sidecar |

---

## Project structure

```
flightBooking/
├── prisma/
│   └── schema.prisma          # Database models (User, Flight, Booking)
├── src/
│   ├── index.js               # Entry point — server, security, routes
│   ├── prismaClient.js        # Single Prisma connection to MongoDB
│   ├── config/
│   │   └── env.js             # Validates required env vars on startup
│   ├── middleware/
│   │   ├── authenticate.js    # Verifies JWT on protected routes
│   │   └── validate.js        # Zod validation middleware
│   ├── validators/
│   │   └── schemas.js         # Zod schemas for all endpoints
│   ├── routes/
│   │   ├── auth.js            # Register + login
│   │   ├── flights.js         # Create + search flights (Redis cache)
│   │   └── bookings.js        # Book, list, cancel
│   ├── redis/
│   │   └── client.js          # Redis connection
│   ├── queues/
│   │   ├── emailQueue.js      # Adds email jobs to the queue
│   │   └── emailWorker.js     # Processes jobs and sends emails
│   └── scripts/
│       └── makeAdmin.js       # CLI script to promote a user to ADMIN
├── Dockerfile                 # Container image for the API
├── docker-compose.yml         # Runs API + Redis together
├── .dockerignore
├── .env                       # Secrets (never commit this)
└── package.json
```

---

## Full request flow

```
Client (Postman / frontend)
        │
        ▼
   Express (index.js)
   ├── helmet (security headers)
   ├── rate limiter on /api/auth
   └── env validation (startup)
        │
        ├── GET  /health       → { status: "ok" }
        ├── /api/auth          → validate (Zod) → auth.js → Prisma → MongoDB
        ├── /api/flights       → authenticate → Redis cache? → Prisma → MongoDB
        └── /api/bookings      → authenticate → validate → Prisma → MongoDB
                                                    │
                                                    ▼ (after booking)
                                              emailQueue.add()
                                                    │
                                                    ▼
                                              Redis (BullMQ)
                                                    │
                                                    ▼
                                              emailWorker.js
                                                    │
                                                    ▼
                                              Nodemailer → Gmail
```

---

## 1. Server entry point — `src/index.js`

```js
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
    message: { message: "Too many requests, please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use("/api/auth", rateLimiter);
app.use("/api/auth", authRoutes);
app.use("/api/flights", flightRoutes);
app.use("/api/bookings", bookingRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Server is running on port ${PORT}`));
```

**What happens:**

| Piece | Purpose |
|-------|---------|
| `require("./config/env")` | Crashes early with a clear error if env vars are missing/invalid |
| `GET /health` | Health check for load balancers and Docker |
| `helmet()` | Adds security headers (XSS protection, etc.) |
| `rateLimiter` on `/api/auth` | Max 10 requests per 15 minutes on auth routes |
| `"0.0.0.0"` | Binds to all interfaces — required inside Docker containers |
| `require("./queues/emailWorker")` | Starts the background email worker |

---

## 2. Environment validation — `src/config/env.js`

Validates all required environment variables **before** the server starts using Zod:

```js
const envSchema = z.object({
    DATABASE_URL: z.string().min(1),
    JWT_SECRET: z.string().min(10, "JWT secret must be at least 10 characters long"),
    EMAIL_USER: z.string().email(),
    EMAIL_PASS: z.string().min(1),
    PORT: z.string().optional().default("3000"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error("Invalid environment variables: ");
    parsed.error.issues.forEach(err => {
        console.error(`${err.path.join(".")}: ${err.message}`);
    });
    process.exit(1);
}
```

If `JWT_SECRET` is too short or `EMAIL_USER` is not a valid email, the process exits immediately instead of crashing later with a cryptic error.

---

## 3. Validation middleware — `src/middleware/validate.js`

Reusable middleware that runs a Zod schema against `req.body` before the route handler:

```js
const validate = (schema) => (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
        const errors = result.error.issues.map(err => ({
            field: err.path[0],
            message: err.message,
        }));
        return res.status(400).json({ errors });
    }
    req.body = result.data;
    next();
};
```

Used on register, login, create flight, and book endpoints.

---

## 4. Zod schemas — `src/validators/schemas.js`

```js
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
```

Invalid requests return `400` with a structured `errors` array before any database call is made.

---

## 5. Database connection — `src/prismaClient.js`

```js
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

prisma.$connect()
  .then(() => console.log("Connected to MongoDB via Prisma"))
  .catch((err) => console.error("Prisma connection error:", err));

module.exports = prisma;
```

---

## 6. Database models — `prisma/schema.prisma`

```prisma
model User {
  id        String    @id @default(auto()) @map("_id") @db.ObjectId
  email     String    @unique
  password  String
  role      Role      @default(USER)
  bookings  Booking[]
  createdAt DateTime  @default(now())
}

model Flight {
  id             String    @id @default(auto()) @map("_id") @db.ObjectId
  from           String
  to             String
  date           DateTime
  price          Float
  totalSeats     Int
  availableSeats Int
  bookings       Booking[]
}

model Booking {
  id        String        @id @default(auto()) @map("_id") @db.ObjectId
  user      User          @relation(fields: [userId], references: [id])
  userId    String        @db.ObjectId
  flight    Flight        @relation(fields: [flightId], references: [id])
  flightId  String        @db.ObjectId
  status    BookingStatus @default(PENDING)
  createdAt DateTime      @default(now())
}

enum Role { USER  ADMIN }
enum BookingStatus { PENDING  CONFIRMED  CANCELLED }
```

---

## 7. Authentication — `src/routes/auth.js`

### Register — `POST /api/auth/register`

```js
router.post("/register", validate(registerSchema), async (req, res) => {
    try {
        const { email, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await prisma.user.create({
            data: { email, password: hashedPassword }
        });
        res.status(201).json({ message: "User registered successfully" });
    } catch (error) {
        if (error.code === "P2002") {
            return res.status(400).json({ message: "User already exists" });
        }
        res.status(500).json({ error: error.message });
    }
});
```

**Flow:** Zod validates email format + min 8 char password → bcrypt hash → save to DB. Duplicate email returns `400` (not `500`).

### Login — `POST /api/auth/login`

```js
router.post("/login", validate(loginSchema), async (req, res) => {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: "Invalid credentials" });

    const token = jwt.sign(
        { userId: user.id },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
    );
    res.json({ token });
});
```

Protected by rate limiting (10 requests / 15 min on all `/api/auth` routes).

---

## 8. Auth middleware — `src/middleware/authenticate.js`

```js
const authenticate = async (req, res, next) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ message: "No token provided" });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
        req.userId = decoded.userId;
        req.role = user.role;
        req.userEmail = user.email;
        next();
    } catch (error) {
        res.status(401).json({ message: "Invalid token" });
    }
};
```

Attach to every protected request:

```
Authorization: Bearer <token>
```

---

## 9. Flights — `src/routes/flights.js`

### Create flight — `POST /api/flights` (Admin only)

```js
router.post("/", authenticate, inAdmin, validate(createFlightSchema), async (req, res) => {
    const { from, to, date, price, totalSeats } = req.body;
    const flight = await prisma.flight.create({
        data: {
            from, to,
            date: new Date(date),
            price, totalSeats,
            availableSeats: totalSeats
        }
    });
    await redis.del("all_flights");
    res.status(201).json(flight);
});
```

**Middleware chain:** `authenticate` → `inAdmin` → `validate(createFlightSchema)` → handler

### Search flights — `GET /api/flights` (with Redis caching)

```js
router.get("/", authenticate, async (req, res) => {
    const { from, to, date } = req.query;
    const cacheKey = `flights:${from || "any"}:${to || "any"}:${date || "any"}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
        return res.json(JSON.parse(cached));   // cache hit — skip MongoDB
    }

    const flights = await prisma.flight.findMany({
        where: {
            ...(from && { from }),
            ...(to && { to }),
            ...(date && {
                date: {
                    gte: new Date(date),
                    lt: new Date(new Date(date).setDate(new Date(date).getDate() + 1))
                }
            }),
            availableSeats: { gt: 0 }
        }
    });

    await redis.set(cacheKey, JSON.stringify(flights), "EX", 3600);  // cache 1 hour
    res.json(flights);
});
```

**How Redis caching works here:**

```
Request → build key "flights:DEL:BOM:2026-06-21"
       → redis.get(key)
           ├── HIT  → return cached JSON immediately
           └── MISS → query MongoDB → redis.set(key, data, EX 3600) → return
```

Redis is used for **two things** in this project:
1. **Caching** flight search results (above)
2. **Job queue** for BullMQ emails (see section 12)

---

## 10. Bookings — `src/routes/bookings.js`

### Book a flight — `POST /api/bookings` (atomic seat update)

```js
router.post("/", authenticate, validate(bookingSchema), async (req, res) => {
    const { flightId } = req.body;

    const flight = await prisma.flight.findUnique({ where: { id: flightId } });
    if (!flight) return res.status(404).json({ message: "flight not found" });
    if (flight.availableSeats === 0) return res.status(400).json({ message: "Flight is full" });

    const [updatedFlight, booking] = await prisma.$transaction(async (tx) => {
        const updatedFlight = await tx.flight.update({
            where: {
                id: flightId,
                availableSeats: { gt: 0 }   // atomic — only succeeds if seat exists NOW
            },
            data: { availableSeats: { decrement: 1 } }
        });

        const booking = await tx.booking.create({
            data: { userId: req.userId, flightId, status: "CONFIRMED" }
        });

        return [updatedFlight, booking];
    });

    await emailQueue.add("sendEmail", { email: req.userEmail, flightDetails: flight });
    res.status(201).json(booking);
});
```

**Why atomic update?** Two users booking the last seat at the same time — only one wins. The other gets Prisma error `P2025` → `404 Flight not found or no seats available`.

**Order matters:** Decrement seat first, then create booking. If booking fails, the whole transaction rolls back.

### List my bookings — `GET /api/bookings`

```js
router.get("/", authenticate, async (req, res) => {
    const bookings = await prisma.booking.findMany({
        where: { userId: req.userId },
        include: { flight: true }
    });
    res.json(bookings);
});
```

### Cancel a booking — `DELETE /api/bookings/:id`

```js
router.delete("/:id", authenticate, async (req, res) => {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    if (booking.userId !== req.userId) return res.status(403).json({ message: "Unauthorized" });
    if (booking.status !== "CONFIRMED") return res.status(400).json({ message: "Booking is not confirmed" });

    await prisma.$transaction([
        prisma.booking.update({
            where: { id: req.params.id },
            data: { status: "CANCELLED" }
        }),
        prisma.flight.update({
            where: { id: booking.flightId },
            data: { availableSeats: { increment: 1 } }
        })
    ]);

    res.json({ message: "Booking cancelled successfully" });
});
```

The `status !== "CONFIRMED"` check prevents **double-cancel** — cancelling twice would otherwise increment seats twice.

---

## 11. Redis — `src/redis/client.js`

```js
const redis = new Redis({
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: 6379,
});
```

`REDIS_HOST` defaults to `127.0.0.1` locally. In Docker it is set to `redis` (the service name in `docker-compose.yml`).

---

## 12. Email queue — `src/queues/emailQueue.js` + `emailWorker.js`

**Producer** (called from booking route):

```js
const emailQueue = new Queue("emailQueue", {
    connection: { host: process.env.REDIS_HOST || "127.0.0.1", port: 6379 }
});

await emailQueue.add("sendEmail", { email, flightDetails });
```

**Consumer** (started in `index.js`):

```js
const worker = new Worker("emailQueue", async (job) => {
    const { email, flightDetails } = job.data;
    await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: "Flight Booking Confirmation",
        text: `Your flight to ${flightDetails.to} on ${flightDetails.date} has been booked successfully.`,
    });
}, { connection: { host: process.env.REDIS_HOST || "127.0.0.1", port: 6379 } });
```

The API responds immediately; the worker sends the email in the background.

---

## 13. Admin script — `src/scripts/makeAdmin.js`

Promote a registered user to `ADMIN` without manually editing MongoDB Atlas:

```bash
node src/scripts/makeAdmin.js you@example.com
```

```js
const user = await prisma.user.update({
    where: { email },
    data: { role: "ADMIN" }
});
console.log(`${user.email} is now an admin`);
```

---

## Environment variables (`.env`)

```env
DATABASE_URL="mongodb+srv://<user>:<password>@<cluster>.mongodb.net/flightbooking"
JWT_SECRET=your-long-random-secret-at-least-10-chars
EMAIL_USER=your@gmail.com
EMAIL_PASS=your-gmail-app-password
PORT=3000
REDIS_HOST=127.0.0.1        # use "redis" when running in Docker
```

| Variable | Used by |
|----------|---------|
| `DATABASE_URL` | Prisma → MongoDB |
| `JWT_SECRET` | Signing and verifying login tokens (min 10 chars) |
| `EMAIL_USER` | Nodemailer sender address |
| `EMAIL_PASS` | Gmail App Password |
| `PORT` | Server port (default 3000) |
| `REDIS_HOST` | Redis connection (default `127.0.0.1`, `redis` in Docker) |

Never commit `.env` to git.

---

## How to run locally

**Prerequisites:** Node.js, MongoDB Atlas (IP whitelisted), Redis on `127.0.0.1:6379`, Gmail App Password

```bash
cd flightBooking
npm install
npx prisma generate
npm run dev
```

Expected output:
```
Connected to MongoDB via Prisma
Connected to Redis
Server is running on port 3000
```

---

## How to run with Docker

```bash
cd flightBooking
docker-compose up --build
```

`docker-compose.yml` runs two services:

| Service | Image | Port |
|---------|-------|------|
| `app` | Built from `Dockerfile` | `3000:3000` |
| `redis` | `redis:alpine` | `6380:6379` |

The app container gets `REDIS_HOST=redis` so it connects to the Redis container by service name.

**Dockerfile:**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
EXPOSE 3000
CMD ["node", "src/index.js"]
```

---

## API reference

| Method | Endpoint | Auth | Who | Description |
|--------|----------|------|-----|-------------|
| `GET` | `/health` | No | Anyone | Health check |
| `POST` | `/api/auth/register` | No | Anyone | Create account (Zod validated) |
| `POST` | `/api/auth/login` | No | Anyone | Get JWT token (rate limited) |
| `POST` | `/api/flights` | Yes | ADMIN | Create a new flight |
| `GET` | `/api/flights` | Yes | Any user | Search flights (Redis cached) |
| `POST` | `/api/bookings` | Yes | Any user | Book a flight + queue email |
| `GET` | `/api/bookings` | Yes | Any user | List my bookings |
| `DELETE` | `/api/bookings/:id` | Yes | Owner only | Cancel a confirmed booking |

---

## Example Postman flow

### 1. Register
```
POST http://localhost:3000/api/auth/register
Content-Type: application/json

{ "email": "you@test.com", "password": "secret123" }
```

### 2. Login
```
POST http://localhost:3000/api/auth/login
Content-Type: application/json

{ "email": "you@test.com", "password": "secret123" }
```

### 3. Make yourself admin (terminal)
```bash
node src/scripts/makeAdmin.js you@test.com
```

### 4. Set auth header on all following requests
```
Authorization: Bearer <your-token-here>
```

### 5. Create a flight (admin only)
```
POST http://localhost:3000/api/flights
Content-Type: application/json

{
  "from": "DEL",
  "to": "BOM",
  "date": "2026-06-21",
  "price": 5000,
  "totalSeats": 100
}
```

### 6. Search flights
```
GET http://localhost:3000/api/flights?from=DEL&to=BOM
```

### 7. Book a flight
```
POST http://localhost:3000/api/bookings
Content-Type: application/json

{ "flightId": "<id-from-step-6>" }
```

### 8. View bookings
```
GET http://localhost:3000/api/bookings
```

### 9. Cancel a booking
```
DELETE http://localhost:3000/api/bookings/<booking-id>
```

---

## Security features

| Feature | Where | What it does |
|---------|-------|--------------|
| **Helmet** | `index.js` | Sets secure HTTP headers |
| **Rate limiting** | `index.js` | 10 req / 15 min on `/api/auth` |
| **Zod validation** | All write endpoints | Rejects bad input before DB calls |
| **bcrypt** | `auth.js` | Passwords never stored in plain text |
| **JWT** | `authenticate.js` | Stateless token auth |
| **Env validation** | `config/env.js` | Fails fast on missing secrets |
| **Atomic booking** | `bookings.js` | Prevents seat overbooking race condition |
| **Double-cancel guard** | `bookings.js` | Only `CONFIRMED` bookings can be cancelled |
| **Duplicate email** | `auth.js` | Returns `400` on re-register (P2002) |

---

## Key concepts

### Middleware chain (example: create flight)
```
Request → helmet → express.json() → authenticate → inAdmin → validate(schema) → handler
```

### Prisma operations used

| Method | Used for |
|--------|----------|
| `prisma.user.create()` | Register |
| `prisma.user.findUnique()` | Login, auth middleware |
| `prisma.user.update()` | makeAdmin script |
| `prisma.flight.create()` | Admin creates flight |
| `prisma.flight.findMany()` | Search flights |
| `prisma.flight.update()` | Atomic seat decrement/increment |
| `prisma.booking.create()` | Book a flight |
| `prisma.booking.findMany()` | List user's bookings |
| `prisma.$transaction(async (tx) => {...})` | Interactive transaction — atomic booking |
| `prisma.$transaction([])` | Batch transaction — cancel booking |

### Redis dual role

| Role | How | File |
|------|-----|------|
| **Cache** | `redis.get` / `redis.set` with TTL | `flights.js` |
| **Queue** | BullMQ stores email jobs | `emailQueue.js`, `emailWorker.js` |

### Queue pattern
```
Booking route → emailQueue.add(job) → Redis → emailWorker → Gmail
     ↑ responds immediately              ↑ processes in background
```

---

## One-sentence summary

**User registers (Zod validated) → logs in (rate limited) → gets a JWT → searches flights (Redis cached) → books atomically in a transaction → BullMQ queues a confirmation email via Redis → worker sends it via Nodemailer — all containerized with Docker.**
