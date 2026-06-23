const fs = require("node:fs");
const path = require("node:path");

// Load the root .env without depending on the (undeclared) `dotenv` package, so
// migrations work both locally (with a .env file) and in deploy environments
// where env vars come from the platform (Railway) and no .env file exists.
// Mirrors the loader in drizzle.config.ts. Existing process.env wins.
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = rawValue.replace(/^(['"])(.*)\1$/, "$2");
  }
}

loadEnvFile(path.resolve(__dirname, "../../.env"));

const isLocalDev =
  process.env.DEPLOYMENT_ENV === "localnet" ||
  process.env.NODE_ENV === "development" ||
  !process.env.DIRECT_DATABASE_URL;

const LOCAL_DATABASE_URL =
  "postgresql://feed:feed_dev_password@localhost:5433/feed";

// In non-local environments, require explicit database URL - never fall back to localhost
const databaseUrl = isLocalDev
  ? process.env.DATABASE_URL || LOCAL_DATABASE_URL
  : process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "Missing DIRECT_DATABASE_URL or DATABASE_URL in non-local environment. " +
      "Refusing to default to LOCAL_DATABASE_URL to prevent accidental migrations against wrong database.",
  );
}

/** @type {import('drizzle-kit').Config} */
module.exports = {
  // NOTE: Keep `schema`/`out` as relative paths.
  // Drizzle Kit currently mis-resolves absolute paths by prefixing them with `./`,
  // which breaks reading existing snapshots under `drizzle/migrations/meta/*`.
  // These scripts are run with `--cwd packages/db`, so relative paths are stable.
  // eliza.ts is listed separately — see drizzle.config.ts for the full explanation.
  schema: ["./src/schema/index.ts", "./src/schema/eliza.ts"],
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
  verbose: true,
  strict: true,
};
