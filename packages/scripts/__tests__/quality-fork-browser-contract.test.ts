import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { runContract } = await import(
  new URL("../quality-fork-browser-contract.mjs", import.meta.url).href
);

const REAL_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const VALID_WORKFLOW = `name: Quality (Fork)
jobs:
  build:
    runs-on: [self-hosted, hetzner-robot]
    steps:
      - name: Install homepage browser
        working-directory: packages/homepage
        run: ./node_modules/.bin/playwright install chromium

      - name: Test homepage downloads
        working-directory: packages/homepage
        run: bun run test:e2e
`;

function buildRepo(workflow = VALID_WORKFLOW) {
  const root = mkdtempSync(join(tmpdir(), "quality-fork-browser-contract-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(root, ".github", "workflows", "quality-fork.yml"),
    workflow,
  );
  return root;
}

describe("quality-fork-browser-contract", () => {
  test("accepts unprivileged Chromium install followed by the real browser test", () => {
    const root = buildRepo();
    try {
      expect(runContract(root)).toEqual({
        workflow: ".github/workflows/quality-fork.yml",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects Playwright dependency installation that invokes sudo", () => {
    const root = buildRepo(
      VALID_WORKFLOW.replace(
        "install chromium",
        "install --with-deps chromium",
      ),
    );
    try {
      expect(() => runContract(root)).toThrow(/without privileged dependency/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects removal of the real homepage browser test", () => {
    const root = buildRepo(
      VALID_WORKFLOW.replace("bun run test:e2e", "echo browser-test-skipped"),
    );
    try {
      expect(() => runContract(root)).toThrow(
        /real homepage browser test must remain enabled/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the checked-in Quality (Fork) workflow satisfies the contract", () => {
    expect(runContract(REAL_REPO_ROOT)).toEqual({
      workflow: ".github/workflows/quality-fork.yml",
    });
  });
});
