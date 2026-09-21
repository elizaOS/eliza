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
  uses?: string;
};

const smokeBrowserInstallCommand =
  "PLAYWRIGHT_INSTALL_CWD=packages/app .github/scripts/install-playwright-browsers.sh chromium webkit";

// The e2e lane is split across two jobs: `smoke` shards the Playwright suite in
// packages/app, and `smoke_lanes` runs the tasks that cannot be sharded — one of
// which (@elizaos/ui#test:e2e) launches its own Chromium. Each job must install
// the engines it launches; a job that inherits none dies at browserType.launch.
const smokeLanesBrowserInstallCommand =
  "PLAYWRIGHT_INSTALL_CWD=packages/ui .github/scripts/install-playwright-browsers.sh chromium";

const smokeShardE2eCommand = "bun run --cwd packages/app test:e2e";
const smokeLanesE2eCommand =
  "bun run test:e2e --filter='^(?!.*packages/app\\)#test:e2e)'";

const zeroKeyCondition = undefined;
const smokeLanesCoreBuildCondition = undefined;
const liveSmokeCloudCondition =
  "inputs.suite == 'all' || inputs.suite == 'cloud'";
const liveSmokeCoreCondition =
  "inputs.suite == 'all' || inputs.suite == 'scenarios' || inputs.suite == 'group-chat' || inputs.suite == 'live-information' || inputs.suite == 'cloud'";

function assertJobBrowserBootstrap(
  steps: WorkflowStep[],
  { job, install, e2e }: { job: string; install: string; e2e: string },
): void {
  const installIndex = steps.findIndex((step) => step.run === install);
  const e2eIndex = steps.findIndex((step) => step.run === e2e);

  if (installIndex < 0) {
    throw new Error(`${job} must install the browser engines it launches`);
  }
  if (e2eIndex < 0) {
    throw new Error(`${job} must retain the deterministic E2E command`);
  }
  if (installIndex >= e2eIndex) {
    throw new Error(`${job} must install browsers before running E2E`);
  }
  if (
    steps[installIndex]?.if !== zeroKeyCondition ||
    steps[e2eIndex]?.if !== zeroKeyCondition
  ) {
    throw new Error(
      `${job} browser bootstrap and E2E must share the zero-key condition`,
    );
  }
}

function assertSmokeE2eBrowserBootstrap(source: string): void {
  const workflow = Bun.YAML.parse(source) as {
    jobs?: {
      smoke?: { steps?: WorkflowStep[] };
      smoke_lanes?: { steps?: WorkflowStep[] };
    };
  };

  assertJobBrowserBootstrap(workflow.jobs?.smoke?.steps ?? [], {
    job: "Smoke",
    install: smokeBrowserInstallCommand,
    e2e: smokeShardE2eCommand,
  });
  assertJobBrowserBootstrap(workflow.jobs?.smoke_lanes?.steps ?? [], {
    job: "Smoke lanes",
    install: smokeLanesBrowserInstallCommand,
    e2e: smokeLanesE2eCommand,
  });
}

function assertSmokeLanesCoreBootstrap(source: string): void {
  const workflow = Bun.YAML.parse(source) as {
    jobs?: { smoke_lanes?: { steps?: WorkflowStep[] } };
  };
  const steps = workflow.jobs?.smoke_lanes?.steps ?? [];
  const buildIndex = steps.findIndex(
    (step) =>
      step.name === "Build core contract" && step.run === "bun run build:core",
  );
  const e2eIndex = steps.findIndex((step) => step.run === smokeLanesE2eCommand);

  if (
    buildIndex < 0 ||
    steps[buildIndex]?.if !== smokeLanesCoreBuildCondition
  ) {
    throw new Error(
      "Smoke lanes must build the core contract for cloud and zero-key work",
    );
  }
  if (e2eIndex < 0 || buildIndex >= e2eIndex) {
    throw new Error("Smoke lanes must build the core contract before E2E");
  }
}

function assertLiveSmokeCloudCoreBootstrap(source: string): void {
  const workflow = Bun.YAML.parse(source) as {
    jobs?: { smoke?: { steps?: WorkflowStep[] } };
  };
  const steps = workflow.jobs?.smoke?.steps ?? [];
  const setupIndex = steps.findIndex(
    (step) => step.uses === "./.github/actions/setup-bun-workspace",
  );
  const buildIndex = steps.findIndex(
    (step) =>
      step.name === "Build core runtime contract" &&
      step.run === "bun run build:core",
  );
  const e2eIndex = steps.findIndex(
    (step) =>
      step.name === "Cloud end-to-end" && step.run === "bun run test:cloud:e2e",
  );

  if (setupIndex < 0 || buildIndex < 0 || e2eIndex < 0) {
    throw new Error(
      "Live Smoke must retain workspace setup, core build, and Cloud e2e steps",
    );
  }
  if (
    steps[buildIndex]?.if !== liveSmokeCoreCondition ||
    steps[e2eIndex]?.if !== liveSmokeCloudCondition
  ) {
    throw new Error(
      "Live Smoke core build and Cloud e2e must share the cloud-suite condition",
    );
  }
  if (!(setupIndex < buildIndex && buildIndex < e2eIndex)) {
    throw new Error(
      "Live Smoke must build the core edge contract before Cloud e2e",
    );
  }
}

function assertUiCoreFixtureCoreBootstrap(source: string): void {
  const workflow = Bun.YAML.parse(source) as {
    jobs?: { "ui-core-fixture-e2e"?: { steps?: WorkflowStep[] } };
  };
  const steps = workflow.jobs?.["ui-core-fixture-e2e"]?.steps ?? [];
  const setupIndex = steps.findIndex(
    (step) =>
      step.name === "Setup workspace dependencies" &&
      step.uses === "./.github/actions/setup-bun-workspace",
  );
  const buildIndex = steps.findIndex(
    (step) =>
      step.name === "Build core runtime contract" &&
      step.run === "bun run build:core",
  );
  const cloudFixtureIndex = steps.findIndex(
    (step) =>
      step.name === "Frontend hosting e2e" &&
      step.run === "bun run --cwd packages/ui test:frontend-hosting-e2e",
  );

  if (
    setupIndex < 0 ||
    buildIndex < 0 ||
    cloudFixtureIndex < 0
  ) {
    throw new Error(
      "UI core fixtures must retain setup, core build, and cloud E2E steps",
    );
  }
  if (
    !(
      setupIndex < buildIndex &&
      buildIndex < cloudFixtureIndex
    )
  ) {
    throw new Error(
      "UI core fixtures must generate data and build the edge contract before cloud E2E",
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

  test("assigns each UI fixture command to one partition", () => {
    const workflow = Bun.YAML.parse(
      readFileSync(join(githubRoot, "workflows", "ui-e2e-gate.yml"), "utf8"),
    ) as { jobs: Record<string, { steps: WorkflowStep[] }> };
    const commands = Object.values(workflow.jobs).flatMap((job) =>
      job.steps.flatMap((step) =>
        step.run?.includes("bun run --cwd packages/ui test:") ? [step.run] : [],
      ),
    );
    expect(commands.length).toBeGreaterThan(0);
    expect(new Set(commands).size).toBe(commands.length);
  });

  test("runs only declared packages/ui scripts from UI fixture workflows", () => {
    const scripts = JSON.parse(
      readFileSync(join(repoRoot, "packages", "ui", "package.json"), "utf8"),
    ).scripts as Record<string, string>;
    const workflows = ["ui-e2e-gate.yml"];
    const invocations = workflows.flatMap((workflow) =>
      [
        ...readFileSync(
          join(githubRoot, "workflows", workflow),
          "utf8",
        ).matchAll(
          /^\s*run:\s+(?:[A-Z_][A-Z0-9_]*=\S+\s+)*bun run --cwd packages\/ui ([^\s#]+)/gmu,
        ),
      ].map((match) => ({ script: match[1], workflow })),
    );

    expect(invocations.filter(({ script }) => !(script in scripts))).toEqual(
      [],
    );
  });

  test("builds core before extended UI fixtures bundle workspace exports", () => {
    const source = readFileSync(
      join(githubRoot, "workflows", "ui-e2e-gate.yml"),
      "utf8",
    );
    const workflow = Bun.YAML.parse(source) as {
      jobs?: { "fixture-e2e"?: { steps?: WorkflowStep[] } };
    };
    const steps = workflow.jobs?.["fixture-e2e"]?.steps ?? [];
    const buildIndex = steps.findIndex(
      (step) =>
        step.name === "Build core contract" &&
        step.run === "bun run build:core",
    );
    const walletIndex = steps.findIndex(
      (step) => step.run === "bun run --cwd packages/ui test:wallet-widget-e2e",
    );

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(walletIndex).toBeGreaterThan(buildIndex);
  });

  test("keeps the WebKit fixture lane on a provisionable hosted runner", () => {
    const source = readFileSync(
      join(githubRoot, "workflows", "ui-e2e-gate.yml"),
      "utf8",
    );

    expect(source).toMatch(/^\s{4}runs-on:\s*ubuntu-24\.04$/m);
    const parsed = Bun.YAML.parse(source) as {
      jobs: Record<string, { "runs-on": string }>;
    };
    expect(parsed.jobs["fixture-e2e"]["runs-on"]).toBe("ubuntu-24.04");
    expect(source).toContain(
      ".github/scripts/install-playwright-browsers.sh chromium webkit",
    );
  });

  test("keeps the chat WebKit lane on a provisionable hosted runner", () => {
    const source = readFileSync(
      join(githubRoot, "workflows", "ui-e2e-gate.yml"),
      "utf8",
    );

    expect(source).toMatch(/^\s{4}runs-on:\s*ubuntu-24\.04$/m);

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

    expect(source).toContain(
      "ELIZA_VAULT_PASSPHRASE: dev-smoke-headless-vault-only",
    );
    expect(source.match(/cache-bun-install: ["']false["']/g)).toHaveLength(2);
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
    ).toThrow("Smoke must install the browser engines it launches");

    expect(() =>
      assertSmokeE2eBrowserBootstrap(
        source.replace(
          smokeLanesBrowserInstallCommand,
          "echo lanes-browser-install-removed",
        ),
      ),
    ).toThrow("Smoke lanes must install the browser engines it launches");

    const afterE2e = moveStepToEnd(
      source,
      "smoke",
      "Install Playwright browsers",
    );
    expect(() => assertSmokeE2eBrowserBootstrap(afterE2e)).toThrow(
      "Smoke must install browsers before running E2E",
    );
  });

  test("builds workspace contracts before unshardable smoke E2E", () => {
    const source = readFileSync(
      join(githubRoot, "workflows", "ci.yml"),
      "utf8",
    );

    expect(() => assertSmokeLanesCoreBootstrap(source)).not.toThrow();
    expect(() =>
      assertSmokeLanesCoreBootstrap(
        moveStepToEnd(source, "smoke_lanes", "Build core contract"),
      ),
    ).toThrow("Smoke lanes must build the core contract before E2E");
  });

  test("builds the compiled core edge contract before Live Smoke cloud E2E", () => {
    const source = readFileSync(
      join(githubRoot, "workflows", "live-smoke.yml"),
      "utf8",
    );

    expect(() => assertLiveSmokeCloudCoreBootstrap(source)).not.toThrow();
    expect(() =>
      assertLiveSmokeCloudCoreBootstrap(
        source.replace(
          "run: bun run build:core",
          "run: echo core-build-removed",
        ),
      ),
    ).toThrow(
      "Live Smoke must retain workspace setup, core build, and Cloud e2e steps",
    );

    const afterE2e = moveStepToEnd(
      source,
      "smoke",
      "Build core runtime contract",
    );
    expect(() => assertLiveSmokeCloudCoreBootstrap(afterE2e)).toThrow(
      "Live Smoke must build the core edge contract before Cloud e2e",
    );
  });

  test("builds the compiled edge contract before cloud-backed UI fixtures", () => {
    const source = readFileSync(
      join(githubRoot, "workflows", "ui-e2e-gate.yml"),
      "utf8",
    );

    expect(() => assertUiCoreFixtureCoreBootstrap(source)).not.toThrow();
    expect(() =>
      assertUiCoreFixtureCoreBootstrap(
        source.replace(
          "run: bun run build:core",
          "run: echo core-build-removed",
        ),
      ),
    ).toThrow(
      "UI core fixtures must retain setup, core build, and cloud E2E steps",
    );

    const afterCloudFixture = moveStepToEnd(
      source,
      "ui-core-fixture-e2e",
      "Build core runtime contract",
    );
    expect(() => assertUiCoreFixtureCoreBootstrap(afterCloudFixture)).toThrow(
      "UI core fixtures must generate data and build the edge contract before cloud E2E",
    );
  });

  test("builds the consolidated frontend on a hosted runner", () => {
    const source = readFileSync(
      join(githubRoot, "workflows", "ci.yml"),
      "utf8",
    );
    const workflow = Bun.YAML.parse(source) as {
      jobs?: Record<string, { "runs-on"?: string; "timeout-minutes"?: number }>;
    };
    const job = workflow.jobs?.["frontend-build"];
    const formatGate = workflow.jobs?.quality;
    const staticGate = workflow.jobs?.quality;

    expect(job?.["runs-on"]).toBe("ubuntu-24.04");
    expect(job?.["timeout-minutes"]).toBeGreaterThanOrEqual(45);
    expect(formatGate?.["runs-on"]).toBe("ubuntu-24.04");
    expect(staticGate?.["runs-on"]).toBe("ubuntu-24.04");
    expect(staticGate?.["timeout-minutes"]).toBeGreaterThanOrEqual(15);
    expect(source).toContain("Build the only deployable frontend");
    expect(source).toContain("working-directory: packages/app");
    expect(source).not.toContain("PLAYWRIGHT_INSTALL_CWD=packages/homepage");
  });

  test("leaves the zero-key harness enough time after fleet setup", () => {
    const source = readFileSync(
      join(githubRoot, "workflows", "ci.yml"),
      "utf8",
    );
    const workflow = Bun.YAML.parse(source) as {
      jobs?: Record<string, { "timeout-minutes"?: number }>;
    };

    expect(
      workflow.jobs?.["zero-key-model-provider-e2e"]?.["timeout-minutes"],
    ).toBeGreaterThanOrEqual(30);
  });

  test("routes homepage deploys through the consolidated Cloudflare workflow", () => {
    // Develop Full calls Quality for homepage-source validation and the
    // consolidated build. The deployment workflow consumes that same app
    // artifact contract when the reconciler dispatches an exact SHA.
    const source = readFileSync(
      join(githubRoot, "workflows", "cloud-cf-deploy.yml"),
      "utf8",
    );
    const releaseSource = readFileSync(
      join(githubRoot, "workflows", "cloud-cf-release.yml"),
      "utf8",
    );
    const qualitySource = readFileSync(
      join(githubRoot, "workflows", "ci.yml"),
      "utf8",
    );
    expect(qualitySource).toContain("working-directory: packages/homepage");
    expect(qualitySource).toContain("Build the only deployable frontend");
    expect(source).toContain("uses: ./.github/workflows/cloud-cf-release.yml");
    expect(source).not.toContain("Build consolidated frontend artifact");
    expect(releaseSource).toContain("Build consolidated frontend artifact");
    expect(releaseSource).toContain("PAGES_PROJECT: eliza-app");
    for (const workflowSource of [source, releaseSource]) {
      expect(workflowSource).not.toContain("PAGES_PROJECT: eliza-app-home");
      expect(workflowSource).not.toContain("git push");
    }
  });
});
function moveStepToEnd(source: string, job: string, name: string): string {
  const workflow = Bun.YAML.parse(source) as {
    jobs: Record<string, { steps: WorkflowStep[] }>;
  };
  const steps = workflow.jobs[job].steps;
  const index = steps.findIndex((step) => step.name === name);
  if (index < 0) throw new Error(`Missing step ${name}`);
  const [step] = steps.splice(index, 1);
  steps.push(step);
  return JSON.stringify(workflow);
}
