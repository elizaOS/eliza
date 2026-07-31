import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);

interface WorkflowTrigger {
  branches?: string[];
  paths?: string[];
  inputs?: Record<string, unknown>;
}

interface WorkflowJob {
  if?: string;
}

interface Workflow {
  on?: Record<string, WorkflowTrigger>;
  jobs?: Record<string, WorkflowJob>;
}

function readWorkflowSource(name: string): string {
  return readFileSync(new URL(`.github/workflows/${name}`, repoRoot), "utf8");
}

function readWorkflow(name: string): Workflow {
  return Bun.YAML.parse(readWorkflowSource(name)) as Workflow;
}

const canonicalSource = readWorkflowSource("cloud-cf-deploy.yml");
const canonical = readWorkflow("cloud-cf-deploy.yml");
const legacy = readWorkflow("cloud-deploy-backend.yml");

describe("Cloud deployment workflow trigger contract", () => {
  test("canonical push and pull-request deploys cover app-core changes", () => {
    const push = canonical.on?.push;
    const pullRequest = canonical.on?.pull_request;

    expect(push?.branches).toEqual(["main", "develop"]);
    expect(pullRequest?.branches).toEqual(["main", "develop"]);
    expect(push?.paths).toContain("packages/app/**");
    expect(push?.paths).toContain("packages/app-core/**");
    expect(pullRequest?.paths).toContain("packages/app/**");
    expect(pullRequest?.paths).toContain("packages/app-core/**");
  });

  test("publishes Deepgram credentials and the environment-scoped batch STT toggle", () => {
    expect(canonicalSource).toContain(
      "DEEPGRAM_API_KEY: $" + "{{ secrets.DEEPGRAM_API_KEY }}",
    );
    expect(canonicalSource).toContain(
      "VOICE_BATCH_STT_PROVIDER: $" + "{{ vars.VOICE_BATCH_STT_PROVIDER }}",
    );
    expect(canonicalSource).toContain("            DEEPGRAM_API_KEY \\");
    expect(canonicalSource).toContain("            VOICE_BATCH_STT_PROVIDER");
  });

  test("legacy backend deploys are manual-only and retain migration/VPS controls", () => {
    expect(Object.keys(legacy.on ?? {}).sort()).toEqual(["workflow_dispatch"]);

    const dispatch = legacy.on?.workflow_dispatch;
    expect(dispatch?.inputs).toHaveProperty("environment");
    expect(dispatch?.inputs).toHaveProperty("deploy_legacy_vps");
    expect(legacy.jobs).toHaveProperty("migrate-db");
    expect(legacy.jobs).toHaveProperty("deploy");
    expect(legacy.jobs?.deploy?.if).toContain("inputs.deploy_legacy_vps");
  });
});
