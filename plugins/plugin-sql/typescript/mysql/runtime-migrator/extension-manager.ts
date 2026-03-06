import { logger } from "@elizaos/core";
import type { DrizzleDB } from "./types";

/**
 * MySQL does not have a PostgreSQL-style extension system (CREATE EXTENSION).
 * This is a no-op manager that logs the requested "extensions" but takes no action.
 * MySQL's vector support is built into MySQL 9.x natively.
 */
export class ExtensionManager {
  constructor(private _db: DrizzleDB) {}

  async installRequiredExtensions(extensions: string[]): Promise<void> {
    if (extensions.length > 0) {
      logger.debug(
        { src: "plugin:mysql", extensions },
        "MySQL does not use PostgreSQL-style extensions, skipping installation"
      );
    }
  }
}
