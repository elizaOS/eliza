/**
 * Regression guard for the Server Tests fix (#16716): `@octokit/rest` must be
 * loaded lazily via `createRequire`, never through a static top-level ESM
 * import. A static `import { Octokit } from "@octokit/rest"` forces
 * symlink-preserving resolvers (vitest `preserveSymlinks: true`) to resolve
 * octokit's transitive graph (`@octokit/core`, `@octokit/request`, ...) eagerly
 * at module load, where the nested-in-plugin `@octokit/rest@22` store realpath
 * is not visible — collapsing the agent `proactive-interaction-pipeline` suite
 * at collection time. Node's `require` walks the realpath correctly, so the
 * loader is deferred to first use.
 *
 * This test stays at the source-contract boundary (no network, no spawned
 * agents, no credential relay): it asserts the shape of the two service files so
 * a future refactor cannot silently reintroduce the eager import that broke the
 * lane.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const servicesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "services",
);

const OCTOKIT_SERVICE_FILES = [
  "workspace-service.ts",
  "workspace-github.ts",
] as const;

// A value (non-type) top-level ESM import of @octokit/rest — the exact form the
// symlink-preserving resolver chokes on. `import type { ... }` is fine because
// it is erased before resolution, so the pattern deliberately excludes `type`.
const EAGER_OCTOKIT_IMPORT =
  /^\s*import\s+(?!type\b)[^;]*from\s+["']@octokit\/rest["']/m;

// The sanctioned lazy loader: createRequire(...)("@octokit/rest").
const LAZY_OCTOKIT_REQUIRE = /createRequire\([^)]*\)\(\s*["']@octokit\/rest["']/;

describe("octokit lazy-load contract (#16716)", () => {
  for (const file of OCTOKIT_SERVICE_FILES) {
    const source = readFileSync(join(servicesDir, file), "utf8");

    it(`${file} has no eager top-level @octokit/rest value import`, () => {
      expect(EAGER_OCTOKIT_IMPORT.test(source)).toBe(false);
    });

    it(`${file} loads @octokit/rest lazily via createRequire`, () => {
      expect(LAZY_OCTOKIT_REQUIRE.test(source)).toBe(true);
    });

    it(`${file} may keep a type-only @octokit/rest import`, () => {
      // Type-only imports are erased before resolution and are the intended way
      // to keep the Octokit type without triggering eager resolution.
      const typeImport =
        /import\s+type\s+\{[^}]*\}\s+from\s+["']@octokit\/rest["']/.test(source);
      // Not required, but if a value import is absent and the type is used, this
      // documents the intended replacement. Assert it does not co-exist with an
      // eager value import (already covered above) — here we just confirm the
      // file still references the Octokit type via a type import.
      expect(typeImport).toBe(true);
    });
  }
});
