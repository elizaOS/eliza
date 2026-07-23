/**
 * Locks issue #16997's manual plugin trajectory to a trusted exact-head
 * dispatch. The contract executes the preflight under hostile contexts and
 * proves provider credentials reach only their reviewed live-model steps.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);
const workflowSource = readFileSync(
  new URL(".github/workflows/cerebras-chat-flow-live.yml", repoRoot),
  "utf8"
);

type WorkflowStep = {
  name?: string;
  uses?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  if?: string;
  env?: Record<string, string>;
  steps?: WorkflowStep[];
};

type Workflow = {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<
        string,
        {
          default?: string;
          options?: string[];
          required?: boolean;
          type?: string;
        }
      >;
    };
  };
  permissions?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
};

const workflow = Bun.YAML.parse(workflowSource) as Workflow;
const runtimeJob = workflow.jobs?.live;
const evidenceJob = workflow.jobs?.["plugin-toolcall-stream-evidence"];
const cerebrasSecret = "$" + "{{ secrets.CEREBRAS_API_KEY }}";
const cloudSecret = "$" + "{{ secrets.ELIZACLOUD_API_KEY }}";
const exactSha = "0123456789abcdef0123456789abcdef01234567";

function namedStep(job: WorkflowJob | undefined, name: string): WorkflowStep {
  const step = job?.steps?.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing Cerebras workflow step: ${name}`);
  return step;
}

function runExactHeadGuard(overrides: Record<string, string> = {}) {
  const run = namedStep(evidenceJob, "Bind trusted exact-head dispatch").run;
  if (!run) throw new Error("Exact-head binding step has no shell contract");
  return spawnSync("bash", ["-c", run], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REPOSITORY: "elizaOS/eliza",
      GITHUB_ACTOR: "lalalune",
      GITHUB_REF: "refs/heads/fix/16997-stream-tool-call-arguments",
      GITHUB_SHA: exactSha,
      REQUESTED_MODE: "plugin-toolcall-stream-evidence",
      REQUESTED_SHA: exactSha,
      ...overrides,
    },
  });
}

function stepsWithSecret(job: WorkflowJob | undefined, secret: string): string[] {
  return (job?.steps ?? [])
    .filter((step) => Object.values(step.env ?? {}).includes(secret))
    .map((step) => step.name ?? "<unnamed>");
}

describe("Eliza Cloud plugin tool-call stream workflow (#16997)", () => {
  test("admits only the issue branch's trusted exact-head dispatch", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.on?.workflow_dispatch?.inputs?.mode?.options).toEqual([
      "chat-flow",
      "plugin-toolcall-stream-evidence",
    ]);
    expect(workflow.on?.workflow_dispatch?.inputs?.expected_sha).toEqual(
      expect.objectContaining({
        default: "",
        required: false,
        type: "string",
      })
    );

    const guard = evidenceJob?.if?.replace(/\s+/g, " ");
    expect(guard).toContain("github.event_name == 'workflow_dispatch'");
    expect(guard).toContain("inputs.mode == 'plugin-toolcall-stream-evidence'");
    expect(guard).toContain("github.repository == 'elizaOS/eliza'");
    expect(guard).toContain("github.actor == 'lalalune'");
    expect(guard).toContain(
      "github.ref == 'refs/heads/fix/16997-stream-tool-call-arguments'"
    );
    expect(guard).toContain("inputs.expected_sha == github.sha");
  });

  test("executes the preflight against valid and hostile contexts", () => {
    const valid = runExactHeadGuard();
    expect(valid.status, `${valid.stdout}${valid.stderr}`).toBe(0);

    for (const [field, overrides] of [
      ["GITHUB_EVENT_NAME", { GITHUB_EVENT_NAME: "pull_request" }],
      ["GITHUB_REPOSITORY", { GITHUB_REPOSITORY: "fork/eliza" }],
      ["GITHUB_ACTOR", { GITHUB_ACTOR: "untrusted-actor" }],
      ["GITHUB_REF", { GITHUB_REF: "refs/heads/develop" }],
      ["REQUESTED_MODE", { REQUESTED_MODE: "chat-flow" }],
      ["REQUESTED_SHA", { REQUESTED_SHA: "f".repeat(40) }],
      ["GITHUB_SHA", { GITHUB_SHA: "not-a-commit" }],
    ] as const) {
      const rejected = runExactHeadGuard(overrides);
      expect(rejected.status, field).not.toBe(0);
      expect(rejected.stderr, field).toContain(field);
    }
  });

  test("scopes each provider key to reviewed live-model commands", () => {
    expect(runtimeJob?.env?.CEREBRAS_API_KEY).toBeUndefined();
    expect(evidenceJob?.env?.CEREBRAS_API_KEY).toBeUndefined();
    expect(evidenceJob?.env?.ELIZAOS_CLOUD_API_KEY).toBeUndefined();
    expect(stepsWithSecret(runtimeJob, cerebrasSecret)).toEqual([
      "Measure every provider in parallel and max-cached",
      "Measure live Cerebras Gemma 4 production chat flow",
    ]);
    expect(stepsWithSecret(evidenceJob, cloudSecret)).toEqual([
      "Run live plugin tool-call stream evidence",
    ]);
    expect(workflowSource.split(cerebrasSecret)).toHaveLength(3);
    expect(workflowSource.split(cloudSecret)).toHaveLength(2);
  });

  test("runs the executable guard before immutable credential-free checkout", () => {
    const runtimeCheckout = namedStep(runtimeJob, "Checkout");
    expect(runtimeCheckout.with?.["persist-credentials"]).toBe(false);

    const evidenceCheckout = namedStep(evidenceJob, "Checkout exact head");
    expect(evidenceCheckout.with?.ref).toBe("$" + "{{ github.sha }}");
    expect(evidenceCheckout.with?.["persist-credentials"]).toBe(false);

    const steps = evidenceJob?.steps ?? [];
    expect(steps[0]?.name).toBe("Bind trusted exact-head dispatch");
    expect(steps.findIndex((step) => step.name === "Checkout exact head")).toBe(1);
    expect(namedStep(evidenceJob, "Install workspace").run).toContain(
      "--ignore-scripts"
    );
  });

  test("drives the real plugin consumer and uploads schema-limited evidence", () => {
    const liveTestSource = readFileSync(
      new URL(
        "plugins/plugin-elizacloud/__tests__/text-streaming.live.test.ts",
        repoRoot
      ),
      "utf8"
    );
    expect(liveTestSource).toContain("handleResponseHandler(runtime(apiKey)");
    expect(liveTestSource).toContain("streamStructured: true");
    expect(liveTestSource).toContain("response.body.tee()");
    expect(liveTestSource).toContain("const response = await realFetch(input, init)");
    expect(liveTestSource).toContain("executeSyntheticTool");
    expect(liveTestSource).toContain("pluginMatchesExecuted");
    expect(liveTestSource).not.toContain("mockResolvedValue");
    expect(liveTestSource).not.toMatch(/authorization|cookie/i);

    const testStep = namedStep(
      evidenceJob,
      "Run live plugin tool-call stream evidence"
    );
    expect(testStep.run).toContain("--conditions=eliza-source");
    expect(testStep.run).toContain(
      "plugins/plugin-elizacloud/__tests__/text-streaming.live.test.ts"
    );
    expect(testStep.env?.ELIZAOS_CLOUD_API_KEY).toBe(cloudSecret);

    const upload = namedStep(evidenceJob, "Upload exact-head live evidence");
    expect(upload.with?.path).toBe(
      "reports/16997-plugin-toolcall-stream-live.json\n" +
        "reports/16997-plugin-toolcall-stream-live.json.sha256\n"
    );
    expect(upload.with?.["if-no-files-found"]).toBe("error");
  });
});
