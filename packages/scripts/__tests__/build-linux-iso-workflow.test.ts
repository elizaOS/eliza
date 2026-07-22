/**
 * Protects the scheduled Linux ISO workflow's supported-architecture and APT
 * snapshot preflight boundaries without invoking the multi-hour image build.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface WorkflowJob {
  strategy?: unknown;
  "continue-on-error"?: unknown;
  env?: Record<string, string>;
  steps?: WorkflowStep[];
}

const workflowSource = readFileSync(
  new URL("../../../.github/workflows/build-linux-iso.yml", import.meta.url),
  "utf8",
);
const workflow = Bun.YAML.parse(workflowSource) as {
  jobs?: Record<string, WorkflowJob>;
};
const buildJob = workflow.jobs?.["build-iso"];

if (!buildJob) {
  throw new Error("build-linux-iso.yml must define the build-iso job");
}

function step(name: string): WorkflowStep {
  const match = buildJob.steps?.find((candidate) => candidate.name === name);
  if (!match) {
    throw new Error(`Missing Linux ISO workflow step: ${name}`);
  }
  return match;
}

describe("Build elizaOS Linux ISO workflow", () => {
  test("publishes only the architecture supported by Tails live-build", () => {
    expect(buildJob.strategy).toBeUndefined();
    expect(buildJob["continue-on-error"]).toBeUndefined();
    expect(buildJob.env?.ELIZAOS_ARCH).toBe("amd64");
    expect(workflowSource).not.toContain("matrix.arch");
    expect(workflowSource).not.toContain("tonistiigi/binfmt");
    expect(workflowSource).not.toContain("build-iso (arm64)");
  });

  test("verifies an available snapshot map before static checks and build", () => {
    const names = buildJob.steps?.map((candidate) => candidate.name) ?? [];
    const preflightName = "Resolve available Tails APT snapshots";
    const preflight = step(preflightName);

    expect(preflight.run).toContain(
      `bun "\${LINUX_DIR}/scripts/resolve-apt-snapshots.mjs"`,
    );
    expect(preflight.run).toContain(
      `echo "APT_SNAPSHOTS_SERIALS=\${SNAPSHOTS}" >> "$GITHUB_ENV"`,
    );
    expect(names.indexOf(preflightName)).toBeLessThan(
      names.indexOf("Verify non-amd64 static contracts"),
    );
    expect(names.indexOf(preflightName)).toBeLessThan(
      names.indexOf("Build ISO (amd64)"),
    );
  });

  test("keeps backports rewriteable and propagates the verified map", () => {
    const backportsSource = readFileSync(
      new URL(
        "../../os/linux/tails/config/chroot_sources/trixie-backports.chroot",
        import.meta.url,
      ),
      "utf8",
    );
    const buildScript = readFileSync(
      new URL("../../os/linux/build.sh", import.meta.url),
      "utf8",
    );

    expect(backportsSource).toMatch(
      /^deb http:\/\/ftp\.us\.debian\.org\/debian trixie-backports /,
    );
    expect(buildScript).toContain(
      `-e "APT_SNAPSHOTS_SERIALS=\${APT_SNAPSHOTS_SERIALS:-}"`,
    );
  });
});
