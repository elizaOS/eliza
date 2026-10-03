/** Removes stale package outputs so removed modules cannot survive publication. */
import { rm } from "node:fs/promises";

await rm(new URL("../dist/", import.meta.url), {
  recursive: true,
  force: true,
});
