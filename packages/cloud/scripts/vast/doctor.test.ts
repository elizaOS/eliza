/**
 * Runs the credential-free Vast deployment doctor against the canonical
 * manifests and startup scripts in their monorepo locations.
 */

import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../../../scripts/lib/spawn-sync-captured.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("Vast deployment contract is internally consistent", () => {
  const result = spawnSync("bun", [join(here, "doctor.ts")], {
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("[vast:doctor] ok (4 manifests)");
});
