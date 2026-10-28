import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePhoneWorkflowSpec } from "./phone-workflow.ts";
import {
  parseRemoteWorkflow,
  parseWorkflowApprovalReceipt,
  parseWorkflowRun,
  WorkflowActivationRejected,
  WorkflowAdmissionRejected,
  WorkflowClient,
  WorkflowHttpError,
  WorkflowLifecycleRejected,
  WorkflowMetadataRejected,
  WorkflowTypedRejected,
  workflowOccurrenceNotRun,
  workflowSpecDigest,
} from "./workflow-client.ts";

const signal = new AbortController().signal;
const ready = {
  engine: "smthrs",
  status: "ready",
  manualSubmissionProtocol: 1,
  approvalReceiptProtocol: 1,
  metadataMutationProtocol: 1,
  lifecycleMutationProtocol: 1,
  typedScheduleProtocol: 1,
};
const workflow = (over: Record<string, unknown> = {}) => ({
  id: "flow",
  name: "Morning",
  active: false,
  versionId: "v1",
  steps: [{ label: "Draft" }],
  ...over,
});
const execution = (over: Record<string, unknown> = {}) => ({
  id: "run",
  workflowId: "flow",
  workflowVersionId: "v1",
  status: "running",
  startedAt: "2026-10-28T07:30:00.000Z",
  finished: false,
  events: [],
  ...over,
});
type Call = { path: string; body: unknown };
function agent(
  routes: Record<string, (body: unknown) => unknown>,
  status: Record<string, unknown> = ready,
) {
  const calls: Call[] = [];
  const client = new WorkflowClient(async (path, body) => {
    calls.push({ path, body });
    if (path === "/api/workflow/status") return status;
    const route = routes[path];
    if (!route) throw new Error(`unexpected ${path}`);
    return route(body);
  });
  return { calls, client };
}
const message = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return "resolved";
  } catch (error) {
    return error;
  }
};

test("workflow definitions keep an unreadable typed spec as absent and mark digests", () => {
  const parsed = parseRemoteWorkflow(
    workflow({
      metadata: {
        elizaPhoneWorkflowSpec: "{not json",
        elizaHostedDigestV1: "{}",
      },
    }),
  );
  assert.equal(parsed.phoneSpec, undefined);
  assert.equal(parsed.hostedDigest, true);
  assert.equal(parsed.triggerCleanup, "complete");
  assert.deepEqual(
    parseRemoteWorkflow(
      workflow({ metadata: { elizaPhoneWorkflowSpec: '{"version":1}' } }),
    ).phoneSpec,
    { version: 1 },
  );
  assert.throws(
    () => parseRemoteWorkflow(workflow({ removed: true })),
    /Invalid workflow/,
  );
});

test("execution receipts bind events to their run and keep interruption and occurrence state", () => {
  const run = parseWorkflowRun(
    execution({
      reconciliation: { state: "outcome-unknown", message: "Host stopped" },
      input: {
        typedSchedule: {
          scheduledAt: "2026-10-28T07:30:00.000Z",
          trigger: {
            kind: "time",
            localTime: "07:30",
            timeZone: "UTC",
            days: [3],
          },
          status: "ready",
          text: "",
        },
      },
      output: {
        status: "missed",
        scheduledAt: "2026-10-28T07:30:00.000Z",
        text: "Not run: the phone was off",
      },
      events: [
        {
          runId: "run",
          workflowId: "flow",
          type: "step",
          timestamp: "t",
          nodeId: "a",
        },
      ],
    }),
  );
  assert.deepEqual(run.reconciliation, {
    state: "outcome-unknown",
    message: "Host stopped",
  });
  assert.deepEqual(run.occurrence, {
    scheduledAt: "2026-10-28T07:30:00.000Z",
    status: "missed",
  });
  assert.equal(run.output, "Not run: the phone was off");
  assert.deepEqual(run.events, [{ type: "step", at: "t", node: "a" }]);
  assert.throws(
    () =>
      parseWorkflowRun(
        execution({
          events: [{ runId: "other", workflowId: "flow", type: "x" }],
        }),
      ),
    /Execution event identity mismatch/,
  );
  assert.throws(
    () => parseWorkflowRun(execution({ reconciliation: { state: "done" } })),
    /Invalid execution reconciliation/,
  );
});

test("a generic schedule's missed occurrence is recorded from its settlement alone", () => {
  const output = {
    status: "missed",
    scheduledAt: "2026-10-28T07:30:00.000Z",
    text: "Not run: the agent was not running at the scheduled time",
  };
  assert.deepEqual(workflowOccurrenceNotRun(output), output);
  const run = parseWorkflowRun(execution({ output }));
  assert.deepEqual(run.occurrence, {
    scheduledAt: "2026-10-28T07:30:00.000Z",
    status: "missed",
  });
  assert.equal(run.output, output.text);
  // Ordinary outputs and malformed settlements never read as a skipped occurrence.
  for (const value of [
    undefined,
    "done",
    [output],
    { status: "finished", scheduledAt: output.scheduledAt, text: "x" },
    { status: "missed", scheduledAt: "not a time", text: "x" },
    { status: "missed", scheduledAt: output.scheduledAt },
  ]) {
    assert.equal(workflowOccurrenceNotRun(value), undefined);
    assert.equal(
      parseWorkflowRun(execution({ output: value })).occurrence,
      undefined,
    );
  }
});

test("a run records its submission identity before sending and accepts only that receipt", async () => {
  const recorded: Array<string | undefined> = [];
  const { calls, client } = agent({
    "/api/workflow/workflows/flow": () => workflow(),
    "/api/workflow/workflows/flow/run": (body) => ({
      submissionId: (body as { submissionId: string }).submissionId,
      execution: execution(),
    }),
  });
  const run = await client.run("flow", "v1", signal, (id) => {
    recorded.push(id);
  });
  assert.equal(run.id, "run");
  const sent = calls.find((c) => c.path.endsWith("/run"))?.body as {
    submissionId: string;
    expectedVersionId: string;
  };
  assert.equal(sent.submissionId, recorded[0]);
  assert.equal(sent.expectedVersionId, "v1");

  const stale = agent({ "/api/workflow/workflows/flow": () => workflow() });
  assert.match(
    String(await message(() => stale.client.run("flow", "v0", signal))),
    /Review it again before running/,
  );
  assert.equal(
    stale.calls.some((c) => c.path.endsWith("/run")),
    false,
  );
});

test("only the agent's refusal of the exact identity is a known non-run", async () => {
  const id = "4f9b1c9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
  const refuse =
    (over: Record<string, unknown> = {}) =>
    () => {
      throw new WorkflowHttpError(409, {
        code: "WORKFLOW_VERSION_NOT_ADMITTED",
        workflowId: "flow",
        submissionId: id,
        expectedVersionId: "v1",
        ...over,
      });
    };
  const exact = agent({ "/api/workflow/workflows/flow/run": refuse() });
  assert.ok(
    (await message(() =>
      exact.client.resubmit("flow", "v1", id, signal),
    )) instanceof WorkflowAdmissionRejected,
  );
  const other = agent({
    "/api/workflow/workflows/flow/run": refuse({ submissionId: "other" }),
  });
  const unknown = await message(() =>
    other.client.resubmit("flow", "v1", id, signal),
  );
  assert.ok(unknown instanceof WorkflowHttpError);
  assert.ok(!(unknown instanceof WorkflowAdmissionRejected));
  assert.match(
    String(
      await message(() => exact.client.resubmit("flow", "v1", "x", signal)),
    ),
    /Invalid retained submission/,
  );
});

test("reconciliation returns null for an unadmitted submission and checks the version", async () => {
  const id = "4f9b1c9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
  const none = agent({
    [`/api/workflow/workflows/flow/submissions/${id}`]: () => ({
      submissionId: id,
      execution: null,
    }),
  });
  assert.equal(await none.client.reconcile("flow", "v1", id, signal), null);
  const changed = agent({
    [`/api/workflow/workflows/flow/submissions/${id}`]: () => ({
      submissionId: id,
      execution: execution({ workflowVersionId: "v2" }),
    }),
  });
  assert.match(
    String(
      await message(() => changed.client.reconcile("flow", "v1", id, signal)),
    ),
    /Reconciled execution mismatch/,
  );
  const old = agent({}, { engine: "smthrs", status: "ready" });
  assert.match(
    String(await message(() => old.client.reconcile("flow", "v1", id, signal))),
    /does not support submission reconciliation/,
  );
});

test("activation sends the reviewed version and maps the exact refusal", async () => {
  const refusing = agent({
    "/api/workflow/workflows/flow": () => workflow(),
    "/api/workflow/workflows/flow/activate": () => {
      throw new WorkflowHttpError(409, {
        code: "WORKFLOW_ACTIVATION_NOT_APPLIED",
        workflowId: "flow",
        expectedVersionId: "v1",
      });
    },
  });
  assert.ok(
    (await message(() =>
      refusing.client.activate("flow", "v1", signal),
    )) instanceof WorkflowActivationRejected,
  );
  assert.deepEqual(
    refusing.calls.find((c) => c.path.endsWith("/activate"))?.body,
    { expectedVersionId: "v1" },
  );
  const legacy = agent(
    {
      "/api/workflow/workflows/flow": () => workflow(),
      "/api/workflow/workflows/flow/activate": () => workflow({ active: true }),
    },
    { engine: "smthrs", status: "ready" },
  );
  assert.equal(
    (await legacy.client.activate("flow", "v1", signal)).active,
    true,
  );
  assert.deepEqual(
    legacy.calls.find((c) => c.path.endsWith("/activate"))?.body,
    {},
  );
});

test("approval decisions are bound to the run version and request digest", async () => {
  const run = parseWorkflowRun(execution());
  const approval = {
    runId: "run",
    workflowId: "flow",
    workflowVersionId: "v1",
    nodeId: "send",
    iteration: 0,
    requestDigest: "a".repeat(64),
    status: "pending",
    title: "Send",
    summary: "Send the draft",
    operation: "gmail.send",
    target: "a@example.test",
    account: "owner",
    supported: true,
  };
  const receipt = (status: string) => ({
    runId: "run",
    workflowId: "flow",
    workflowVersionId: "v1",
    finished: false,
    cancellationRequested: false,
    approvals: [{ ...approval, status }],
  });
  const parsed = parseWorkflowApprovalReceipt(receipt("pending"), run);
  assert.equal(parsed.approvals[0]?.supported, true);
  assert.equal(
    parseWorkflowApprovalReceipt(
      {
        ...receipt("pending"),
        approvals: [{ ...approval, account: " " }],
      },
      run,
    ).approvals[0]?.supported,
    false,
  );
  const { calls, client } = agent({
    "/api/workflow/executions/run/approvals/send/0": () => receipt("approved"),
  });
  const pending = parsed.approvals[0];
  assert.ok(pending);
  await client.decideApproval(run, pending, true, signal);
  assert.deepEqual(calls.at(-1)?.body, {
    approved: true,
    expectedVersionId: "v1",
    requestDigest: "a".repeat(64),
  });
  const unconfirmed = agent({
    "/api/workflow/executions/run/approvals/send/0": () => receipt("pending"),
  });
  assert.match(
    String(
      await message(() =>
        unconfirmed.client.decideApproval(run, pending, true, signal),
      ),
    ),
    /Decision not confirmed/,
  );
  assert.throws(
    () =>
      parseWorkflowApprovalReceipt(
        { ...receipt("pending"), workflowVersionId: "v2" },
        run,
      ),
    /Approval receipt identity mismatch/,
  );
});

test("metadata and lifecycle mutations record identity first and map exact refusals", async () => {
  let recorded = "";
  const metadata = agent({
    "/api/workflow/workflows/flow/metadata": (body) => {
      const b = body as { mutationId: string };
      assert.equal(b.mutationId, recorded);
      throw new WorkflowHttpError(409, {
        code: "WORKFLOW_METADATA_NOT_APPLIED",
        workflowId: "flow",
        mutationId: b.mutationId,
        expectedVersionId: "v1",
      });
    },
  });
  assert.ok(
    (await message(() =>
      metadata.client.changeMetadata("flow", "v1", "Name", "", signal, (id) => {
        recorded = id;
      }),
    )) instanceof WorkflowMetadataRejected,
  );
  const lifecycle = agent({
    "/api/workflow/workflows/flow/lifecycle": (body) => {
      const b = body as { mutationId: string };
      throw new WorkflowHttpError(409, {
        code: "WORKFLOW_LIFECYCLE_NOT_APPLIED",
        workflowId: "flow",
        mutationId: b.mutationId,
        expectedVersionId: "v1",
      });
    },
  });
  assert.ok(
    (await message(() =>
      lifecycle.client.lifecycle("flow", "v1", "remove", signal, () => {}),
    )) instanceof WorkflowLifecycleRejected,
  );
  const unknown = agent({
    "/api/workflow/workflows/flow/lifecycle": (body) => ({
      mutationId: (body as { mutationId: string }).mutationId,
      receipt: null,
    }),
  });
  assert.match(
    String(
      await message(() =>
        unknown.client.lifecycle("flow", "v1", "remove", signal, () => {}),
      ),
    ),
    /Lifecycle outcome unknown/,
  );
});

const typed = validatePhoneWorkflowSpec({
  version: 1,
  name: "Morning draft",
  description: "",
  trigger: { kind: "manual" },
  steps: [
    { id: "read", kind: "Read", operation: "supplied_text", text: "x" },
    {
      id: "draft",
      kind: "Write",
      operation: "compose_draft",
      source: "read",
      prefix: "",
      suffix: "",
    },
  ],
});
const catalog = {
  generationProtocol: 1 as const,
  catalogRevision: "c1",
  compilerRevision: "k1",
  maximumSteps: 32,
  maximumSpecBytes: 65536,
  triggers: [{ kind: "manual", available: true }],
  palette: [
    {
      kind: "Read",
      operations: [{ id: "supplied_text", available: true }],
    },
    {
      kind: "Write",
      operations: [{ id: "compose_draft", available: true }],
    },
  ],
};

test("typed generation keeps the owner-set trigger and validation binds the digest", async () => {
  const digest = await workflowSpecDigest(typed);
  const valid = {
    spec: typed,
    specDigest: digest,
    compilerRevision: "k1",
    catalogRevision: "c1",
    active: false,
  };
  const ok = agent({ "/api/workflow/phone/generate": () => valid });
  assert.deepEqual(
    await ok.client.generatePhone(
      "Draft",
      catalog,
      ["supplied_text", "compose_draft"],
      signal,
    ),
    typed,
  );
  const scheduled = agent({
    "/api/workflow/phone/generate": () => ({
      ...valid,
      spec: {
        ...typed,
        trigger: {
          kind: "time",
          localTime: "07:30",
          timeZone: "UTC",
          days: [1],
        },
      },
    }),
  });
  assert.match(
    String(
      await message(() =>
        scheduled.client.generatePhone(
          "Draft",
          catalog,
          ["supplied_text", "compose_draft"],
          signal,
        ),
      ),
    ),
    /changed when this workflow runs/,
  );
  const tampered = agent({
    "/api/workflow/phone/validate": () => ({
      ...valid,
      specDigest: "0".repeat(64),
    }),
  });
  assert.match(
    String(
      await message(() =>
        tampered.client.validatePhone(typed, catalog, signal),
      ),
    ),
    /changed the reviewed workflow/,
  );
  const clarify = agent({
    "/api/workflow/phone/generate": () => {
      throw new WorkflowHttpError(422, {
        error: "Workflow needs clarification: which notes?",
      });
    },
  });
  assert.match(
    String(
      await message(() =>
        clarify.client.generatePhone(
          "Draft",
          catalog,
          ["supplied_text"],
          signal,
        ),
      ),
    ),
    /which notes\?/,
  );
});

test("a typed edit refused by identity is a known non-save", async () => {
  const expected = {
    mutationId: "4f9b1c9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
    specDigest: "d".repeat(64),
    compilerRevision: "k1",
    workflowId: "flow",
    versionId: "v1",
  };
  const refusing = agent({
    "/api/workflow/workflows/flow/phone-spec": () => {
      throw new WorkflowHttpError(409, {
        code: "WORKFLOW_TYPED_NOT_APPLIED",
        workflowId: "flow",
        mutationId: expected.mutationId,
        expectedVersionId: "v1",
      });
    },
  });
  assert.ok(
    (await message(() =>
      refusing.client.savePhone(typed, catalog, expected, signal),
    )) instanceof WorkflowTypedRejected,
  );
  const network = new WorkflowClient(async () => {
    throw new TypeError("Failed to fetch");
  });
  const lost = await message(() =>
    network.savePhone(typed, catalog, expected, signal),
  );
  assert.ok(lost instanceof TypeError);
});

test("a host normalizer wraps, never replaces, the shared validation", async () => {
  let seen = 0;
  const client = new WorkflowClient(
    async () => ({
      spec: typed,
      specDigest: await workflowSpecDigest(typed),
      compilerRevision: "k1",
      catalogRevision: "c1",
      active: false,
    }),
    {
      normalizePhoneSpec: (value) => {
        seen++;
        return validatePhoneWorkflowSpec(value);
      },
    },
  );
  await client.validatePhone(typed, catalog, signal);
  assert.equal(seen, 1);
});
