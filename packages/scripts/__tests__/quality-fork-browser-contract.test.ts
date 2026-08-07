/**
 * Guards fork-safe homepage browser CI and its reviewed visual-diff ceilings.
 */
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { runContract } = await import(
  new URL("../quality-fork-browser-contract.mjs", import.meta.url).href
);

const REAL_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const NUMBER_LITERAL = String.raw`(0(?:\.\d+)?)`;
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
        run: bun run test:e2e --workers=1

      - name: Upload homepage browser failure artifacts
        if: failure() && steps.homepage-scope.outputs.run == 'true'
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
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

  test("rejects parallelizing the software-WebGL browser lane", () => {
    const root = buildRepo(
      VALID_WORKFLOW.replace("--workers=1", "--workers=2"),
    );
    try {
      expect(() => runContract(root)).toThrow(/exactly one worker/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an unreviewed browser artifact uploader", () => {
    const root = buildRepo(
      VALID_WORKFLOW.replace(
        "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
        "actions-upload-artifact-floating-tag",
      ),
    );
    try {
      expect(() => runContract(root)).toThrow(
        /reviewed upload-artifact revision/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects browser artifact upload outside the failure boundary", () => {
    const root = buildRepo(
      VALID_WORKFLOW.replace(
        "failure() && steps.homepage-scope.outputs.run == 'true'",
        "always()",
      ),
    );
    try {
      expect(() => runContract(root)).toThrow(/only after an in-scope failure/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps visual diff tolerances within reviewed renderer ceilings", () => {
    const config = readFileSync(
      join(REAL_REPO_ROOT, "packages", "homepage", "playwright.config.ts"),
      "utf8",
    );
    const visual = readFileSync(
      join(
        REAL_REPO_ROOT,
        "packages",
        "homepage",
        "tests",
        "e2e",
        "visual.spec.ts",
      ),
      "utf8",
    );
    const configMatch = config.match(
      new RegExp(`maxDiffPixelRatio:\\s*${NUMBER_LITERAL}`),
    );
    if (!configMatch) {
      throw new Error("Homepage Playwright config must set maxDiffPixelRatio");
    }

    const globalTolerance = Number(configMatch[1]);
    expect(globalTolerance).toBeLessThanOrEqual(0.05);

    const viewportMatch = visual.match(
      new RegExp(
        `maxDiffPixelRatio:\\s*viewport\\.name === ["']mobile["']\\s*\\?\\s*${NUMBER_LITERAL}\\s*:\\s*${NUMBER_LITERAL}`,
      ),
    );
    if (viewportMatch) {
      expect(Number(viewportMatch[1])).toBeLessThanOrEqual(0.08);
      expect(Number(viewportMatch[2])).toBeLessThanOrEqual(globalTolerance);
      return;
    }

    const uniformMatch = visual.match(
      new RegExp(`maxDiffPixelRatio:\\s*${NUMBER_LITERAL}`),
    );
    if (!uniformMatch) {
      throw new Error("Homepage visual suite must set maxDiffPixelRatio");
    }
    expect(Number(uniformMatch[1])).toBeLessThanOrEqual(globalTolerance);
  });

  test("the checked-in Quality (Fork) workflow satisfies the contract", () => {
    expect(runContract(REAL_REPO_ROOT)).toEqual({
      workflow: ".github/workflows/quality-fork.yml",
    });
  });
});
