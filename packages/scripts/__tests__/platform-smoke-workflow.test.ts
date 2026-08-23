/** Verifies the platform smoke workflow remains callable and manually dispatchable without automatic authority. */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflow = Bun.YAML.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../.github/workflows/platform-smoke.yml", import.meta.url),
    ),
    "utf8",
  ),
) as {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      strategy?: { matrix?: { os?: string[] } };
      "runs-on"?: string;
    }
  >;
};

test("platform smoke exposes only callable and explicit manual triggers", () => {
  expect(Object.keys(workflow.on ?? {}).sort()).toEqual([
    "workflow_call",
    "workflow_dispatch",
  ]);
  expect(workflow.permissions).toEqual({ contents: "read" });
});

test("manual evidence retains both hosted platform cells", () => {
  const job = workflow.jobs?.["platform-smoke"];
  expect(job?.strategy?.matrix?.os).toEqual(["macos-15", "windows-2025"]);
  expect(job?.["runs-on"]).toBe("${{ matrix.os }}");
});
