/**
 * Deterministic (keyless) proof for the #14630 reject-routing fix: a PENDING
 * approval-queue row must be visible to the router/planner as prompt state —
 * via the `pendingApprovals` provider — and the RESOLVE_REQUEST reject verb
 * must terminally resolve it with nothing dispatched.
 *
 * The live-only companion (`f1-cross-persona-wrong-recipient-highstakes`)
 * proves a real model routes "reject that for now" to RESOLVE_REQUEST; this
 * scenario proves the machinery that routing depends on, with zero LLM calls:
 * the seed action enqueues a real queue row, the registered provider renders
 * it (id + reject-is-a-hold routing contract), the real RESOLVE_REQUEST
 * handler rejects it via the planner trust path (explicit requestId — no
 * extraction model call), and the provider then renders nothing.
 *
 * Fail-without-fix anchor: without the `pendingApprovals` provider nothing
 * renders queue rows into prompt state, so the "provider surfaces the pending
 * row" check fails (provider missing from the runtime).
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

interface ProviderResultLike {
  text: string;
  values?: Record<string, unknown>;
}

interface ProviderLike {
  name: string;
  alwaysInResponseState?: boolean;
  get(
    runtime: unknown,
    message: Record<string, unknown>,
    state: Record<string, unknown>,
  ): Promise<ProviderResultLike>;
}

interface ActionLike {
  name: string;
  handler(
    runtime: unknown,
    message: Record<string, unknown>,
    state: undefined,
    options: Record<string, unknown>,
    callback: (content: { text?: string }) => Promise<unknown[]>,
  ): Promise<{ success?: boolean; data?: Record<string, unknown> } | undefined>;
}

interface RuntimeLike {
  agentId: string;
  providers: ProviderLike[];
  actions: ActionLike[];
  getSetting(key: string): unknown;
}

function requireRuntime(ctx: ScenarioContext): RuntimeLike {
  const runtime = ctx.runtime as RuntimeLike | undefined;
  if (!runtime) throw new Error("scenario runtime unavailable");
  return runtime;
}

// The executor pins ELIZA_ADMIN_ENTITY_ID to the primary room's user, and the
// seed action turn enqueues with subjectUserId = that same entityId — so this
// is the owner identity both the provider and RESOLVE_REQUEST scope by.
function ownerMessage(runtime: RuntimeLike, text: string) {
  const ownerEntityId = String(runtime.getSetting("ELIZA_ADMIN_ENTITY_ID"));
  return {
    id: crypto.randomUUID(),
    entityId: ownerEntityId,
    agentId: runtime.agentId,
    roomId: crypto.randomUUID(),
    content: { text },
    createdAt: Date.now(),
  };
}

function seededApprovalRequestId(ctx: ScenarioContext): string {
  const seed = ctx.actionsCalled.find((a) => {
    if (a.actionName !== "PERSONAL_ASSISTANT") return false;
    const data = a.result?.data as Record<string, unknown> | undefined;
    return data?.action === "sign_document";
  });
  const data = seed?.result?.data as Record<string, unknown> | undefined;
  const id = data?.approvalRequestId;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(
      "seed sign_document returned no approvalRequestId — nothing was enqueued",
    );
  }
  return id;
}

function findPendingApprovalsProvider(runtime: RuntimeLike): ProviderLike {
  const provider = runtime.providers.find(
    (candidate) => candidate.name === "pendingApprovals",
  );
  if (!provider) {
    throw new Error(
      "pendingApprovals provider is not registered — pending queue rows are invisible to the planner (#14630)",
    );
  }
  return provider;
}

async function expectPendingRowSurfaced(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = requireRuntime(ctx);
  const requestId = seededApprovalRequestId(ctx);
  const provider = findPendingApprovalsProvider(runtime);
  if (provider.alwaysInResponseState !== true) {
    return "pendingApprovals must be alwaysInResponseState so Stage-1 routing sees the queue before contexts are selected";
  }
  const result = await provider.get(
    runtime,
    ownerMessage(runtime, "Wait — which Chris? Don't send it."),
    { values: {}, data: {}, text: "" },
  );
  if (!result.text.includes(`id=${requestId}`)) {
    return `provider text must surface the pending row id=${requestId}; got: ${result.text || "(empty)"}`;
  }
  if (!result.text.includes("RESOLVE_REQUEST")) {
    return "provider text must route decisions to RESOLVE_REQUEST";
  }
  if (!/hold|don't send/i.test(result.text)) {
    return "provider text must state that a hold ('don't send it', 'not yet') is a rejection";
  }
  return undefined;
}

async function expectRejectResolvesRow(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = requireRuntime(ctx);
  const requestId = seededApprovalRequestId(ctx);
  const action = runtime.actions.find((a) => a.name === "RESOLVE_REQUEST");
  if (!action) return "RESOLVE_REQUEST action is not registered";
  // Explicit requestId drives the planner trust path in resolveActionArgs —
  // no extraction model call, so this stays keyless under the strict proxy.
  const result = await action.handler(
    runtime,
    ownerMessage(
      runtime,
      "Don't send it, reject that for now until I confirm the right person.",
    ),
    undefined,
    {
      parameters: {
        action: "reject",
        requestId,
        reason: "ambiguous recipient — two contacts named Chris",
      },
    },
    async () => [],
  );
  if (result?.success !== true) {
    return `RESOLVE_REQUEST reject did not succeed: ${JSON.stringify(result?.data ?? {})}`;
  }
  if (result.data?.state !== "rejected") {
    return `reject must leave the row terminally rejected; got state=${String(result.data?.state)}`;
  }
  const provider = findPendingApprovalsProvider(runtime);
  const after = await provider.get(
    runtime,
    ownerMessage(runtime, "anything still waiting on me?"),
    { values: {}, data: {}, text: "" },
  );
  if (after.text !== "") {
    return `rejected row must drop out of the provider render; got: ${after.text}`;
  }
  return undefined;
}

export default scenario({
  lane: "pr-deterministic",
  id: "approval-queue-pending-visible-to-planner",
  title:
    "Pending approval rows surface to the planner and reject terminally resolves them",
  domain: "lifeops.approvals",
  tags: ["lifeops", "approval", "control", "14630"],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Reject routing (owner)",
    },
  ],
  turns: [
    {
      // Same deterministic seed as the live scenario: enqueue a real PENDING
      // approval through the real action + queue, bypassing LLM routing.
      kind: "action",
      name: "seed-pending-sensitive-send-approval",
      room: "main",
      actionName: "PERSONAL_ASSISTANT",
      text: "Send the signed offer letter to Chris — but get my approval before it goes out.",
      options: {
        action: "sign_document",
        documentName: "Signed Offer Letter",
        reason:
          "Owner asked to send the signed offer letter to 'Chris' — but there are two Chris contacts, so this needs confirmation before sending.",
      },
      assertResponse(text: string) {
        if (!/approval|approve/i.test(text)) {
          return "seed reply must say the send is gated on approval";
        }
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "pending approval row surfaces to router/planner state",
      predicate: expectPendingRowSurfaced,
    },
    {
      type: "custom",
      name: "RESOLVE_REQUEST reject terminally resolves the row, nothing dispatched",
      predicate: expectRejectResolvesRow,
    },
  ],
});
