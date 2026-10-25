/** Copies the immutable database migrations required by the published login runtime. */
import { cp } from "node:fs/promises";

const root = new URL("../", import.meta.url);
await cp(
  new URL("src/server/db/drizzle/", root),
  new URL("dist/server/db/drizzle/", root),
  { recursive: true },
);
