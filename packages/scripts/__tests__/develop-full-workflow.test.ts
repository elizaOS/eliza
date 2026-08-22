/** Verifies the sole develop-push workflow delegates and aggregates every read-only validation family. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(
  new URL("../../../.github/workflows/develop-full.yml", import.meta.url),
);
const workflow = Bun.YAML.parse(readFileSync(workflowPath, "utf8")) as {
  on?: Record<string, { branches?: string[] }>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      uses?: string;
      needs?: string[];
      if?: string;
      permissions?: Record<string, string>;
      secrets?: string;
    }
  >;
};

const delegatedJobs = [
  "canonical",
  "chat-shell",
  "cloud-gateway-discord",
  "cloud",
  "dev-smoke",
  "docker",
  "secrets",
  "quality",
  "platform-smoke",
  "scenarios",
  "tests",
  "ui-core",
  "ui-extended",
  "ui-stories",
];

describe("Develop Full workflow authority", () => {
  test("is the latest-tip develop-push authority", () => {
    expect(workflow.on).toEqual({ push: { branches: ["develop"] } });
    expect(workflow.concurrency).toEqual({
      group: "develop-full",
      "cancel-in-progress": true,
    });
  });

  test("delegates the complete read-only validation graph", () => {
    expect(Object.keys(workflow.jobs ?? {}).sort()).toEqual(
      [...delegatedJobs, "complete"].sort(),
    );
    for (const name of delegatedJobs) {
      const job = workflow.jobs?.[name];
      expect(job?.uses).toMatch(/^\.\/\.github\/workflows\/.+\.yml$/);
      expect(job?.secrets).toBe("inherit");
      expect(job?.permissions).toBeUndefined();
    }
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  test("fails closed unless every delegated family succeeds", () => {
    const complete = workflow.jobs?.complete;
    expect(complete?.if).toBe(`\${{ !cancelled() }}`);
    expect(complete?.needs).toEqual(delegatedJobs);
  });
});
