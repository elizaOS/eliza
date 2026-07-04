/**
 * Installs Postgres extensions (e.g. `vector`, `fuzzystrmatch`) required by
 * plugin schemas. Extension names are allowlist-validated before being
 * interpolated as an SQL identifier, since `CREATE EXTENSION` doesn't support
 * parameterized identifiers. A failed or unavailable extension only logs a
 * warning — it doesn't abort the migration, since not every deployment target
 * has every optional extension available.
 */
import { logger } from "@elizaos/core";
import { sql } from "drizzle-orm";
import type { DrizzleDB } from "./types";

export class ExtensionManager {
  constructor(private db: DrizzleDB) {}

  async installRequiredExtensions(extensions: string[]): Promise<void> {
    for (const extension of extensions) {
      try {
        if (!/^[a-zA-Z0-9_-]+$/.test(extension)) {
          logger.warn(
            { src: "plugin:sql", extension },
            "Invalid extension name - contains invalid characters"
          );
          continue;
        }

        await this.db.execute(sql`CREATE EXTENSION IF NOT EXISTS ${sql.identifier(extension)}`);
        logger.debug({ src: "plugin:sql", extension }, "Extension installed");
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(
          { src: "plugin:sql", extension, error: errorMessage },
          "Could not install extension"
        );
      }
    }
  }
}
