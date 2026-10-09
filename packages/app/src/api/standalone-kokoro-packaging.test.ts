/**
 * The standalone Kokoro host loads two modules from
 * @elizaos/plugin-local-inference at runtime: the speech worker it spawns and
 * the TTS route module it imports. A packaged build has only the plugin's
 * `dist`, so each subpath it uses must be an explicit package export or one of
 * the plugin's build entrypoints; a source-only path breaks speech there.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const plugin = new URL(
  "../../../../plugins/plugin-local-inference/",
  import.meta.url,
);
const exportsMap = JSON.parse(
  readFileSync(new URL("package.json", plugin), "utf8"),
).exports as Record<string, unknown>;
const buildEntrypoints = new Set(
  [
    ...readFileSync(new URL("build.ts", plugin), "utf8").matchAll(
      /"\.\/src\/([^"]+)\.ts"/g,
    ),
  ].map((match) => match[1]),
);

function usedSubpaths(file: string): string[] {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  return [
    ...source.matchAll(/["']@elizaos\/plugin-local-inference\/([^"']+)["']/g),
  ].map((match) => match[1]);
}

describe("standalone Kokoro packaging", () => {
  it.each(["./standalone-kokoro-service.ts", "./standalone-kokoro-routes.ts"])(
    "%s loads only subpaths a packaged plugin ships",
    (file) => {
      const subpaths = usedSubpaths(file);
      expect(subpaths.length).toBeGreaterThan(0);
      const unshipped = subpaths.filter(
        (subpath) =>
          !(`./${subpath}` in exportsMap) &&
          !buildEntrypoints.has(subpath) &&
          !buildEntrypoints.has(`${subpath}/index`),
      );
      expect(unshipped).toEqual([]);
    },
  );
});
