/** Verifies PR admission combines affected static checks with Windows browser-bridge security. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const source = readFileSync(
  join(repoRoot, ".github/workflows/pr-static-smoke.yml"),
  "utf8",
);
const workflow = Bun.YAML.parse(source) as {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<
    string,
    {
      name?: string;
      uses?: string;
      needs?: string[];
      steps?: Array<{ run?: string }>;
    }
  >;
};

describe("PR Static Smoke workflow", () => {
  test("owns cancelable source and Windows lanes behind the stable admission context", () => {
    expect(workflow.concurrency?.group).toContain(
      "github.event.pull_request.number",
    );
    expect(workflow.concurrency?.["cancel-in-progress"]).toBeTrue();
    expect(Object.keys(workflow.jobs ?? {})).toEqual([
      "source-smoke",
      "browser-bridge-windows-security",
      "static-smoke",
    ]);
    expect(workflow.jobs?.["browser-bridge-windows-security"]?.uses).toBe(
      "./.github/workflows/browser-bridge-windows-security.yml",
    );
    expect(workflow.jobs?.["static-smoke"]?.needs).toEqual([
      "source-smoke",
      "browser-bridge-windows-security",
    ]);
    expect(workflow.jobs?.["static-smoke"]?.name).toBe("All Tests Passed");
  });

  test("fails closed over mergeability, secrets, workflows, and affected static checks", () => {
    const commands = (workflow.jobs?.["source-smoke"]?.steps ?? [])
      .map((step) => step.run ?? "")
      .join("\n");
    expect(commands).toContain("git merge-tree --write-tree");
    expect(commands).toContain("git diff --check");
    expect(commands).toContain("gitleaks detect");
    expect(commands).toContain("actionlint");
    expect(commands).toContain("bun run build:core");
    expect(commands).toContain("run lint:check --concurrency=4 --affected");
    expect(commands).toContain("run typecheck --concurrency=4 --affected");
    expect(commands).toContain("run build --concurrency=4 --affected");
  });

  test("does not acquire effect credentials or run heavy qualification", () => {
    expect(source).not.toMatch(/\bsecrets\.[A-Z0-9_]+/);
    expect(source).not.toContain("test:e2e");
    expect(source).not.toContain("test:server");
    expect(source).not.toContain("test:client");
    expect(source).not.toContain("test:plugins");
    expect(source).not.toContain("environment:");
    expect(source).not.toContain("self-hosted");
  });
});
