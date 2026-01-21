const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const isLocalDev =
  process.env.DEPLOYMENT_ENV === "localnet" ||
  process.env.NODE_ENV === "development" ||
  !process.env.DIRECT_DATABASE_URL;

const LOCAL_DATABASE_URL =
  "postgresql://polyagent:polyagent_dev_password@localhost:5433/polyagent";

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
  schema: path.resolve(__dirname, "./src/schema/index.ts"),
  out: path.resolve(__dirname, "./drizzle/migrations"),
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
  verbose: true,
  strict: true,
};
