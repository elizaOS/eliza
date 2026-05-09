/**
 * Automations tab — API E2E coverage.
 *
 * Runs against a live dev server (API 31337). No Playwright harness exists for
 * the Automations UI today, so this suite exercises the HTTP surface the
 * Automations tab binds to. Each case is a critical path the UI depends on.
 *
 * Run:  bun run test/scenarios/automations/automations-api.e2e.ts
 *       ELIZA_API_BASE=http://127.0.0.1:31337 bun run ...
 *
 * Exits non-zero on any failed case. Prints a per-case summary.
 */

import type { TriggerSummary } from "@elizaos/agent/triggers/types";
import type {
  WorkflowStatusResponse,
  WorkflowDefinition,
} from "@elizaos/ui/api/client-types-chat";
import type {
  AutomationItem,
  AutomationListResponse,
  AutomationNodeCatalogResponse,
  AutomationNodeDescriptor,
  WorkbenchTask,
} from "@elizaos/ui/api/client-types-config";

const API_BASE = process.env.ELIZA_API_BASE ?? "http://127.0.0.1:31337";
const AUTH_TOKEN = process.env.ELIZA_API_TOKEN ?? "";

const ALLOWED_NODE_CLASSES = new Set([
  "trigger",
  "action",
  "context",
  "integration",
  "agent",
]);

interface CaseResult {
  name: string;
  status: "pass" | "fail";
  detail?: string;
}

const results: CaseResult[] = [];

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(extra ?? {}),
  };
  if (AUTH_TOKEN) {
    headers.Authorization = `Bearer ${AUTH_TOKEN}`;
  }
  return headers;
}

async function apiFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const method = init.method ?? "GET";
  const headers = authHeaders(
    init.body ? { "Content-Type": "application/json" } : undefined,
  );
  return fetch(`${API_BASE}${path}`, {
    ...init,
    method,
    headers: { ...headers, ...(init.headers as Record<string, string>) },
  });
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (text.length === 0) return {} as T;
  return JSON.parse(text) as T;
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function runCase(name: string, body: () => Promise<void>): Promise<void> {
  process.stdout.write(`  ${name} ... `);
  try {
    await body();
    results.push({ name, status: "pass" });
    process.stdout.write("PASS\n");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, status: "fail", detail });
    process.stdout.write(`FAIL\n    ${detail}\n`);
  }
}

// ---------------------------------------------------------------------------
// Case 1: Text-kind trigger lifecycle
// ---------------------------------------------------------------------------

async function caseTextTriggerLifecycle(): Promise<void> {
  const displayName = `e2e-text-trigger-${Date.now()}`;
  const createRes = await apiFetch("/api/triggers", {
    method: "POST",
    body: JSON.stringify({
      kind: "text",
      displayName,
      instructions: "E2E probe trigger - safe to ignore",
      triggerType: "interval",
      intervalMs: 60_000,
      enabled: true,
    }),
  });
  assert(
    createRes.status === 201,
    `POST /api/triggers expected 201, got ${createRes.status}`,
  );
  const created = await readJson<{ trigger: TriggerSummary }>(createRes);
  assert(created.trigger?.id, "created trigger missing id");
  const triggerId = created.trigger.id;

  try {
    const listRes = await apiFetch("/api/automations");
    assert(listRes.status === 200, `GET /api/automations ${listRes.status}`);
    const list = await readJson<AutomationListResponse>(listRes);
    const hit = list.automations.find(
      (a: AutomationItem) => a.triggerId === triggerId,
    );
    assert(
      hit,
      `new trigger ${triggerId} not visible in /api/automations (${list.automations.length} items)`,
    );
    assert(
      hit.source === "trigger",
      `expected source=trigger, got ${hit.source}`,
    );
    assert(
      hit.type === "coordinator_text",
      `expected type=coordinator_text, got ${hit.type}`,
    );

    const disableRes = await apiFetch(`/api/triggers/${triggerId}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
    assert(
      disableRes.status === 200,
      `PUT /api/triggers/:id disable ${disableRes.status}`,
    );
    const disabled = await readJson<{ trigger: TriggerSummary }>(disableRes);
    assert(
      disabled.trigger.enabled === false,
      "trigger did not transition to enabled=false",
    );

    const runRes = await apiFetch(`/api/triggers/${triggerId}/execute`, {
      method: "POST",
    });
    assert(
      runRes.status === 200,
      `POST /api/triggers/:id/execute ${runRes.status}`,
    );
    const runBody = await readJson<{ ok: boolean }>(runRes);
    assert(runBody.ok === true, "trigger execute did not report ok");

    // Runs may be recorded asynchronously; poll briefly.
    let runsSeen = 0;
    for (let i = 0; i < 10; i += 1) {
      const runsRes = await apiFetch(`/api/triggers/${triggerId}/runs`);
      assert(
        runsRes.status === 200,
        `GET /api/triggers/:id/runs ${runsRes.status}`,
      );
      const runsBody = await readJson<{ runs: unknown[] }>(runsRes);
      runsSeen = runsBody.runs.length;
      if (runsSeen > 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(runsSeen > 0, "no runs recorded after execute");
  } finally {
    const delRes = await apiFetch(`/api/triggers/${triggerId}`, {
      method: "DELETE",
    });
    assert(delRes.status === 200, `DELETE trigger ${delRes.status}`);
    const afterRes = await apiFetch("/api/automations");
    const after = await readJson<AutomationListResponse>(afterRes);
    const stillThere = after.automations.find(
      (a: AutomationItem) => a.triggerId === triggerId,
    );
    assert(!stillThere, "trigger still present after delete");
  }
}

// ---------------------------------------------------------------------------
// Case 2: Workflow-kind trigger validation
// ---------------------------------------------------------------------------

async function caseWorkflowTriggerValidation(): Promise<void> {
  const missingIdRes = await apiFetch("/api/triggers", {
    method: "POST",
    body: JSON.stringify({
      kind: "workflow",
      displayName: "e2e-missing-workflow-id",
      instructions: "should be rejected",
      triggerType: "interval",
      intervalMs: 60_000,
    }),
  });
  assert(
    missingIdRes.status === 400,
    `missing workflowId expected 400, got ${missingIdRes.status}`,
  );
  const missingBody = await readJson<{ error?: string }>(missingIdRes);
  assert(
    (missingBody.error ?? "").toLowerCase().includes("workflowid"),
    `error should mention workflowId, got ${JSON.stringify(missingBody)}`,
  );

  // Non-existent workflowId is accepted by the backend (validation is
  // upstream at dispatch time). We record that invariant but do not force
  // dispatch here — the trigger system won't fire a disabled interval
  // trigger during this run. Cleanup on success.
  const acceptedRes = await apiFetch("/api/triggers", {
    method: "POST",
    body: JSON.stringify({
      kind: "workflow",
      workflowId: "nonexistent-workflow-id",
      workflowName: "nonexistent",
      displayName: `e2e-invalid-workflow-${Date.now()}`,
      instructions: "probe: invalid workflow id",
      triggerType: "interval",
      intervalMs: 60_000,
      enabled: false,
    }),
  });
  assert(
    acceptedRes.status === 201,
    `backend should accept unknown workflowId, got ${acceptedRes.status}`,
  );
  const accepted = await readJson<{ trigger: TriggerSummary }>(acceptedRes);
  try {
    assert(
      accepted.trigger.kind === "workflow",
      "accepted trigger did not record kind=workflow",
    );
    assert(
      accepted.trigger.workflowId === "nonexistent-workflow-id",
      "accepted trigger did not store workflowId",
    );
  } finally {
    await apiFetch(`/api/triggers/${accepted.trigger.id}`, {
      method: "DELETE",
    });
  }
}

// ---------------------------------------------------------------------------
// Case 3: workflow listing + status
// ---------------------------------------------------------------------------

async function caseWorkflowDefinitionsAndStatus(): Promise<void> {
  const listRes = await apiFetch("/api/workflow/workflows");
  assert(listRes.status === 200, `GET /api/workflow/workflows ${listRes.status}`);
  const listBody = await readJson<{ workflows: WorkflowDefinition[] }>(listRes);
  assert(Array.isArray(listBody.workflows), "workflows is not an array");

  const statusRes = await apiFetch("/api/workflow/status");
  assert(statusRes.status === 200, `GET /api/workflow/status ${statusRes.status}`);
  const status = await readJson<WorkflowStatusResponse>(statusRes);
  assert(typeof status.mode === "string", "workflow status missing mode");
  assert(typeof status.status === "string", "workflow status missing status");
  assert(
    typeof status.cloudHealth === "string",
    "workflow status missing cloudHealth",
  );
  assert(typeof status.platform === "string", "workflow status missing platform");
}

// ---------------------------------------------------------------------------
// Case 4: Workbench task lifecycle
// ---------------------------------------------------------------------------

async function caseWorkbenchTaskLifecycle(): Promise<void> {
  const taskName = `e2e-task-${Date.now()}`;
  const createRes = await apiFetch("/api/workbench/tasks", {
    method: "POST",
    body: JSON.stringify({
      name: taskName,
      description: "E2E probe task - safe to ignore",
    }),
  });
  assert(
    createRes.status === 201,
    `POST /api/workbench/tasks ${createRes.status}`,
  );
  const created = await readJson<{ task: WorkbenchTask }>(createRes);
  const taskId = created.task.id;
  assert(taskId, "created task missing id");

  try {
    const listRes = await apiFetch("/api/automations");
    const list = await readJson<AutomationListResponse>(listRes);
    const hit = list.automations.find(
      (a: AutomationItem) => a.taskId === taskId,
    );
    assert(hit, `workbench task ${taskId} not in /api/automations`);
    assert(
      hit.source === "workbench_task",
      `expected source=workbench_task, got ${hit.source}`,
    );

    const patchRes = await apiFetch(`/api/workbench/tasks/${taskId}`, {
      method: "PUT",
      body: JSON.stringify({ isCompleted: true }),
    });
    assert(patchRes.status === 200, `PUT workbench task ${patchRes.status}`);
    const patched = await readJson<{ task: WorkbenchTask }>(patchRes);
    assert(
      patched.task.isCompleted === true,
      "task did not transition to isCompleted=true",
    );
  } finally {
    const delRes = await apiFetch(`/api/workbench/tasks/${taskId}`, {
      method: "DELETE",
    });
    assert(delRes.status === 200, `DELETE task ${delRes.status}`);
  }
}

// ---------------------------------------------------------------------------
// Case 5: Automations list shape
// ---------------------------------------------------------------------------

async function caseAutomationsList(): Promise<void> {
  const res = await apiFetch("/api/automations");
  assert(res.status === 200, `GET /api/automations ${res.status}`);
  const body = await readJson<AutomationListResponse>(res);
  assert(Array.isArray(body.automations), "automations not an array");
  assert(typeof body.summary === "object", "summary missing");
  assert(
    body.summary.total === body.automations.length,
    `summary.total (${body.summary.total}) != automations.length (${body.automations.length})`,
  );
  const coord = body.automations.filter(
    (a) => a.type === "coordinator_text",
  ).length;
  const wf = body.automations.filter((a) => a.type === "workflow_service").length;
  assert(
    body.summary.coordinatorCount === coord,
    `coordinatorCount mismatch: ${body.summary.coordinatorCount} vs ${coord}`,
  );
  assert(
    body.summary.workflowCount === wf,
    `workflowCount mismatch: ${body.summary.workflowCount} vs ${wf}`,
  );
  assert(body.workflowStatus !== undefined, "workflowStatus field absent");
  assert(body.workflowStatus !== null, "workflowStatus null (workflow unreachable?)");
  assert(
    body.workflowFetchError === null,
    `workflowFetchError should be null when workflow healthy, got ${body.workflowFetchError}`,
  );
}

// ---------------------------------------------------------------------------
// Case 6: Node catalog
// ---------------------------------------------------------------------------

async function caseNodeCatalog(): Promise<void> {
  const res = await apiFetch("/api/automations/nodes");
  assert(res.status === 200, `GET /api/automations/nodes ${res.status}`);
  const body = await readJson<AutomationNodeCatalogResponse>(res);
  assert(Array.isArray(body.nodes), "nodes not an array");
  assert(body.nodes.length > 0, "empty node catalog");
  for (const node of body.nodes) {
    const n: AutomationNodeDescriptor = node;
    assert(typeof n.id === "string" && n.id.length > 0, "node missing id");
    assert(typeof n.label === "string", `node ${n.id} missing label`);
    assert(
      ALLOWED_NODE_CLASSES.has(n.class),
      `node ${n.id} has disallowed class=${n.class}`,
    );
    assert(
      n.availability === "enabled" || n.availability === "disabled",
      `node ${n.id} bad availability=${n.availability}`,
    );
    assert(
      [
        "runtime_action",
        "runtime_provider",
        "lifeops",
        "lifeops_event",
      ].includes(n.source),
      `node ${n.id} bad source=${n.source}`,
    );
  }
  const sum = body.summary;
  assert(
    sum.total === body.nodes.length,
    "summary.total mismatch in node catalog",
  );
  assert(
    sum.enabled + sum.disabled === sum.total,
    `enabled+disabled (${sum.enabled}+${sum.disabled}) != total ${sum.total}`,
  );
}

// ---------------------------------------------------------------------------
// Case 7: /api/workflow/status platform + cloudHealth invariants
// ---------------------------------------------------------------------------

async function caseWorkflowStatusInvariants(): Promise<void> {
  const res = await apiFetch("/api/workflow/status");
  assert(res.status === 200, `GET /api/workflow/status ${res.status}`);
  const status = await readJson<WorkflowStatusResponse>(res);
  assert(
    status.platform === "desktop" || status.platform === "cloud",
    `platform should be desktop or cloud, got ${status.platform}`,
  );
  if (status.mode === "local") {
    assert(
      status.cloudHealth === "unknown",
      `local mode cloudHealth expected "unknown", got ${status.cloudHealth}`,
    );
    assert(
      status.localEnabled === true,
      `local mode should report localEnabled=true, got ${status.localEnabled}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Automations E2E — ${API_BASE}`);

  const ping = await apiFetch("/api/workflow/status").catch(() => null);
  if (!ping?.ok) {
    console.error(
      `FATAL: dev server not responding on ${API_BASE}/api/workflow/status`,
    );
    process.exit(2);
  }

  console.log("\nCase 1: Text-kind trigger lifecycle");
  await runCase("text-trigger lifecycle", caseTextTriggerLifecycle);

  console.log("\nCase 2: Workflow-kind trigger validation");
  await runCase("workflow-trigger validation", caseWorkflowTriggerValidation);

  console.log("\nCase 3: workflow listing + status");
  await runCase("workflows + status", caseWorkflowDefinitionsAndStatus);

  console.log("\nCase 4: Workbench task lifecycle");
  await runCase("workbench task lifecycle", caseWorkbenchTaskLifecycle);

  console.log("\nCase 5: Automations list shape");
  await runCase("automations list", caseAutomationsList);

  console.log("\nCase 6: Node catalog shape");
  await runCase("node catalog", caseNodeCatalog);

  console.log("\nCase 7: workflow status invariants (platform, cloudHealth)");
  await runCase("workflow status invariants", caseWorkflowStatusInvariants);

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  console.log("\n--- Summary ---");
  console.log(`passed: ${passed}`);
  console.log(`failed: ${failed}`);
  for (const r of results) {
    if (r.status === "fail") {
      console.log(`FAIL  ${r.name}: ${r.detail}`);
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(2);
});
