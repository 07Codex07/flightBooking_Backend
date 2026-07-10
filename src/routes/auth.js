const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const prisma = require("../prismaClient");
const validate = require("../middleware/validate");
const { registerSchema, loginSchema } = require("../validators/schemas");


router.post("/register", validate(registerSchema), async (req, res) => {
    try {
        const { email, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await prisma.user.create({
            data: {email, password: hashedPassword}
        });
        res.status(201).json({message: "User registered successfully"});
    } catch (error) {
        if (error.code === "P2002") {
            return res.status(400).json({message: "User already exists"});
        }
        res.status(500).json({error: error.message});
    }
});


router.post("/login", validate(loginSchema), async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await prisma.user.findUnique({where: {email} });
        if (!user) return res.status(401).json({message: "Invalid credentials"});

        const match = await bcrypt.compare(password, user.password);
        if(!match) return res.status(401).json({message: "Invalid credentials"});

        const token = jwt.sign(
            {userId: user.id},
            process.env.JWT_SECRET,
            {expiresIn: "7d"}
        );
        res.json({token});
    } catch (error) {
        res.status(500).json({error: error.message});
    }
});

module.exports = router;