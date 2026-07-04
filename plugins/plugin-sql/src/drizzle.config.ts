/** drizzle-kit config for generating standalone SQL migrations from the plugin-sql schema (not used by the runtime's own auto-migration path). */
import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: "../../.env" });

export default defineConfig({
  dialect: "postgresql",
  schema: "./schema/index.ts",
  out: "./drizzle/migrations",
  dbCredentials: {
    url: process.env.POSTGRES_URL || "file:../../.eliza/.elizadb",
  },
  breakpoints: true,
});
