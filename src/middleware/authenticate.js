const jwt = require("jsonwebtoken");
const prisma = require("../prismaClient"); 

const authenticate = async (req, res, next) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({message: "No token provided"});
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await prisma.user.findUnique({where: {id: decoded.userId}});
        req.userId = decoded.userId;
        req.role = user.role;
        req.userEmail = user.email;
        next()
    } catch (error) {
        console.log("auth error: ", error.message)
        res.status(401).json({message: "Invalid token"});
    }
};

module.exports = authenticate;