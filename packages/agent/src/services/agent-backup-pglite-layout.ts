/**
 * File-set archives omit empty directories, but PostgreSQL requires its empty
 * layout directories. Derive them (and PG_VERSION) from this PGlite version.
 * Shared by the local restores and the manifest-v3 generation layout.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function readPgliteDirectoryLayout(): Promise<{
  pgVersion: Buffer;
  directories: string[];
}> {
  const { PGlite } = await import("@electric-sql/pglite");
  const template = await fs.mkdtemp(
    path.join(os.tmpdir(), "eliza-pglite-restore-layout-"),
  );
  try {
    const database = await PGlite.create(template);
    await database.close();
    const directories: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory()) continue;
        const absolute = path.join(directory, entry.name);
        directories.push(
          path.relative(template, absolute).split(path.sep).join("/"),
        );
        await visit(absolute);
      }
    };
    await visit(template);
    return {
      pgVersion: await fs.readFile(path.join(template, "PG_VERSION")),
      directories: directories.sort(),
    };
  } finally {
    await fs.rm(template, { recursive: true, force: true });
  }
}
