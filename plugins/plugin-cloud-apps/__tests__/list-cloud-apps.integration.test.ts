/**
 * Runs LIST_CLOUD_APPS in an isolated process through the real Cloud SDK and a
 * loopback HTTP boundary so the unit suite's SDK module replacement cannot
 * conceal the integration path.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Spawning a second runtime to transpile and boot the fixture routinely costs
// more than bun's 5s default, which failed the suite as a timeout rather than
// as a real defect.
const FIXTURE_TIMEOUT_MS = 60_000;

describe("LIST_CLOUD_APPS integration", () => {
  it(
    "propagates delivery failure after one real SDK request and one callback",
    () => {
      const fixturePath = fileURLToPath(
        new URL(
          "../test/fixtures/list-cloud-apps-callback-boundary.ts",
          import.meta.url,
        ),
      );
      const result = spawnSync(process.execPath, [fixturePath], {
        encoding: "utf8",
        env: process.env,
      });
      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout) as {
        requests: Array<{
          path: string;
          authorization: string | null;
          apiKey: string | null;
        }>;
        delivered: string[];
      };
      expect(evidence.requests).toEqual([
        {
          path: "/api/v1/apps",
          authorization: "Bearer eliza_loopback_key",
          apiKey: "eliza_loopback_key",
        },
      ]);
      expect(evidence.delivered).toHaveLength(1);
      expect(evidence.delivered[0]).toContain("Delivered Once");
      expect(evidence.delivered[0]).not.toContain(
        "Cloud API returned an error",
      );
    },
    FIXTURE_TIMEOUT_MS,
  );
});
