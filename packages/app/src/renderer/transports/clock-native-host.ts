/** Connects the renderer to the native-owned Clock session and reviewed effect path; streaming chat retains native credential custody. */
import {
  Capacitor,
  type PluginListenerHandle,
  registerPlugin,
} from "@capacitor/core";
import {
  CLOCK_CAPABILITY,
  CLOCK_REPEAT_CAPABILITY,
  type ClockReviewBridge,
  type ClockReviewReply,
  clockCapabilityAvailable,
  clockTimeZone,
  createClockReviewExecutor,
  validateClockOperation,
} from "@elizaos/plugin-assistant/device-clock-review";
import {
  type AgentRequestTransport,
  bodyToString,
  type ClockProposal,
  type ClockStatus,
  configureClockHost,
  headersToRecord,
  isStreamingRequest,
  reportRendererDiagnostic,
  requireTextRequestBody,
} from "@elizaos/ui";

interface AgentChunk {
  requestId: string;
  data?: string;
  done?: boolean;
  error?: string;
}
interface SlotClockBridge extends ClockReviewBridge {
  reviewClock(
    input: Parameters<ClockReviewBridge["reviewClock"]>[0],
  ): Promise<ClockReviewReply & { receiptPending?: boolean }>;
  confirmClock(
    input: Parameters<ClockReviewBridge["confirmClock"]>[0],
  ): Promise<ClockReviewReply & { receiptPending?: boolean }>;
  getStatus(): Promise<unknown>;
  listProposals(): Promise<unknown>;
  requestAgent(input: {
    method: string;
    path: string;
    expectedOrigin: string;
    expectedBase: string;
    headers: Record<string, string>;
    body?: string;
    requestId: string;
    stream: boolean;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    data: string;
    streamed?: boolean;
  }>;
  cancelAgentRequest(input: { requestId: string }): Promise<unknown>;
  addListener(
    event: "agentChunk",
    listener: (chunk: AgentChunk) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: "proposalsChanged",
    listener: () => void,
  ): Promise<PluginListenerHandle>;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nativeObject(value: unknown, fields: readonly string[]) {
  if (
    !isObject(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    throw new Error("Invalid native Clock fields");
  return value;
}
function nativeIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[-A-Za-z0-9_]{1,128}$/.test(value))
    throw new Error("Invalid native Clock identifier");
  return value;
}
function nativeDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("Invalid native Clock digest");
  return value;
}
function nativeBase(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) <= 32 ||
        character.charCodeAt(0) === 127 ||
        character === "\\" ||
        character === "%",
    ) ||
    /\/(?:\.|\.\.)(?:\/|$)/.test(value)
  )
    throw new Error("Invalid native Clock agent base");
  const base = new URL(value);
  const host = base.hostname.toLowerCase();
  const privateHost =
    ["localhost", "[::1]"].includes(host) ||
    /^\[(?:f[cd][a-f0-9:]+|fe[89ab][a-f0-9:]+)\]$/.test(host) ||
    (() => {
      const octets = host.split(".");
      if (
        octets.length !== 4 ||
        octets.some((octet) => !/^(?:0|[1-9][0-9]{0,2})$/.test(octet))
      )
        return false;
      const [a, b, c, d] = octets.map(Number);
      if ([a, b, c, d].some((octet) => octet > 255)) return false;
      return (
        a === 127 ||
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254)
      );
    })();
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !(base.protocol === "https:" || (base.protocol === "http:" && privateHost))
  )
    throw new Error("Invalid native Clock agent base");
  return value;
}
function nativeStatus(raw: unknown): ClockStatus {
  const value = nativeObject(raw, [
    "supported",
    "agentBase",
    "reason",
    "capabilities",
    "scope",
    "installationId",
    "context",
  ]);
  if (
    typeof value.supported !== "boolean" ||
    !Array.isArray(value.capabilities)
  )
    throw new Error("Invalid native Clock status");
  const capabilities = Array.from(value.capabilities, (capability: unknown) => {
    if (
      capability !== CLOCK_CAPABILITY &&
      capability !== CLOCK_REPEAT_CAPABILITY
    )
      throw new Error("Invalid native Clock capability");
    return capability;
  });
  if (new Set(capabilities).size !== capabilities.length)
    throw new Error("Duplicate native Clock capability");
  if (!value.supported) {
    if (
      value.agentBase !== null ||
      value.scope !== null ||
      value.installationId !== null ||
      value.context !== null ||
      capabilities.length !== 0 ||
      typeof value.reason !== "string" ||
      value.reason.length === 0
    )
      throw new Error("Invalid unavailable native Clock status");
    return {
      supported: false,
      agentBase: null,
      reason: value.reason,
      capabilities,
      scope: null,
      installationId: null,
      context: null,
    };
  }
  if (capabilities.length === 0 || value.reason !== null)
    throw new Error("Native Clock capability unavailable");
  const context = nativeObject(value.context, [
    "sensitive",
    "revision",
    "timeZone",
  ]);
  if (
    context.sensitive !== false ||
    typeof context.revision !== "number" ||
    !Number.isSafeInteger(context.revision) ||
    context.revision < 0
  )
    throw new Error("Invalid native Clock phone context");
  return {
    supported: true,
    agentBase: nativeBase(value.agentBase),
    reason: null,
    capabilities,
    scope: nativeDigest(value.scope),
    installationId: nativeIdentifier(value.installationId),
    context: {
      sensitive: false,
      revision: context.revision,
      timeZone: clockTimeZone(context.timeZone),
    },
  };
}
function nativeProposal(raw: unknown): ClockProposal {
  const value = nativeObject(raw, [
    "id",
    "digest",
    "state",
    "expiresAt",
    "operation",
  ]);
  if (
    typeof value.state !== "string" ||
    ![
      "pending",
      "approved",
      "executing",
      "retryable",
      "reconciliation_required",
      "done",
      "rejected",
      "expired",
    ].includes(value.state) ||
    typeof value.expiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.expiresAt) ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    new Date(value.expiresAt).toISOString() !== value.expiresAt
  )
    throw new Error("Invalid native Clock proposal state or expiry");
  return {
    id: nativeIdentifier(value.id),
    digest: nativeDigest(value.digest),
    state: value.state,
    expiresAt: value.expiresAt,
    operation: validateClockOperation(value.operation),
  };
}
function nativeProposals(raw: unknown) {
  const value = nativeObject(raw, ["scope", "proposals"]);
  if (!Array.isArray(value.proposals))
    throw new Error("Invalid native Clock proposals");
  const proposals = Array.from(value.proposals, nativeProposal);
  if (
    new Set(proposals.map((proposal) => proposal.id)).size !== proposals.length
  )
    throw new Error("Duplicate native Clock proposal");
  return { scope: nativeDigest(value.scope), proposals };
}
const available =
  Capacitor.isNativePlatform() &&
  Capacitor.getPlatform() === "android" &&
  Capacitor.isPluginAvailable("SlotClock");
const bridge = available ? registerPlugin<SlotClockBridge>("SlotClock") : null;
if (bridge) {
  const pendingReceipts = new Map<string, boolean>();
  const observe = (
    proposalId: string,
    reply: ClockReviewReply & { receiptPending?: boolean },
  ) => {
    if (reply.result) {
      if (typeof reply.receiptPending !== "boolean")
        throw new Error("Clock receipt settlement status unavailable");
      pendingReceipts.set(proposalId, reply.receiptPending);
    }
    return reply;
  };
  const executor = createClockReviewExecutor({
    async reviewClock(input) {
      return observe(input.proposalId, await bridge.reviewClock(input));
    },
    async confirmClock(input) {
      return observe(input.proposalId, await bridge.confirmClock(input));
    },
    cancelClock: (input) => bridge.cancelClock(input),
  });
  let currentScope: string | null = null;
  const status = async () => {
    const value = nativeStatus(await bridge.getStatus());
    if (currentScope !== null && currentScope !== value.scope)
      await executor.retire();
    currentScope = value.scope;
    return value;
  };
  configureClockHost({
    status,
    async proposals() {
      const result = nativeProposals(await bridge.listProposals());
      if (currentScope !== null && currentScope !== result.scope)
        await executor.retire();
      currentScope = result.scope;
      return result;
    },
    async review(proposal, scope, signal) {
      signal.throwIfAborted();
      const validated = nativeProposal(proposal);
      const current = await status();
      if (!current.supported || current.scope !== scope)
        throw new Error("Clock owner changed");
      if (!clockCapabilityAvailable(validated.operation, current.capabilities))
        throw new Error("Clock capability unavailable for this request");
      const handoff = await executor.review(
        validated.operation,
        validated.id,
        { scope, proposalId: validated.id },
        signal,
        () => {
          if (currentScope !== scope) throw new Error("Clock owner changed");
        },
      );
      const receiptPending = pendingReceipts.get(validated.id);
      if (receiptPending === undefined)
        throw new Error("Clock receipt settlement was not observed");
      return { handoff, receiptPending };
    },
    subscribe(listener) {
      let retired = false;
      const handle = bridge.addListener("proposalsChanged", () => {
        if (!retired) listener();
      });
      return () => {
        retired = true;
        void handle
          .then((h) => h.remove())
          .catch((error) =>
            reportRendererDiagnostic({
              scope: "clock-listener-retirement",
              error,
            }),
          );
      };
    },
    retire: executor.retire,
  });
}

const transport: AgentRequestTransport = {
  async request(url, init) {
    if (!clockRequestUnbound(init))
      throw new Error("Native Clock cannot replace an existing device binding");
    if (!bridge) throw new Error("Native Clock transport unavailable");
    const status = nativeStatus(await bridge.getStatus());
    if (!status.supported || !status.agentBase)
      throw new Error("Native Clock target unavailable");
    const relativePath = clockAgentRelativePath(url, status.agentBase);
    if (relativePath === null)
      throw new Error("Native Clock agent target changed");
    const target = new URL(url);
    const requestId = crypto.randomUUID();
    const stream = isStreamingRequest(url, init.headers);
    const controller: {
      current: ReadableStreamDefaultController<Uint8Array> | null;
    } = { current: null };
    let done = false;
    const encoder = new TextEncoder();
    let handle: PluginListenerHandle | null = null;
    let cleanup: Promise<void> | undefined;
    const finish = () => {
      if (!cleanup)
        cleanup = (async () => {
          try {
            if (handle) await handle.remove();
          } finally {
            handle = null;
            init.signal?.removeEventListener("abort", abort);
          }
        })();
      return cleanup;
    };
    const cancelNative = async () => {
      try {
        await bridge.cancelAgentRequest({ requestId });
      } finally {
        await finish();
      }
    };
    const abort = () => {
      if (!done) {
        done = true;
        controller.current?.error(init.signal?.reason);
      }
      void cancelNative().catch((error) =>
        reportRendererDiagnostic({
          scope: "clock-request-cancellation",
          error,
        }),
      );
    };
    const body = stream
      ? new ReadableStream<Uint8Array>({
          start(value) {
            controller.current = value;
          },
          async cancel() {
            done = true;
            await cancelNative();
          },
        })
      : null;
    try {
      if (stream)
        handle = await bridge.addListener("agentChunk", (chunk) => {
          if (chunk.requestId !== requestId || done) return;
          if (chunk.error) {
            done = true;
            controller.current?.error(new Error(chunk.error));
            void finish().catch((error) =>
              reportRendererDiagnostic({
                scope: "clock-stream-cleanup",
                error,
              }),
            );
          } else {
            if (chunk.data)
              controller.current?.enqueue(encoder.encode(chunk.data));
            if (chunk.done) {
              done = true;
              controller.current?.close();
              void finish().catch((error) =>
                reportRendererDiagnostic({
                  scope: "clock-stream-cleanup",
                  error,
                }),
              );
            }
          }
        });
      init.signal?.throwIfAborted();
      init.signal?.addEventListener("abort", abort, { once: true });
      const data = requireTextRequestBody(init.body);
      const result = await bridge.requestAgent({
        method: (init.method ?? "GET").toUpperCase(),
        path: relativePath,
        expectedOrigin: target.origin,
        expectedBase: status.agentBase,
        headers: headersToRecord(init.headers),
        ...(data == null ? {} : { body: data }),
        requestId,
        stream,
      });
      init.signal?.throwIfAborted();
      const emptyBody = [204, 205, 304].includes(result.status);
      if (stream && result.streamed && !emptyBody)
        return new Response(body, {
          status: result.status,
          headers: result.headers,
        });
      if (!done) controller.current?.close();
      done = true;
      await finish();
      return new Response(emptyBody ? null : result.data, {
        status: result.status,
        headers: result.headers,
      });
    } catch (error) {
      done = true;
      try {
        await cancelNative();
      } catch (cancellation) {
        throw new AggregateError(
          [error, cancellation],
          "Native Clock request and cancellation failed",
        );
      }
      throw error;
    }
  },
};
export function clockAgentRelativePath(
  url: string,
  base: string,
): string | null {
  const target = new URL(url);
  const selected = new URL(base);
  const prefix = selected.pathname.replace(/\/+$/, "");
  if (
    target.origin !== selected.origin ||
    !target.pathname.startsWith(`${prefix}/`)
  )
    return null;
  const path = target.pathname.slice(prefix.length);
  return path === "/api/chat" ||
    path === "/api/conversations" ||
    /^\/api\/conversations\/[-A-Za-z0-9_]+\/(messages(?:\/stream)?|greeting)$/.test(
      path,
    )
    ? path + target.search
    : null;
}
export async function nativeClockTransportForUrl(
  url: string,
  init?: RequestInit,
): Promise<AgentRequestTransport | null> {
  if (!bridge || !clockRequestUnbound(init)) return null;
  const status = nativeStatus(await bridge.getStatus());
  return status.supported &&
    status.agentBase &&
    clockAgentRelativePath(url, status.agentBase) !== null
    ? transport
    : null;
}

/** Prior device authority belongs to its existing transport, even when revoked
 * or malformed. Clock never interprets it, retries it, or substitutes enrollment. */
function clockRequestUnbound(init: RequestInit = {}): boolean {
  const headers = new Headers(init.headers);
  if ([...headers.keys()].some((key) => key.startsWith("x-eliza-device-")))
    return false;
  if (init.body == null) return true;
  const text = bodyToString(init.body);
  if (typeof text !== "string") return false;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isObject(body)) return false;
  if (!Object.hasOwn(body, "metadata")) return true;
  return (
    isObject(body.metadata) && !Object.hasOwn(body.metadata, "clientDevice")
  );
}
