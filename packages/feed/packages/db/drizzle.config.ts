import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load root .env file
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// Determine if we're in local development mode
const isLocalDev =
  process.env.DEPLOYMENT_ENV === "localnet" ||
  process.env.NODE_ENV === "development" ||
  !process.env.DIRECT_DATABASE_URL;

// Local development database URL (matches docker-compose setup)
const LOCAL_DATABASE_URL =
  "postgresql://feed:feed_dev_password@localhost:5433/feed";

// Use local URL for development, production URL only when explicitly set
const databaseUrl = isLocalDev
  ? (process.env.DATABASE_URL ?? LOCAL_DATABASE_URL)
  : (process.env.DIRECT_DATABASE_URL ??
    process.env.DATABASE_URL ??
    LOCAL_DATABASE_URL);

export default defineConfig({
  // NOTE: Keep `schema`/`out` as relative paths.
  // Drizzle Kit currently mis-resolves absolute paths by prefixing them with `./`,
  // which breaks reading existing snapshots under `drizzle/migrations/meta/*`.
  // These scripts are run with `--cwd packages/db`, so relative paths are stable.
  //
  // eliza.ts is listed separately rather than re-exported through index.ts.
  // Keeping it out of the index.ts barrel prevents @elizaos/plugin-sql from being
  // traced into every Lambda that imports @feed/db (would exceed Vercel 250 MB limit).
  schema: ["./src/schema/index.ts", "./src/schema/eliza.ts"],
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
  verbose: true,
  strict: true,
});
