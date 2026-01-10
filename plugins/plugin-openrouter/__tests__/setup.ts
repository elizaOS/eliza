import { config } from "dotenv";
import { beforeAll } from "bun:test";
import { resolve } from "path";

// Load environment variables from .env file
beforeAll(() => {
	config({ path: resolve(process.cwd(), ".env") });

	// Check if required environment variables are set
	if (!process.env.OPENROUTER_API_KEY) {
		console.warn(
			"⚠️  OPENROUTER_API_KEY not found in .env file. Tests may fail.",
		);
	}
});
