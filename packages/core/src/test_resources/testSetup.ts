import dotenv from "dotenv";
import path from "node:path";

// Load test environment variables
const envPath = path.resolve(__dirname, "../../.env.test");
console.log("Current directory:", __dirname);
console.log("Trying to load env from:", envPath);
const result = dotenv.config({ path: envPath });
if (result.error) {
    console.error("Error loading .env.test:", result.error);
}
