/**
 * Deterministic fixture coverage for agent-console action scanning and
 * subaction inference.
 */
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepoActions } from "./action-scanner";

test("scanRepoActions discovers action metadata and subaction links", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "agent-console-scan-"));
  execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
  const fixtureDir = join(repoRoot, "packages", "fixture");
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(
    join(fixtureDir, "actions.ts"),
    `
      const childAction = {
        name: "lookup_weather",
        description: "Look up weather for a city",
        parameters: [
          {
            name: "city",
            description: "City to query",
            required: true,
            schema: { type: "string" },
          },
        ],
        validate: async () => true,
        handler: async () => undefined,
      };

      export const parentAction = {
        name: "travel_plan",
        description: "Plan a trip",
        parameters: [
          {
            name: "mode",
            description: "Operation to perform",
            schema: { type: "string", enum: ["lookup_weather"] },
          },
        ],
        subActions: ["lookup_weather"],
        validate: async (runtime) => Boolean(runtime),
        handler: async () => undefined,
      };
    `,
  );

  const result = scanRepoActions({ repoRoot });
  const parent = result.actions.find((action) => action.name === "travel_plan");
  const child = result.actions.find(
    (action) => action.name === "lookup_weather",
  );

  expect(result.filesScanned).toBe(1);
  expect(result.actionCount).toBe(2);
  expect(parent?.validation).toBe("conditional");
  expect(parent?.resolvedSubActions).toEqual([
    expect.objectContaining({
      found: true,
      name: "lookup_weather",
      targetId: child?.id,
    }),
  ]);
  expect(parent?.inferredSubActions).toEqual([
    {
      name: "lookup_weather",
      parameter: "mode",
      source: "parameter-enum",
    },
  ]);
  expect(child?.parameterSummary).toEqual(["city:string required"]);
});
