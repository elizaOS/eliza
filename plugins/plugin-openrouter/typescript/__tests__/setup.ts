import { resolve } from "node:path";
import { config } from "dotenv";
import { beforeAll } from "vitest";

beforeAll(() => {
  config({ path: resolve(process.cwd(), ".env") });
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn("⚠️  OPENROUTER_API_KEY not found in .env file. Tests may fail.");
  }
});
