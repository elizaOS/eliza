import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Environment file mapping:
// - .env.local       → embedded PGlite or pglite-socket (local dev)
// - .env.development → staging (Neon)
// - .env.production  → production (Neon)
const envFiles: Record<string, string> = {
  local: ".env.local",
  development: ".env.development",
  production: ".env.production",
};
const envFile = envFiles[process.env.NODE_ENV || "local"] || ".env.local";
config({ path: envFile });

// drizzle-kit (introspection / studio / generate) talks to a real Postgres
// over the wire. For embedded PGlite, point this at the pglite-socket sidecar
// (`bun run pglite:server`) on `postgresql://postgres@127.0.0.1:5432/postgres`.
// Generate migrations once against any Postgres-compatible target; the
// statements work against Neon and PGlite alike.
export default defineConfig({
  schema: "./packages/db/schemas/index.ts",
  out: "./packages/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
