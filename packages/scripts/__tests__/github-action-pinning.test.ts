/**
 * Keeps the repository's workflow and composite-action graph immutable,
 * uniquely named, referenced, and free of duplicate UI fixture ownership.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const githubRoot = join(repoRoot, ".github");

type WorkflowStep = {
  if?: string;
  name?: string;
  run?: string;
};

const smokeBrowserInstallCommand =
  "PLAYWRIGHT_INSTALL_CWD=packages/app .github/scripts/install-playwright-browsers.sh chromium webkit";

function assertSmokeE2eBrowserBootstrap(source: string): void {
  const workflow = Bun.YAML.parse(source) as {
    jobs?: { smoke?: { steps?: WorkflowStep[] } };
  };
  const steps = workflow.jobs?.smoke?.steps ?? [];
  const installIndex = steps.findIndex(
    (step) => step.run === smokeBrowserInstallCommand,
  );
  const e2eIndex = steps.findIndex((step) => step.run === "bun run test:e2e");

  if (installIndex < 0) {
    throw new Error("Smoke must install Chromium and WebKit before E2E");
  }
  if (e2eIndex < 0) {
    throw new Error("Smoke must retain the deterministic E2E command");
  }
  if (installIndex >= e2eIndex) {
    throw new Error("Smoke must install browsers before running E2E");
  }

  const zeroKeyCondition = "needs.changes.outputs.zero_key == 'true'";
  if (
    steps[installIndex]?.if !== zeroKeyCondition ||
    steps[e2eIndex]?.if !== zeroKeyCondition
  ) {
    throw new Error(
      "Smoke browser bootstrap and E2E must share the zero-key condition",
    );
  }
}

function collectYamlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectYamlFiles(path);
    return /\.ya?ml$/u.test(entry.name) ? [path] : [];
  });
}

describe("GitHub action supply-chain references", () => {
  test("pins every external action and reusable workflow to a commit SHA", () => {
    const mutableReferences: string[] = [];

    for (const file of collectYamlFiles(githubRoot)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /^\s*(?:-\s*)?uses:\s+(\S+)\s*$/gmu,
      )) {
        const reference = match[1];
        if (reference.startsWith("./") || reference.startsWith("docker://")) {
          continue;
        }
        if (!/^[^@\s]+@[0-9a-f]{40}$/u.test(reference)) {
          mutableReferences.push(`${relative(repoRoot, file)} -> ${reference}`);
        }
      }
    }

    expect(mutableReferences).toEqual([]);
  });

  test("keeps workflow display names unique", () => {
    const names = new Map<string, string[]>();
    for (const file of collectYamlFiles(join(githubRoot, "workflows"))) {
      const workflow = Bun.YAML.parse(readFileSync(file, "utf8")) as {
        name?: string;
      };
      const name = workflow.name ?? "";
      names.set(name, [...(names.get(name) ?? []), relative(repoRoot, file)]);
    }

    expect(
      [...names.entries()].filter(([name, files]) => !name || files.length > 1),
    ).toEqual([]);
  });

  test("does not retain orphaned local composite actions", () => {
    const yamlFiles = collectYamlFiles(githubRoot);
    const graph = yamlFiles
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const orphaned = yamlFiles
      .filter((file) => /^action\.ya?ml$/u.test(file.split("/").at(-1) ?? ""))
      .map((file) => `./${relative(repoRoot, dirname(file))}`)
      .filter((reference) => !graph.includes(`uses: ${reference}`));

    expect(orphaned).toEqual([]);
  });

  test("assigns each UI fixture suite to one parallel workflow", () => {
    const suites = (name: string) =>
      new Set(
        [
          ...readFileSync(join(githubRoot, "workflows", name), "utf8").matchAll(
            /^\s*run:\s+(?:[A-Z_][A-Z0-9_]*=\S+\s+)*bun run --cwd packages\/ui (test:[^\s#]+)/gmu,
          ),
        ].map((match) => match[1]),
      );
    const core = suites("ui-e2e-gate.yml");
    const extended = suites("ui-fixture-e2e.yml");

    expect([...core].filter((suite) => extended.has(suite))).toEqual([]);
  });

  test("keeps the WebKit fixture lane on a provisionable hosted runner", () => {
    const source = readFileSync(
      join(githubRoot, "workflows", "ui-fixture-e2e.yml"),
      "utf8",
    );

    expect(source).toMatch(/^\s{4}runs-on:\s*ubuntu-24\.04$/m);
    expect(source).not.toContain("hetzner-robot");
    expect(source).toContain(
      ".github/scripts/install-playwright-browsers.sh chromium webkit",
    );
  });

  test("keeps the chat WebKit lane on a provisionable hosted runner", () => {
    const source = readFileSync(
      join(githubRoot, "workflows", "chat-shell-gestures.yml"),
      "utf8",
    );

    expect(source).toMatch(/^\s{4}runs-on:\s*ubuntu-24\.04$/m);
    expect(source).not.toContain("hetzner-robot");
    expect(source).toContain(
      ".github/scripts/install-playwright-browsers.sh chromium webkit",
    );
  });

  test("installs dev-smoke Chromium without requiring self-hosted sudo", () => {
    const source = readFileSync(
      join(githubRoot, "workflows", "dev-smoke.yml"),
      "utf8",
    );

    expect(
      source.match(
        /\.github\/scripts\/install-playwright-browsers\.sh chromium/g,
      ),
    ).toHaveLength(2);
    expect(source).not.toContain("playwright install --with-deps chromium");
    expect(source).toContain(
      "ELIZA_VAULT_PASSPHRASE: dev-smoke-headless-vault-only",
    );
  });

  test("installs both app browser engines before deterministic smoke E2E", () => {
    const source = readFileSync(
      join(githubRoot, "workflows", "ci.yml"),
      "utf8",
    );

    expect(() => assertSmokeE2eBrowserBootstrap(source)).not.toThrow();
    expect(() =>
      assertSmokeE2eBrowserBootstrap(
        source.replace(
          smokeBrowserInstallCommand,
          "echo browser-install-removed",
        ),
      ),
    ).toThrow("Smoke must install Chromium and WebKit before E2E");

    const installStep = `      - name: Install Playwright browsers
        if: needs.changes.outputs.zero_key == 'true'
        run: ${smokeBrowserInstallCommand}

`;
    const afterE2e = source
      .replace(installStep, "")
      .replace(
        "        run: bun run test:e2e\n",
        (command) => `${command}\n${installStep}`,
      );
    expect(() => assertSmokeE2eBrowserBootstrap(afterE2e)).toThrow(
      "Smoke must install browsers before running E2E",
    );
  });

  test("provisions homepage Chromium without requiring self-hosted sudo", () => {
    const source = readFileSync(
      join(githubRoot, "workflows", "quality.yml"),
      "utf8",
    );
    const workflow = Bun.YAML.parse(source) as {
      jobs?: Record<string, { "runs-on"?: string; "timeout-minutes"?: number }>;
    };
    const job = workflow.jobs?.["homepage-build"];
    const formatGate = workflow.jobs?.["format-check"];
    const staticGate = workflow.jobs?.["develop-static-gate"];

    expect(job?.["runs-on"]).toBe("ubuntu-24.04");
    expect(job?.["timeout-minutes"]).toBeGreaterThanOrEqual(45);
    expect(formatGate?.["runs-on"]).toBe("ubuntu-24.04");
    expect(staticGate?.["runs-on"]).toBe("ubuntu-24.04");
    expect(staticGate?.["timeout-minutes"]).toBeGreaterThanOrEqual(15);
    expect(source).toContain(
      "PLAYWRIGHT_INSTALL_CWD=packages/homepage .github/scripts/install-playwright-browsers.sh chromium",
    );
    expect(source).not.toContain("playwright install --with-deps chromium");
  });

  test("keeps production homepage deploys read-only and fully gated", () => {
    const source = readFileSync(
      join(githubRoot, "workflows", "deploy-homepage.yml"),
      "utf8",
    );
    const workflow = Bun.YAML.parse(source) as {
      permissions?: { contents?: string };
    };

    expect(workflow.permissions?.contents).toBe("read");
    expect(source).toContain("bun run test");
    expect(source).toContain("bun run typecheck");
    expect(source).toContain("bun run lint:check");
    expect(source).toContain("bun run check:snapshot-inventory");
    expect(source).toContain("bun run test:e2e");
    expect(source).toContain(
      "PLAYWRIGHT_INSTALL_CWD=packages/homepage .github/scripts/install-playwright-browsers.sh chromium",
    );
    expect(source).not.toContain("playwright install --with-deps chromium");
    expect(source).not.toContain("--update-snapshots");
    expect(source).not.toContain("git push");
    expect(source).not.toContain("continue-on-error");

    const e2e = source.indexOf("bun run test:e2e");
    const deploy = source.indexOf("wrangler@4.116.0 pages deploy dist");
    expect(e2e).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(e2e);
  });

  test("keeps the Docker smoke on a runner with a Docker daemon", () => {
    const source = readFileSync(
      join(githubRoot, "workflows", "docker-ci-smoke.yml"),
      "utf8",
    );
    const workflow = Bun.YAML.parse(source) as {
      jobs?: Record<string, { "runs-on"?: string }>;
    };
    const classifier = workflow.jobs?.changes;
    const job = workflow.jobs?.["docker-ci-smoke"];

    expect(classifier?.["runs-on"]).toBe("ubuntu-24.04");
    expect(job?.["runs-on"]).toBe("ubuntu-24.04");
  });
});
