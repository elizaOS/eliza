import { defineConfig } from "drizzle-kit";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required to generate or run Drizzle migrations");
}

export default defineConfig({
  out: "./drizzle",
  schema: ["./src/schema.ts", "./src/schema-auth.ts"],
  dialect: "postgresql",
  dbCredentials: {
    url: connectionString,
  },
  verbose: true,
  strict: true,
});
