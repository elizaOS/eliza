/** Closed, privacy-safe continuity evidence for the real Cloud UI lane. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CloudLiveDedicatedConfirmationKind } from "./cloud-live-optional-action";

const LANE = "app-live-e2e-cloud-staging";

const DIRECT_AGENTS = "/api/v1/eliza/agents";
const DIRECT_COMPAT_AGENTS = "/api/compat/agents";
const COMPAT_PROXY_AGENTS = "/api/cloud/compat/agents";
const V1_PROXY_AGENTS = "/api/cloud/v1/eliza/agents";
const LEGACY_CLOUD_AGENTS = "/api/cloud/agents";

export type ForbiddenAgentMutation =
  | "create"
  | "provision"
  | "upgrade-tier"
  | "upgrade-tier-cutover"
  | "delete";

export interface CloudLiveRuntimeBinding {
  /** Private Personal Eliza identity. Never serialize this value. */
  personalIdentity: string;
  /** Private runtime binding. Never serialize this value. */
  runtimeBinding: string;
  runtime: "shared" | "dedicated";
  /** Private runtime adapter base. Never serialize this value. */
  apiBase: string;
}

export interface CloudLiveBindingReuse {
  personalIdentityReused: boolean;
  runtimeBindingReused: boolean;
  apiBaseReused: boolean;
}

export interface CloudLiveHistoryObservation {
  historyGetSucceeded: boolean;
  challengeUserLinePresent: boolean;
  challengeAssistantLinePresent: boolean;
}

export interface CloudLiveBoundedResponseBody {
  /** Response media type only. Headers and response URLs must not be retained. */
  contentType: string | null | undefined;
  /**
   * Return at most maxBytes, or null when the response cannot be read within
   * that budget. The audit checks the returned size again before parsing.
   */
  read(maxBytes: number): Promise<Uint8Array | null>;
}

export interface CloudLiveNetworkAuditSnapshot {
  forbiddenAgentMutationCount: number;
  chatSendAttemptCount: number;
  logicalChatSendCount: number;
  unidentifiedChatSendAttemptCount: number;
  namedWarmingResponseCount: number;
  successfulChatSendResponseCount: number;
  clientErrorChatSendResponseCount: number;
  serverErrorChatSendResponseCount: number;
  otherChatSendResponseCount: number;
  personalIdentityGetRequestCount: number;
  successfulPersonalIdentityGetCount: number;
  clientErrorPersonalIdentityGetResponseCount: number;
  serverErrorPersonalIdentityGetResponseCount: number;
  otherPersonalIdentityGetResponseCount: number;
  failedPersonalIdentityGetRequestCount: number;
  pendingPersonalIdentityGetRequestCount: number;
  completedPersonalIdentityResponseBodyCount: number;
  parsedPersonalIdentityResponseBodyCount: number;
  decodedSharedPersonalIdentityResponseCount: number;
  decodedDedicatedPersonalIdentityResponseCount: number;
  uninspectablePersonalIdentityResponseBodyCount: number;
  dedicatedQuoteGetRequestCount: number;
  successfulDedicatedQuoteGetResponseCount: number;
  clientErrorDedicatedQuoteGetResponseCount: number;
  serverErrorDedicatedQuoteGetResponseCount: number;
  otherDedicatedQuoteGetResponseCount: number;
  failedDedicatedQuoteGetRequestCount: number;
  pendingDedicatedQuoteGetRequestCount: number;
  completedDedicatedQuoteResponseBodyCount: number;
  parsedDedicatedQuoteResponseBodyCount: number;
  decodedDedicatedQuoteResponseCount: number;
  uninspectableDedicatedQuoteResponseBodyCount: number;
  dedicatedActivationPostRequestCount: number;
  successfulDedicatedActivationPostResponseCount: number;
  clientErrorDedicatedActivationPostResponseCount: number;
  serverErrorDedicatedActivationPostResponseCount: number;
  otherDedicatedActivationPostResponseCount: number;
  failedDedicatedActivationPostRequestCount: number;
  pendingDedicatedActivationPostRequestCount: number;
  completedDedicatedActivationResponseBodyCount: number;
  parsedDedicatedActivationResponseBodyCount: number;
  decodedDedicatedActivationReceiptCount: number;
  uninspectableDedicatedActivationResponseBodyCount: number;
  dedicatedActivationResponseStatus: number | null;
  dedicatedActivationResponseCode: string | null;
  dedicatedCutoverPostRequestCount: number;
  successfulDedicatedCutoverPostResponseCount: number;
  clientErrorDedicatedCutoverPostResponseCount: number;
  serverErrorDedicatedCutoverPostResponseCount: number;
  otherDedicatedCutoverPostResponseCount: number;
  failedDedicatedCutoverPostRequestCount: number;
  pendingDedicatedCutoverPostRequestCount: number;
  completedDedicatedCutoverResponseBodyCount: number;
  parsedDedicatedCutoverResponseBodyCount: number;
  decodedDedicatedCutoverPendingResponseCount: number;
  decodedDedicatedCutoverFinalResponseCount: number;
  uninspectableDedicatedCutoverResponseBodyCount: number;
  dedicatedAdoptionQuoteGetRequestCount: number;
  successfulDedicatedAdoptionQuoteGetResponseCount: number;
  clientErrorDedicatedAdoptionQuoteGetResponseCount: number;
  serverErrorDedicatedAdoptionQuoteGetResponseCount: number;
  otherDedicatedAdoptionQuoteGetResponseCount: number;
  failedDedicatedAdoptionQuoteGetRequestCount: number;
  pendingDedicatedAdoptionQuoteGetRequestCount: number;
  completedDedicatedAdoptionQuoteResponseBodyCount: number;
  parsedDedicatedAdoptionQuoteResponseBodyCount: number;
  decodedAdoptableDedicatedAdoptionQuoteCount: number;
  decodedUnavailableDedicatedAdoptionQuoteCount: number;
  uninspectableDedicatedAdoptionQuoteResponseBodyCount: number;
  dedicatedAdoptionConfirmationPostRequestCount: number;
  dedicatedApprovalBindingPresent: boolean;
  dedicatedLifecycleBindingMismatchCount: number;
  historyGetRequestCount: number;
  successfulHistoryGetCount: number;
  clientErrorHistoryGetResponseCount: number;
  serverErrorHistoryGetResponseCount: number;
  otherHistoryGetResponseCount: number;
  failedHistoryGetRequestCount: number;
  timedOutHistoryGetRequestCount: number;
  pendingHistoryGetRequestCount: number;
  inspectedHistoryResponseCount: number;
  uninspectableHistoryResponseCount: number;
  historyResponseWithAnchorUserCount: number;
  historyResponseWithAnchoredAssistantCount: number;
}

export interface CloudLiveHistoryNetworkDiagnostics {
  schemaVersion: 1;
  phase: "post-reload" | "fresh-context";
  proofTimeoutCount: 1;
  historyGetRequestCount: number;
  successfulHistoryGetResponseCount: number;
  clientErrorHistoryGetResponseCount: number;
  serverErrorHistoryGetResponseCount: number;
  otherHistoryGetResponseCount: number;
  failedHistoryGetRequestCount: number;
  timedOutHistoryGetRequestCount: number;
  pendingHistoryGetRequestCount: number;
  inspectedHistoryResponseCount: number;
  uninspectableHistoryResponseCount: number;
  historyResponseWithAnchorUserCount: number;
  historyResponseWithAnchoredAssistantCount: number;
}

export interface CloudLiveNamedWarmingModeInput {
  required: boolean;
  deployedRenderer: boolean;
  cloudEnvironment: string;
}

export interface CloudLiveNamedWarmingProofInput {
  required: boolean;
  terminalLivenessPassed: boolean;
  chatSendAttemptCount: number;
  logicalChatSendCount: number;
  unidentifiedChatSendAttemptCount: number;
  namedWarmingResponseCount: number;
  retryChipEverObserved: boolean;
}

export interface CloudLiveContinuityEvidenceInput {
  challengeTurnCount: number;
  noAdditionalChatSendAfterChallenge: boolean;
  personalIdentityEndpointPassed: boolean;
  reload: CloudLiveHistoryObservation;
  freshContext: CloudLiveHistoryObservation & {
    createdWithoutStorageState: boolean;
    serviceWorkersBlocked: boolean;
  };
  bindingReuse: CloudLiveBindingReuse;
  dedicatedMutationProof: CloudLiveDedicatedMutationProofInput;
  cleanupDisposition: "no-test-owned-agent";
  conversationHistoryDisposition: "preserved";
}

export interface CloudLiveDedicatedMutationProofInput {
  approvalGrantedCount: 0 | 1;
  confirmationClickCount: number;
  confirmationKind: CloudLiveDedicatedConfirmationKind;
  adoptionConfirmationPostCount: number;
  activationPostCount: number;
  cutoverPostCount: number;
  forbiddenAgentMutationCount: number;
  approvalBindingPresent: boolean;
  lifecycleBindingMismatchCount: number;
}

type CloudLiveDedicatedApprovalDisposition =
  | "not-approved"
  | "approval-unused"
  | "approved-ui-confirmation";

interface CloudLiveDedicatedMutationEvidence {
  dedicatedApprovalDisposition: CloudLiveDedicatedApprovalDisposition;
  dedicatedApprovalGrantedCount: 0 | 1;
  dedicatedConfirmationKind: CloudLiveDedicatedConfirmationKind;
  dedicatedConfirmationClickCount: 0 | 1;
  dedicatedAdoptionConfirmationPostCount: 0 | 1;
  dedicatedActivationPostCount: 0 | 1;
  dedicatedCutoverPostCount: number;
  forbiddenAgentMutationCount: number;
  otherForbiddenAgentMutationCount: 0;
  dedicatedApprovalBindingPresent: boolean;
  dedicatedLifecycleBindingMismatchCount: 0;
}

export interface CloudLiveDedicatedApprovalBinding {
  confirmationKind: Exclude<CloudLiveDedicatedConfirmationKind, "none">;
  sourceAgentId: string;
  quoteId: string;
  dedicatedAgentId: string | null;
}

const VERIFIED_EVIDENCE_BASE = {
  schemaVersion: 2,
  lane: LANE,
  challengeTurnCount: 1,
  noAdditionalChatSendAfterChallenge: true,
  personalIdentityEndpointPassed: true,
  reloadHistoryPassed: true,
  freshContextHistoryPassed: true,
  personalIdentityReused: true,
  runtimeBindingReused: true,
  apiBaseReused: true,
  cleanupDisposition: "no-test-owned-agent",
  conversationHistoryDisposition: "preserved",
} as const;

export type CloudLiveContinuityEvidence = typeof VERIFIED_EVIDENCE_BASE &
  CloudLiveDedicatedMutationEvidence;

function fail(message: string): never {
  throw new Error(`[cloud-live-continuity] ${message}`);
}

function requestPath(rawUrl: string): string {
  try {
    const pathname = new URL(rawUrl, "https://cloud-live.invalid").pathname;
    return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  } catch {
    return "";
  }
}

/**
 * Exact forbidden set for this read-only lane. Agent chat and every other
 * agent-scoped operation intentionally fall through.
 */
export function classifyForbiddenAgentMutation(
  method: string,
  rawUrl: string,
): ForbiddenAgentMutation | null {
  const verb = method.trim().toUpperCase();
  const pathname = requestPath(rawUrl);
  for (const base of [DIRECT_AGENTS, V1_PROXY_AGENTS] as const) {
    if (pathname === base) return verb === "POST" ? "create" : null;
    if (!pathname.startsWith(`${base}/`)) continue;
    const target = pathname
      .slice(base.length + 1)
      .match(/^[^/]+(?:\/(provision|upgrade-tier(?:\/cutover)?))?$/);
    if (!target) return null;
    if (!target[1]) return verb === "DELETE" ? "delete" : null;
    if (verb !== "POST") return null;
    if (target[1] === "provision") return "provision";
    return target[1] === "upgrade-tier"
      ? "upgrade-tier"
      : "upgrade-tier-cutover";
  }

  for (const base of [DIRECT_COMPAT_AGENTS, COMPAT_PROXY_AGENTS] as const) {
    if (verb === "POST" && pathname === base) return "create";
    if (!pathname.startsWith(`${base}/`)) continue;
    const target = pathname.slice(base.length + 1);
    if (verb === "DELETE" && !target.includes("/")) return "delete";
    if (verb === "POST" && /^[^/]+\/launch$/.test(target)) return "provision";
  }

  if (verb === "POST" && pathname === LEGACY_CLOUD_AGENTS) return "create";
  if (verb === "POST" && pathname.startsWith(`${LEGACY_CLOUD_AGENTS}/`)) {
    const target = pathname.slice(LEGACY_CLOUD_AGENTS.length + 1);
    if (/^[^/]+\/(?:provision|connect)$/.test(target)) return "provision";
    if (/^[^/]+\/shutdown$/.test(target)) return "delete";
  }
  return null;
}

function isHistoryGet(method: string, rawUrl: string): boolean {
  return (
    method.trim().toUpperCase() === "GET" &&
    /\/api\/conversations\/[^/]+\/messages$/.test(requestPath(rawUrl))
  );
}

function monotonicDelta(name: string, before: number, after: number): number {
  if (!Number.isSafeInteger(before) || before < 0) {
    fail(`${name} baseline must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(after) || after < before) {
    fail(`${name} current value must not precede its baseline`);
  }
  return after - before;
}

function requireNonNegativeSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${name} must be a non-negative safe integer`);
  }
  return value;
}

/**
 * Reduces one timed-out history proof to aggregate counts only. Request URLs,
 * conversation identifiers, response bodies, headers, and failure text never
 * enter the returned diagnostic.
 */
export function createCloudLiveHistoryNetworkDiagnostics(
  phase: CloudLiveHistoryNetworkDiagnostics["phase"],
  before: CloudLiveNetworkAuditSnapshot,
  after: CloudLiveNetworkAuditSnapshot,
): CloudLiveHistoryNetworkDiagnostics {
  const historyGetRequestCount = monotonicDelta(
    "historyGetRequestCount",
    before.historyGetRequestCount,
    after.historyGetRequestCount,
  );
  const successfulHistoryGetResponseCount = monotonicDelta(
    "successfulHistoryGetCount",
    before.successfulHistoryGetCount,
    after.successfulHistoryGetCount,
  );
  const clientErrorHistoryGetResponseCount = monotonicDelta(
    "clientErrorHistoryGetResponseCount",
    before.clientErrorHistoryGetResponseCount,
    after.clientErrorHistoryGetResponseCount,
  );
  const serverErrorHistoryGetResponseCount = monotonicDelta(
    "serverErrorHistoryGetResponseCount",
    before.serverErrorHistoryGetResponseCount,
    after.serverErrorHistoryGetResponseCount,
  );
  const otherHistoryGetResponseCount = monotonicDelta(
    "otherHistoryGetResponseCount",
    before.otherHistoryGetResponseCount,
    after.otherHistoryGetResponseCount,
  );
  const failedHistoryGetRequestCount = monotonicDelta(
    "failedHistoryGetRequestCount",
    before.failedHistoryGetRequestCount,
    after.failedHistoryGetRequestCount,
  );
  const timedOutHistoryGetRequestCount = monotonicDelta(
    "timedOutHistoryGetRequestCount",
    before.timedOutHistoryGetRequestCount,
    after.timedOutHistoryGetRequestCount,
  );
  requireNonNegativeSafeInteger(
    "pendingHistoryGetRequestCount baseline",
    before.pendingHistoryGetRequestCount,
  );
  const pendingHistoryGetRequestCount = requireNonNegativeSafeInteger(
    "pendingHistoryGetRequestCount current value",
    after.pendingHistoryGetRequestCount,
  );
  const inspectedHistoryResponseCount = monotonicDelta(
    "inspectedHistoryResponseCount",
    before.inspectedHistoryResponseCount,
    after.inspectedHistoryResponseCount,
  );
  const uninspectableHistoryResponseCount = monotonicDelta(
    "uninspectableHistoryResponseCount",
    before.uninspectableHistoryResponseCount,
    after.uninspectableHistoryResponseCount,
  );
  const historyResponseWithAnchorUserCount = monotonicDelta(
    "historyResponseWithAnchorUserCount",
    before.historyResponseWithAnchorUserCount,
    after.historyResponseWithAnchorUserCount,
  );
  const historyResponseWithAnchoredAssistantCount = monotonicDelta(
    "historyResponseWithAnchoredAssistantCount",
    before.historyResponseWithAnchoredAssistantCount,
    after.historyResponseWithAnchoredAssistantCount,
  );
  return {
    schemaVersion: 1,
    phase,
    proofTimeoutCount: 1,
    historyGetRequestCount,
    successfulHistoryGetResponseCount,
    clientErrorHistoryGetResponseCount,
    serverErrorHistoryGetResponseCount,
    otherHistoryGetResponseCount,
    failedHistoryGetRequestCount,
    timedOutHistoryGetRequestCount,
    pendingHistoryGetRequestCount,
    inspectedHistoryResponseCount,
    uninspectableHistoryResponseCount,
    historyResponseWithAnchorUserCount,
    historyResponseWithAnchoredAssistantCount,
  };
}

function chatSendScope(method: string, rawUrl: string): string {
  if (method.trim().toUpperCase() !== "POST") return "";
  try {
    const parsed = new URL(rawUrl, "https://cloud-live.invalid");
    const pathname = requestPath(rawUrl);
    if (!/\/api\/conversations\/[^/]+\/messages(?:\/stream)?$/.test(pathname)) {
      return "";
    }
    return `${parsed.origin}${pathname.replace(/\/stream$/, "")}`;
  } catch {
    return "";
  }
}

function isPersonalIdentityGet(method: string, rawUrl: string): boolean {
  return (
    method.trim().toUpperCase() === "GET" &&
    requestPath(rawUrl) === "/api/v1/eliza/personal"
  );
}

type DedicatedControlPlaneRequest = "quote" | "activation" | "cutover";

function dedicatedControlPlaneRequest(
  method: string,
  rawUrl: string,
): DedicatedControlPlaneRequest | null {
  const verb = method.trim().toUpperCase();
  const pathname = requestPath(rawUrl);
  const match = pathname.match(
    /^\/api\/(?:cloud\/)?v1\/eliza\/agents\/[^/]+\/upgrade-tier(\/cutover)?$/,
  );
  if (!match) return null;
  if (match[1]) return verb === "POST" ? "cutover" : null;
  if (verb === "GET") return "quote";
  return verb === "POST" ? "activation" : null;
}

function dedicatedAdoptionRequest(
  method: string,
  rawUrl: string,
): "quote" | "confirmation" | null {
  const pathname = requestPath(rawUrl);
  if (
    !/^\/api\/(?:cloud\/)?v1\/eliza\/agents\/[^/]+\/upgrade-tier\/adopt-existing$/.test(
      pathname,
    )
  ) {
    return null;
  }
  const verb = method.trim().toUpperCase();
  if (verb === "GET") return "quote";
  return verb === "POST" ? "confirmation" : null;
}

type DedicatedLifecycleRequest = "adoption" | "activation" | "cutover";

interface DedicatedLifecycleRequestBinding {
  phase: DedicatedLifecycleRequest;
  sourceAgentId: string;
  quoteId: string | null;
  dedicatedAgentId: string | null;
  responseStatus: number | null;
  responseCode: string | null;
}

function dedicatedRequestSourceAgentId(rawUrl: string): string {
  const match = requestPath(rawUrl).match(
    /^\/api\/(?:cloud\/)?v1\/eliza\/agents\/([^/]+)\/upgrade-tier(?:\/cutover|\/adopt-existing)?$/,
  );
  if (!match?.[1]) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // error-policy:J3 an invalid encoded path segment has no usable identity
    // and therefore cannot satisfy the lifecycle correlation gate.
    return "";
  }
}

function requestBodyRecord(
  postData: string | null | undefined,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(postData ?? "") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // error-policy:J3 malformed lifecycle JSON is an explicit missing binding
    // and contributes a mismatch in the closed terminal proof.
    return null;
  }
}

function dedicatedLifecycleRequestBinding(
  method: string,
  rawUrl: string,
  postData: string | null | undefined,
): DedicatedLifecycleRequestBinding | null {
  if (method.trim().toUpperCase() !== "POST") return null;
  const sourceAgentId = dedicatedRequestSourceAgentId(rawUrl);
  if (!sourceAgentId) return null;
  const body = requestBodyRecord(postData);
  if (dedicatedAdoptionRequest(method, rawUrl) === "confirmation") {
    return {
      phase: "adoption",
      sourceAgentId,
      quoteId: typeof body?.quoteId === "string" ? body.quoteId.trim() : null,
      dedicatedAgentId: null,
      responseStatus: null,
      responseCode: null,
    };
  }
  const controlPlane = dedicatedControlPlaneRequest(method, rawUrl);
  if (controlPlane === "activation") {
    return {
      phase: "activation",
      sourceAgentId,
      quoteId: typeof body?.quoteId === "string" ? body.quoteId.trim() : null,
      dedicatedAgentId: null,
      responseStatus: null,
      responseCode: null,
    };
  }
  if (controlPlane === "cutover") {
    return {
      phase: "cutover",
      sourceAgentId,
      quoteId: null,
      dedicatedAgentId:
        typeof body?.dedicatedAgentId === "string"
          ? body.dedicatedAgentId.trim()
          : null,
      responseStatus: null,
      responseCode: null,
    };
  }
  return null;
}

function chatClientMessageId(postData: string | null | undefined): string {
  try {
    const parsed = JSON.parse(postData ?? "") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return "";
    const clientMessageId = (parsed as Record<string, unknown>).clientMessageId;
    return typeof clientMessageId === "string" && clientMessageId.length > 0
      ? clientMessageId
      : "";
  } catch {
    return "";
  }
}

const NAMED_WARMING_CODES = new Set([
  "agent_cache_warming",
  "shared_runtime_cache_warming",
]);
const MAX_WARMING_RESPONSE_BYTES = 4 * 1024;
const MAX_PERSONAL_IDENTITY_RESPONSE_BYTES = 64 * 1024;
const MAX_HISTORY_RESPONSE_BYTES = 1024 * 1024;
const RESPONSE_BODY_AUDIT_TIMEOUT_MS = 30_000;

function isJsonContentType(contentType: string | null | undefined): boolean {
  return (
    contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
  );
}

/**
 * Keeps diagnostic body inspection subordinate to the browser trajectory's
 * phase deadline. Playwright can report response headers while its body promise
 * remains pending forever; awaiting that promise directly would prevent the
 * surrounding `expect.poll` timeout from ever adjudicating the real UI proof.
 */
export async function readCloudLiveBoundedResponseBody(
  responseBody: CloudLiveBoundedResponseBody,
  maxBytes: number,
  timeoutMs = RESPONSE_BODY_AUDIT_TIMEOUT_MS,
): Promise<Uint8Array | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    fail("response body byte budget must be a positive safe integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    fail("response body timeout must be a positive safe integer");
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const bytes = await Promise.race([
      responseBody.read(maxBytes).catch(() => null),
      new Promise<null>((resolveTimeout) => {
        timeoutId = setTimeout(resolveTimeout, timeoutMs, null);
      }),
    ]);
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
      return null;
    }
    return bytes;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function isNamedWarmingResponse(
  responseBody: CloudLiveBoundedResponseBody,
): Promise<boolean> {
  if (!isJsonContentType(responseBody.contentType)) return false;
  const bytes = await readCloudLiveBoundedResponseBody(
    responseBody,
    MAX_WARMING_RESPONSE_BYTES,
  );
  if (!bytes) return false;
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return false;
    const code = (parsed as Record<string, unknown>).code;
    return typeof code === "string" && NAMED_WARMING_CODES.has(code);
  } catch {
    // error-policy:J3 malformed or non-UTF-8 diagnostic bodies are simply not
    // named warming proof; the real browser response remains authoritative.
    return false;
  }
}

interface PersonalIdentityResponseInspection {
  bodyCompleted: boolean;
  parsed: boolean;
  runtime: "shared" | "dedicated" | null;
}

/**
 * Reduces the Personal identity response to completion/parse/runtime counters.
 * IDs, display names, API bases, response text, headers, and URLs never leave
 * this function.
 */
async function inspectPersonalIdentityResponse(
  responseBody: CloudLiveBoundedResponseBody,
): Promise<PersonalIdentityResponseInspection> {
  const unavailable = {
    bodyCompleted: false,
    parsed: false,
    runtime: null,
  } as const;
  if (!isJsonContentType(responseBody.contentType)) return unavailable;
  const bytes = await readCloudLiveBoundedResponseBody(
    responseBody,
    MAX_PERSONAL_IDENTITY_RESPONSE_BYTES,
  );
  if (!bytes) return unavailable;
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { bodyCompleted: true, parsed: true, runtime: null };
    }
    const data = (parsed as Record<string, unknown>).data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { bodyCompleted: true, parsed: true, runtime: null };
    }
    const identity = (data as Record<string, unknown>).identity;
    if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
      return { bodyCompleted: true, parsed: true, runtime: null };
    }
    const runtime = (identity as Record<string, unknown>).runtime;
    return {
      bodyCompleted: true,
      parsed: true,
      runtime: runtime === "shared" || runtime === "dedicated" ? runtime : null,
    };
  } catch {
    // error-policy:J3 malformed/non-UTF-8 response bodies remain a closed
    // parsed=false result; no body content is retained or surfaced.
    return { bodyCompleted: true, parsed: false, runtime: null };
  }
}

interface DedicatedControlPlaneResponseInspection {
  bodyCompleted: boolean;
  parsed: boolean;
  decoded: boolean;
  pending: boolean;
  final: boolean;
  quoteId: string | null;
  dedicatedAgentId: string | null;
  code: string | null;
}

function boundedDedicatedResponseCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim();
  return /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : null;
}

async function inspectDedicatedControlPlaneResponse(
  phase: DedicatedControlPlaneRequest,
  status: number,
  responseBody: CloudLiveBoundedResponseBody,
): Promise<DedicatedControlPlaneResponseInspection> {
  const unavailable = {
    bodyCompleted: false,
    parsed: false,
    decoded: false,
    pending: false,
    final: false,
    quoteId: null,
    dedicatedAgentId: null,
    code: null,
  } as const;
  if (!isJsonContentType(responseBody.contentType)) return unavailable;
  const bytes = await readCloudLiveBoundedResponseBody(
    responseBody,
    MAX_PERSONAL_IDENTITY_RESPONSE_BYTES,
  );
  if (!bytes) return unavailable;
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        bodyCompleted: true,
        parsed: true,
        decoded: false,
        pending: false,
        final: false,
        quoteId: null,
        dedicatedAgentId: null,
        code: null,
      };
    }
    const root = parsed as Record<string, unknown>;
    const code = boundedDedicatedResponseCode(root.code);
    const data = root.data;
    const dataRecord =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : null;
    if (phase === "quote") {
      const activation = dataRecord?.activation;
      const activationRecord =
        activation &&
        typeof activation === "object" &&
        !Array.isArray(activation)
          ? (activation as Record<string, unknown>)
          : null;
      const state = activationRecord?.state;
      return {
        bodyCompleted: true,
        parsed: true,
        decoded:
          status >= 200 &&
          status < 300 &&
          root.success === true &&
          typeof dataRecord?.quoteId === "string" &&
          (state === "available" || state === "in_progress"),
        pending: false,
        final: false,
        quoteId:
          typeof dataRecord?.quoteId === "string"
            ? dataRecord.quoteId.trim() || null
            : null,
        dedicatedAgentId:
          typeof activationRecord?.dedicatedAgentId === "string"
            ? activationRecord.dedicatedAgentId.trim() || null
            : null,
        code,
      };
    }
    if (phase === "activation") {
      return {
        bodyCompleted: true,
        parsed: true,
        decoded:
          status >= 200 &&
          status < 300 &&
          root.success === true &&
          typeof dataRecord?.dedicatedAgentId === "string",
        pending: false,
        final: false,
        quoteId: null,
        dedicatedAgentId:
          typeof dataRecord?.dedicatedAgentId === "string"
            ? dataRecord.dedicatedAgentId.trim() || null
            : null,
        code,
      };
    }
    const pending =
      (status === 409 || status === 423 || status === 503) &&
      root.success === false;
    const final =
      status >= 200 &&
      status < 300 &&
      root.success === true &&
      dataRecord?.runtime === "dedicated";
    return {
      bodyCompleted: true,
      parsed: true,
      decoded: pending || final,
      pending,
      final,
      quoteId: null,
      dedicatedAgentId: null,
      code,
    };
  } catch {
    // error-policy:J3 malformed, non-UTF-8, oversized, or unreadable control-
    // plane bodies provide no quote/activation/cutover proof; the browser
    // response remains authoritative and no body content is retained.
    return {
      bodyCompleted: true,
      parsed: false,
      decoded: false,
      pending: false,
      final: false,
      quoteId: null,
      dedicatedAgentId: null,
      code: null,
    };
  }
}

interface DedicatedAdoptionQuoteResponseInspection {
  bodyCompleted: boolean;
  parsed: boolean;
  disposition: "adoptable" | "unavailable" | null;
}

/** Reduces an adoption quote to outcome counters without retaining its quote or target. */
async function inspectDedicatedAdoptionQuoteResponse(
  status: number,
  responseBody: CloudLiveBoundedResponseBody,
): Promise<DedicatedAdoptionQuoteResponseInspection> {
  const unavailable = {
    bodyCompleted: false,
    parsed: false,
    disposition: null,
  } as const;
  if (!isJsonContentType(responseBody.contentType)) return unavailable;
  const bytes = await readCloudLiveBoundedResponseBody(
    responseBody,
    MAX_PERSONAL_IDENTITY_RESPONSE_BYTES,
  );
  if (!bytes) return unavailable;
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { bodyCompleted: true, parsed: true, disposition: null };
    }
    const root = parsed as Record<string, unknown>;
    const data = root.data;
    const quote =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : null;
    const code = typeof root.code === "string" ? root.code : "";
    const disposition =
      status >= 200 &&
      status < 300 &&
      root.success === true &&
      quote?.requiresConfirmation === true &&
      quote.action === "adopt_existing_dedicated" &&
      quote.canAdopt === true
        ? "adoptable"
        : quote?.canAdopt === false ||
            code === "dedicated_adoption_unavailable" ||
            code === "dedicated_adoption_ambiguous" ||
            code === "dedicated_adoption_catalog_restore_required"
          ? "unavailable"
          : null;
    return { bodyCompleted: true, parsed: true, disposition };
  } catch {
    // error-policy:J3 malformed/non-UTF-8 bodies remain a closed parsed=false
    // result; no response content is retained or surfaced.
    return { bodyCompleted: true, parsed: false, disposition: null };
  }
}

interface HistoryAnchorInspection {
  inspected: boolean;
  anchorUserPresent: boolean;
  anchoredAssistantPresent: boolean;
}

async function inspectHistoryAnchor(
  responseBody: CloudLiveBoundedResponseBody,
  anchorToken: string,
): Promise<HistoryAnchorInspection> {
  const unavailable = {
    inspected: false,
    anchorUserPresent: false,
    anchoredAssistantPresent: false,
  };
  if (!isJsonContentType(responseBody.contentType)) return unavailable;
  try {
    const bytes = await readCloudLiveBoundedResponseBody(
      responseBody,
      MAX_HISTORY_RESPONSE_BYTES,
    );
    if (!bytes) return unavailable;
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return unavailable;
    }
    const messages = (parsed as Record<string, unknown>).messages;
    if (!Array.isArray(messages)) return unavailable;
    const normalizedAnchor = anchorToken.trim().toLowerCase();
    let anchorUserIndex = -1;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        continue;
      }
      const record = message as Record<string, unknown>;
      if (
        record.role === "user" &&
        typeof record.text === "string" &&
        record.text.toLowerCase().includes(normalizedAnchor)
      ) {
        anchorUserIndex = index;
        break;
      }
    }
    let anchoredAssistantPresent = false;
    for (
      let index = anchorUserIndex >= 0 ? anchorUserIndex + 1 : messages.length;
      index < messages.length;
      index += 1
    ) {
      const message = messages[index];
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        continue;
      }
      const record = message as Record<string, unknown>;
      if (record.role === "user") break;
      if (
        record.role === "assistant" &&
        typeof record.text === "string" &&
        record.text.trim().length > 0
      ) {
        anchoredAssistantPresent = true;
        break;
      }
    }
    return {
      inspected: true,
      anchorUserPresent: anchorUserIndex >= 0,
      anchoredAssistantPresent,
    };
  } catch {
    // error-policy:J3 malformed, non-UTF-8, oversized, or unreadable history
    // bodies provide no anchor proof; the browser response remains authoritative.
    return unavailable;
  }
}

export function assertCloudLiveNamedWarmingMode(
  input: CloudLiveNamedWarmingModeInput,
): void {
  if (!input.required) return;
  if (!input.deployedRenderer) {
    fail("named warming proof requires a deployed renderer");
  }
  if (input.cloudEnvironment !== "staging") {
    fail("named warming proof requires the staging Cloud environment");
  }
}

export function assertCloudLiveNamedWarmingProof(
  input: CloudLiveNamedWarmingProofInput,
): void {
  if (!input.required) return;
  requireTrue(
    input.terminalLivenessPassed,
    "namedWarming.terminalLivenessPassed",
  );
  if (input.chatSendAttemptCount <= 1) {
    fail("namedWarming.chatSendAttemptCount must be greater than one");
  }
  if (input.logicalChatSendCount !== 1) {
    fail("namedWarming.logicalChatSendCount must be one");
  }
  if (input.unidentifiedChatSendAttemptCount !== 0) {
    fail("namedWarming.unidentifiedChatSendAttemptCount must be zero");
  }
  if (input.namedWarmingResponseCount <= 0) {
    fail("namedWarming.namedWarmingResponseCount must be greater than zero");
  }
  if (input.retryChipEverObserved) {
    fail("namedWarming.retryChipEverObserved must be false");
  }
}

/**
 * Observe the assistant row owned by one anchored user turn. Mutation records,
 * not just the final DOM, close the add-then-remove gap for a transient Retry
 * chip. Kept closure-free so Playwright can serialize it into the page.
 */
export function installCloudLiveAnchoredRetryChipObserver(
  turnAnchorToken: string,
  rootDocument: Document = document,
): { stop(): boolean } {
  const rowSelector = '[data-testid="thread-line"]';
  const retrySelector = '[data-testid="thread-line-retry"]';
  const normalizedAnchor = turnAnchorToken.trim().toLowerCase();
  if (!normalizedAnchor) {
    throw new Error("[cloud-live-continuity] turn anchor must not be empty");
  }
  const view = rootDocument.defaultView;
  if (!view) {
    throw new Error("[cloud-live-continuity] document view is unavailable");
  }
  let retryChipEverObserved = false;
  let lastOwner: Element | null = null;

  const anchoredRows = (): [HTMLElement | null, HTMLElement | null] => {
    const rows = Array.from(
      rootDocument.querySelectorAll<HTMLElement>(rowSelector),
    );
    const userIndex = rows.findIndex(
      (row) =>
        row.dataset.role === "user" &&
        (row.textContent ?? "").toLowerCase().includes(normalizedAnchor),
    );
    if (userIndex < 0) return [null, null];
    for (let index = userIndex + 1; index < rows.length; index += 1) {
      const row = rows[index];
      if (row.dataset.role === "user") break;
      if (row.dataset.role === "assistant") return [rows[userIndex], row];
    }
    return [rows[userIndex], null];
  };

  const containsRetryChip = (node: Node): boolean =>
    node instanceof view.Element &&
    (node.matches(retrySelector) || Boolean(node.querySelector(retrySelector)));

  const lastRowAtOrBefore = (node: Node | null): Element | null => {
    for (let cursor = node; cursor; cursor = cursor.previousSibling) {
      if (!(cursor instanceof view.Element)) continue;
      if (cursor.matches(rowSelector)) return cursor;
      const nestedRows = cursor.querySelectorAll(rowSelector);
      if (nestedRows.length > 0) return nestedRows[nestedRows.length - 1];
    }
    return null;
  };

  const inspect = (records: readonly MutationRecord[] = []) => {
    if (retryChipEverObserved) return;
    const [anchor, currentOwner] = anchoredRows();
    if (!anchor) return;
    if (currentOwner) lastOwner = currentOwner;
    if (currentOwner?.querySelector(retrySelector)) {
      retryChipEverObserved = true;
      return;
    }

    const candidates = new Set<Element>();
    if (currentOwner) candidates.add(currentOwner);
    if (lastOwner) candidates.add(lastOwner);
    for (const record of records) {
      let followsAnchor = lastRowAtOrBefore(record.previousSibling) === anchor;
      for (const addedNode of record.addedNodes) {
        if (!(addedNode instanceof view.Element)) continue;
        const addedRows = addedNode.matches(rowSelector)
          ? [addedNode]
          : [...addedNode.querySelectorAll(rowSelector)];
        for (const row of addedRows) {
          if (row === anchor) {
            followsAnchor = true;
          } else if (row.getAttribute("data-role") === "user") {
            followsAnchor = false;
          } else if (
            followsAnchor &&
            row.getAttribute("data-role") === "assistant"
          ) {
            candidates.add(row);
            lastOwner = row;
            followsAnchor = false;
          }
        }
      }
    }
    if ([...candidates].some(containsRetryChip)) {
      retryChipEverObserved = true;
      return;
    }

    for (const record of records) {
      const mutationNodes = [...record.addedNodes, ...record.removedNodes];
      const target =
        record.target instanceof view.Element
          ? record.target
          : record.target.parentElement;
      const targetRow = target?.closest(rowSelector);
      if (
        targetRow &&
        candidates.has(targetRow) &&
        (mutationNodes.some(containsRetryChip) ||
          (record.attributeName === "data-testid" &&
            record.oldValue === "thread-line-retry"))
      ) {
        retryChipEverObserved = true;
        return;
      }
    }
  };

  const observer = new view.MutationObserver(inspect);
  observer.observe(rootDocument.documentElement, {
    attributeOldValue: true,
    attributes: true,
    attributeFilter: ["data-role", "data-testid"],
    characterData: true,
    childList: true,
    subtree: true,
  });
  inspect();
  return {
    stop() {
      inspect(observer.takeRecords());
      observer.disconnect();
      return retryChipEverObserved;
    },
  };
}

/**
 * Emits only counts while keeping lifecycle IDs in memory long enough to prove
 * every permitted request is bound to the one rendered approval.
 */
export interface CloudLiveNetworkAudit {
  observeRequest(
    method: string,
    rawUrl: string,
    postData?: string | null,
  ): void;
  observeResponse(
    method: string,
    rawUrl: string,
    status: number,
    responseBody?: CloudLiveBoundedResponseBody,
  ): void;
  observeRequestFailure(
    method: string,
    rawUrl: string,
    errorText?: string,
  ): void;
  setDedicatedApprovalBinding(binding: CloudLiveDedicatedApprovalBinding): void;
  latestDedicatedActivationApprovalBinding(): Promise<CloudLiveDedicatedApprovalBinding | null>;
  setHistoryAnchorToken(anchorToken: string): void;
  snapshot(): Promise<CloudLiveNetworkAuditSnapshot>;
}

export function createCloudLiveNetworkAudit(): CloudLiveNetworkAudit {
  let forbiddenAgentMutationCount = 0;
  let chatSendAttemptCount = 0;
  let unidentifiedChatSendAttemptCount = 0;
  const logicalChatSendIds = new Set<string>();
  let namedWarmingResponseCount = 0;
  let successfulChatSendResponseCount = 0;
  let clientErrorChatSendResponseCount = 0;
  let serverErrorChatSendResponseCount = 0;
  let otherChatSendResponseCount = 0;
  let personalIdentityGetRequestCount = 0;
  let successfulPersonalIdentityGetCount = 0;
  let clientErrorPersonalIdentityGetResponseCount = 0;
  let serverErrorPersonalIdentityGetResponseCount = 0;
  let otherPersonalIdentityGetResponseCount = 0;
  let failedPersonalIdentityGetRequestCount = 0;
  let completedPersonalIdentityResponseBodyCount = 0;
  let parsedPersonalIdentityResponseBodyCount = 0;
  let decodedSharedPersonalIdentityResponseCount = 0;
  let decodedDedicatedPersonalIdentityResponseCount = 0;
  let uninspectablePersonalIdentityResponseBodyCount = 0;
  let dedicatedAdoptionQuoteGetRequestCount = 0;
  let successfulDedicatedAdoptionQuoteGetResponseCount = 0;
  let clientErrorDedicatedAdoptionQuoteGetResponseCount = 0;
  let serverErrorDedicatedAdoptionQuoteGetResponseCount = 0;
  let otherDedicatedAdoptionQuoteGetResponseCount = 0;
  let failedDedicatedAdoptionQuoteGetRequestCount = 0;
  let completedDedicatedAdoptionQuoteResponseBodyCount = 0;
  let parsedDedicatedAdoptionQuoteResponseBodyCount = 0;
  let decodedAdoptableDedicatedAdoptionQuoteCount = 0;
  let decodedUnavailableDedicatedAdoptionQuoteCount = 0;
  let uninspectableDedicatedAdoptionQuoteResponseBodyCount = 0;
  let dedicatedAdoptionConfirmationPostRequestCount = 0;
  let dedicatedApprovalBinding: CloudLiveDedicatedApprovalBinding | null = null;
  let latestActivationQuoteBinding: CloudLiveDedicatedApprovalBinding | null =
    null;
  const dedicatedLifecycleRequests: DedicatedLifecycleRequestBinding[] = [];
  const activationReceiptTargets: Array<{
    sourceAgentId: string;
    dedicatedAgentId: string;
  }> = [];
  const dedicatedControlPlane = {
    quote: {
      request: 0,
      success: 0,
      clientError: 0,
      serverError: 0,
      other: 0,
      failed: 0,
      bodyCompleted: 0,
      parsed: 0,
      decoded: 0,
      pendingDecoded: 0,
      finalDecoded: 0,
      uninspectableBody: 0,
    },
    activation: {
      request: 0,
      success: 0,
      clientError: 0,
      serverError: 0,
      other: 0,
      failed: 0,
      bodyCompleted: 0,
      parsed: 0,
      decoded: 0,
      pendingDecoded: 0,
      finalDecoded: 0,
      uninspectableBody: 0,
    },
    cutover: {
      request: 0,
      success: 0,
      clientError: 0,
      serverError: 0,
      other: 0,
      failed: 0,
      bodyCompleted: 0,
      parsed: 0,
      decoded: 0,
      pendingDecoded: 0,
      finalDecoded: 0,
      uninspectableBody: 0,
    },
  } satisfies Record<
    DedicatedControlPlaneRequest,
    Record<
      | "request"
      | "success"
      | "clientError"
      | "serverError"
      | "other"
      | "failed"
      | "bodyCompleted"
      | "parsed"
      | "decoded"
      | "pendingDecoded"
      | "finalDecoded"
      | "uninspectableBody",
      number
    >
  >;
  let historyGetRequestCount = 0;
  let successfulHistoryGetCount = 0;
  let clientErrorHistoryGetResponseCount = 0;
  let serverErrorHistoryGetResponseCount = 0;
  let otherHistoryGetResponseCount = 0;
  let failedHistoryGetRequestCount = 0;
  let timedOutHistoryGetRequestCount = 0;
  let inspectedHistoryResponseCount = 0;
  let uninspectableHistoryResponseCount = 0;
  let historyResponseWithAnchorUserCount = 0;
  let historyResponseWithAnchoredAssistantCount = 0;
  let historyAnchorToken = "";
  const pendingResponseHandlers = new Set<Promise<void>>();

  const trackResponseHandler = (handler: () => Promise<void>) => {
    // Start on the next microtask so the promise is always registered before
    // its completion callback can remove it, including immediate test readers.
    const pending = Promise.resolve()
      .then(handler)
      .catch(() => {
        // error-policy:J3 unreadable diagnostics contribute no named-warming
        // proof and must never disturb the real browser request lifecycle.
      });
    pendingResponseHandlers.add(pending);
    void pending.then(() => pendingResponseHandlers.delete(pending));
  };

  const drainResponseHandlers = async () => {
    // A handler can schedule while an earlier body is draining. Loop until the
    // tracked set is empty so every response observed before the snapshot is
    // reduced before callers make assertions.
    while (pendingResponseHandlers.size > 0) {
      await Promise.all([...pendingResponseHandlers]);
    }
  };

  return {
    observeRequest(method, rawUrl, postData) {
      if (classifyForbiddenAgentMutation(method, rawUrl)) {
        forbiddenAgentMutationCount += 1;
      }
      const scope = chatSendScope(method, rawUrl);
      if (scope) {
        chatSendAttemptCount += 1;
        const clientMessageId = chatClientMessageId(postData);
        if (clientMessageId) {
          // Server idempotency is scoped to the runtime/conversation, not the
          // clientMessageId globally. Keep the private scope/key in memory only.
          logicalChatSendIds.add(`${scope}\u0000${clientMessageId}`);
        } else unidentifiedChatSendAttemptCount += 1;
      }
      if (isHistoryGet(method, rawUrl)) historyGetRequestCount += 1;
      if (isPersonalIdentityGet(method, rawUrl)) {
        personalIdentityGetRequestCount += 1;
      }
      const dedicatedRequest = dedicatedControlPlaneRequest(method, rawUrl);
      if (dedicatedRequest)
        dedicatedControlPlane[dedicatedRequest].request += 1;
      const adoptionRequest = dedicatedAdoptionRequest(method, rawUrl);
      if (adoptionRequest === "quote") {
        dedicatedAdoptionQuoteGetRequestCount += 1;
      } else if (adoptionRequest === "confirmation") {
        dedicatedAdoptionConfirmationPostRequestCount += 1;
      }
      const lifecycleBinding = dedicatedLifecycleRequestBinding(
        method,
        rawUrl,
        postData,
      );
      if (lifecycleBinding) dedicatedLifecycleRequests.push(lifecycleBinding);
    },
    observeResponse(method, rawUrl, status, responseBody) {
      const chatScope = chatSendScope(method, rawUrl);
      if (chatScope) {
        if (status >= 200 && status < 300) {
          successfulChatSendResponseCount += 1;
        } else if (status >= 400 && status < 500) {
          clientErrorChatSendResponseCount += 1;
        } else if (status >= 500 && status < 600) {
          serverErrorChatSendResponseCount += 1;
        } else {
          otherChatSendResponseCount += 1;
        }
        if (status === 503 && responseBody) {
          trackResponseHandler(async () => {
            if (await isNamedWarmingResponse(responseBody)) {
              namedWarmingResponseCount += 1;
            }
          });
        }
      }
      if (isHistoryGet(method, rawUrl)) {
        if (status >= 200 && status < 300) {
          successfulHistoryGetCount += 1;
          if (historyAnchorToken && responseBody) {
            trackResponseHandler(async () => {
              const inspection = await inspectHistoryAnchor(
                responseBody,
                historyAnchorToken,
              );
              if (!inspection.inspected) {
                uninspectableHistoryResponseCount += 1;
                return;
              }
              inspectedHistoryResponseCount += 1;
              if (inspection.anchorUserPresent) {
                historyResponseWithAnchorUserCount += 1;
              }
              if (inspection.anchoredAssistantPresent) {
                historyResponseWithAnchoredAssistantCount += 1;
              }
            });
          }
        } else if (status >= 400 && status < 500) {
          clientErrorHistoryGetResponseCount += 1;
        } else if (status >= 500 && status < 600) {
          serverErrorHistoryGetResponseCount += 1;
        } else {
          otherHistoryGetResponseCount += 1;
        }
      }
      if (isPersonalIdentityGet(method, rawUrl)) {
        if (status >= 200 && status < 300) {
          successfulPersonalIdentityGetCount += 1;
          if (responseBody) {
            trackResponseHandler(async () => {
              const inspection =
                await inspectPersonalIdentityResponse(responseBody);
              if (!inspection.bodyCompleted) {
                uninspectablePersonalIdentityResponseBodyCount += 1;
                return;
              }
              completedPersonalIdentityResponseBodyCount += 1;
              if (!inspection.parsed) return;
              parsedPersonalIdentityResponseBodyCount += 1;
              if (inspection.runtime === "shared") {
                decodedSharedPersonalIdentityResponseCount += 1;
              } else if (inspection.runtime === "dedicated") {
                decodedDedicatedPersonalIdentityResponseCount += 1;
              }
            });
          } else {
            uninspectablePersonalIdentityResponseBodyCount += 1;
          }
        } else if (status >= 400 && status < 500) {
          clientErrorPersonalIdentityGetResponseCount += 1;
        } else if (status >= 500 && status < 600) {
          serverErrorPersonalIdentityGetResponseCount += 1;
        } else {
          otherPersonalIdentityGetResponseCount += 1;
        }
      }
      const dedicatedRequest = dedicatedControlPlaneRequest(method, rawUrl);
      if (dedicatedRequest) {
        const counters = dedicatedControlPlane[dedicatedRequest];
        const sourceAgentId = dedicatedRequestSourceAgentId(rawUrl);
        const lifecycleRequest =
          dedicatedRequest === "activation" && sourceAgentId
            ? dedicatedLifecycleRequests.find(
                (request) =>
                  request.phase === "activation" &&
                  request.sourceAgentId === sourceAgentId &&
                  request.responseStatus === null,
              )
            : undefined;
        if (lifecycleRequest) lifecycleRequest.responseStatus = status;
        if (status >= 200 && status < 300) counters.success += 1;
        else if (status >= 400 && status < 500) counters.clientError += 1;
        else if (status >= 500 && status < 600) counters.serverError += 1;
        else counters.other += 1;
        if (responseBody) {
          trackResponseHandler(async () => {
            const inspection = await inspectDedicatedControlPlaneResponse(
              dedicatedRequest,
              status,
              responseBody,
            );
            if (!inspection.bodyCompleted) {
              counters.uninspectableBody += 1;
              return;
            }
            counters.bodyCompleted += 1;
            if (!inspection.parsed) return;
            counters.parsed += 1;
            if (inspection.decoded) counters.decoded += 1;
            if (inspection.pending) counters.pendingDecoded += 1;
            if (inspection.final) counters.finalDecoded += 1;
            if (lifecycleRequest) {
              lifecycleRequest.responseCode = inspection.code;
            }
            if (
              dedicatedRequest === "quote" &&
              sourceAgentId &&
              inspection.quoteId
            ) {
              latestActivationQuoteBinding = {
                confirmationKind: "activation",
                sourceAgentId,
                quoteId: inspection.quoteId,
                dedicatedAgentId: inspection.dedicatedAgentId,
              };
            } else if (
              dedicatedRequest === "activation" &&
              sourceAgentId &&
              inspection.dedicatedAgentId
            ) {
              activationReceiptTargets.push({
                sourceAgentId,
                dedicatedAgentId: inspection.dedicatedAgentId,
              });
            }
          });
        } else counters.uninspectableBody += 1;
      }
      if (dedicatedAdoptionRequest(method, rawUrl) === "quote") {
        if (status >= 200 && status < 300) {
          successfulDedicatedAdoptionQuoteGetResponseCount += 1;
        } else if (status >= 400 && status < 500) {
          clientErrorDedicatedAdoptionQuoteGetResponseCount += 1;
        } else if (status >= 500 && status < 600) {
          serverErrorDedicatedAdoptionQuoteGetResponseCount += 1;
        } else {
          otherDedicatedAdoptionQuoteGetResponseCount += 1;
        }
        if (responseBody) {
          trackResponseHandler(async () => {
            const inspection = await inspectDedicatedAdoptionQuoteResponse(
              status,
              responseBody,
            );
            if (!inspection.bodyCompleted) {
              uninspectableDedicatedAdoptionQuoteResponseBodyCount += 1;
              return;
            }
            completedDedicatedAdoptionQuoteResponseBodyCount += 1;
            if (!inspection.parsed) return;
            parsedDedicatedAdoptionQuoteResponseBodyCount += 1;
            if (inspection.disposition === "adoptable") {
              decodedAdoptableDedicatedAdoptionQuoteCount += 1;
            } else if (inspection.disposition === "unavailable") {
              decodedUnavailableDedicatedAdoptionQuoteCount += 1;
            }
          });
        } else {
          uninspectableDedicatedAdoptionQuoteResponseBodyCount += 1;
        }
      }
    },
    observeRequestFailure(method, rawUrl, errorText = "") {
      if (isPersonalIdentityGet(method, rawUrl)) {
        failedPersonalIdentityGetRequestCount += 1;
      }
      const dedicatedRequest = dedicatedControlPlaneRequest(method, rawUrl);
      if (dedicatedRequest) dedicatedControlPlane[dedicatedRequest].failed += 1;
      if (dedicatedAdoptionRequest(method, rawUrl) === "quote") {
        failedDedicatedAdoptionQuoteGetRequestCount += 1;
      }
      if (!isHistoryGet(method, rawUrl)) return;
      failedHistoryGetRequestCount += 1;
      if (/tim(?:e|ed)[ _-]?out/i.test(errorText)) {
        timedOutHistoryGetRequestCount += 1;
      }
    },
    setDedicatedApprovalBinding(binding) {
      if (dedicatedApprovalBinding) {
        throw new Error(
          "[cloud-live] Dedicated approval binding was already recorded",
        );
      }
      if (
        !binding.sourceAgentId.trim() ||
        !binding.quoteId.trim() ||
        (binding.confirmationKind === "adoption" &&
          !binding.dedicatedAgentId?.trim())
      ) {
        throw new Error(
          "[cloud-live] Dedicated approval binding is incomplete",
        );
      }
      dedicatedApprovalBinding = {
        confirmationKind: binding.confirmationKind,
        sourceAgentId: binding.sourceAgentId.trim(),
        quoteId: binding.quoteId.trim(),
        dedicatedAgentId: binding.dedicatedAgentId?.trim() || null,
      };
    },
    async latestDedicatedActivationApprovalBinding() {
      await drainResponseHandlers();
      return latestActivationQuoteBinding
        ? { ...latestActivationQuoteBinding }
        : null;
    },
    setHistoryAnchorToken(anchorToken) {
      historyAnchorToken = anchorToken.trim().toLowerCase();
    },
    snapshot: async () => {
      await drainResponseHandlers();
      const latestDedicatedActivationResponse = dedicatedLifecycleRequests
        .slice()
        .reverse()
        .find(
          (request) =>
            request.phase === "activation" && request.responseStatus !== null,
        );
      const approvedTargetId =
        dedicatedApprovalBinding?.dedicatedAgentId ??
        (dedicatedApprovalBinding?.confirmationKind === "activation"
          ? (activationReceiptTargets.find(
              (receipt) =>
                receipt.sourceAgentId ===
                dedicatedApprovalBinding?.sourceAgentId,
            )?.dedicatedAgentId ?? null)
          : null);
      const dedicatedLifecycleBindingMismatchCount =
        dedicatedLifecycleRequests.reduce((count, request) => {
          if (!dedicatedApprovalBinding) return count + 1;
          let mismatched =
            request.sourceAgentId !== dedicatedApprovalBinding.sourceAgentId;
          if (request.phase === "adoption") {
            mismatched ||= request.quoteId !== dedicatedApprovalBinding.quoteId;
          } else if (
            request.phase === "activation" &&
            dedicatedApprovalBinding.confirmationKind === "activation"
          ) {
            mismatched ||= request.quoteId !== dedicatedApprovalBinding.quoteId;
          } else if (request.phase === "activation") {
            // Adoption may begin with one generic activation attempt solely to
            // obtain the server's typed same-row selection boundary. Any other
            // result could have started unrelated compute and is not approved.
            mismatched ||=
              request.responseStatus !== 409 ||
              request.responseCode !== "dedicated_adoption_selection_required";
          } else if (request.phase === "cutover") {
            mismatched ||=
              approvedTargetId === null ||
              request.dedicatedAgentId !== approvedTargetId;
          }
          return count + (mismatched ? 1 : 0);
        }, 0);
      const terminalHistoryGetCount =
        successfulHistoryGetCount +
        clientErrorHistoryGetResponseCount +
        serverErrorHistoryGetResponseCount +
        otherHistoryGetResponseCount +
        failedHistoryGetRequestCount;
      const terminalPersonalIdentityGetCount =
        successfulPersonalIdentityGetCount +
        clientErrorPersonalIdentityGetResponseCount +
        serverErrorPersonalIdentityGetResponseCount +
        otherPersonalIdentityGetResponseCount +
        failedPersonalIdentityGetRequestCount;
      const pendingDedicatedRequestCount = (
        phase: DedicatedControlPlaneRequest,
      ) => {
        const counters = dedicatedControlPlane[phase];
        return Math.max(
          0,
          counters.request -
            counters.success -
            counters.clientError -
            counters.serverError -
            counters.other -
            counters.failed,
        );
      };
      return {
        forbiddenAgentMutationCount,
        chatSendAttemptCount,
        logicalChatSendCount: logicalChatSendIds.size,
        unidentifiedChatSendAttemptCount,
        namedWarmingResponseCount,
        successfulChatSendResponseCount,
        clientErrorChatSendResponseCount,
        serverErrorChatSendResponseCount,
        otherChatSendResponseCount,
        personalIdentityGetRequestCount,
        successfulPersonalIdentityGetCount,
        clientErrorPersonalIdentityGetResponseCount,
        serverErrorPersonalIdentityGetResponseCount,
        otherPersonalIdentityGetResponseCount,
        failedPersonalIdentityGetRequestCount,
        pendingPersonalIdentityGetRequestCount: Math.max(
          0,
          personalIdentityGetRequestCount - terminalPersonalIdentityGetCount,
        ),
        completedPersonalIdentityResponseBodyCount,
        parsedPersonalIdentityResponseBodyCount,
        decodedSharedPersonalIdentityResponseCount,
        decodedDedicatedPersonalIdentityResponseCount,
        uninspectablePersonalIdentityResponseBodyCount,
        dedicatedQuoteGetRequestCount: dedicatedControlPlane.quote.request,
        successfulDedicatedQuoteGetResponseCount:
          dedicatedControlPlane.quote.success,
        clientErrorDedicatedQuoteGetResponseCount:
          dedicatedControlPlane.quote.clientError,
        serverErrorDedicatedQuoteGetResponseCount:
          dedicatedControlPlane.quote.serverError,
        otherDedicatedQuoteGetResponseCount: dedicatedControlPlane.quote.other,
        failedDedicatedQuoteGetRequestCount: dedicatedControlPlane.quote.failed,
        pendingDedicatedQuoteGetRequestCount:
          pendingDedicatedRequestCount("quote"),
        completedDedicatedQuoteResponseBodyCount:
          dedicatedControlPlane.quote.bodyCompleted,
        parsedDedicatedQuoteResponseBodyCount:
          dedicatedControlPlane.quote.parsed,
        decodedDedicatedQuoteResponseCount: dedicatedControlPlane.quote.decoded,
        uninspectableDedicatedQuoteResponseBodyCount:
          dedicatedControlPlane.quote.uninspectableBody,
        dedicatedActivationPostRequestCount:
          dedicatedControlPlane.activation.request,
        successfulDedicatedActivationPostResponseCount:
          dedicatedControlPlane.activation.success,
        clientErrorDedicatedActivationPostResponseCount:
          dedicatedControlPlane.activation.clientError,
        serverErrorDedicatedActivationPostResponseCount:
          dedicatedControlPlane.activation.serverError,
        otherDedicatedActivationPostResponseCount:
          dedicatedControlPlane.activation.other,
        failedDedicatedActivationPostRequestCount:
          dedicatedControlPlane.activation.failed,
        pendingDedicatedActivationPostRequestCount:
          pendingDedicatedRequestCount("activation"),
        completedDedicatedActivationResponseBodyCount:
          dedicatedControlPlane.activation.bodyCompleted,
        parsedDedicatedActivationResponseBodyCount:
          dedicatedControlPlane.activation.parsed,
        decodedDedicatedActivationReceiptCount:
          dedicatedControlPlane.activation.decoded,
        uninspectableDedicatedActivationResponseBodyCount:
          dedicatedControlPlane.activation.uninspectableBody,
        dedicatedActivationResponseStatus:
          latestDedicatedActivationResponse?.responseStatus ?? null,
        dedicatedActivationResponseCode:
          latestDedicatedActivationResponse?.responseCode ?? null,
        dedicatedCutoverPostRequestCount: dedicatedControlPlane.cutover.request,
        successfulDedicatedCutoverPostResponseCount:
          dedicatedControlPlane.cutover.success,
        clientErrorDedicatedCutoverPostResponseCount:
          dedicatedControlPlane.cutover.clientError,
        serverErrorDedicatedCutoverPostResponseCount:
          dedicatedControlPlane.cutover.serverError,
        otherDedicatedCutoverPostResponseCount:
          dedicatedControlPlane.cutover.other,
        failedDedicatedCutoverPostRequestCount:
          dedicatedControlPlane.cutover.failed,
        pendingDedicatedCutoverPostRequestCount:
          pendingDedicatedRequestCount("cutover"),
        completedDedicatedCutoverResponseBodyCount:
          dedicatedControlPlane.cutover.bodyCompleted,
        parsedDedicatedCutoverResponseBodyCount:
          dedicatedControlPlane.cutover.parsed,
        decodedDedicatedCutoverPendingResponseCount:
          dedicatedControlPlane.cutover.pendingDecoded,
        decodedDedicatedCutoverFinalResponseCount:
          dedicatedControlPlane.cutover.finalDecoded,
        uninspectableDedicatedCutoverResponseBodyCount:
          dedicatedControlPlane.cutover.uninspectableBody,
        dedicatedAdoptionQuoteGetRequestCount,
        successfulDedicatedAdoptionQuoteGetResponseCount,
        clientErrorDedicatedAdoptionQuoteGetResponseCount,
        serverErrorDedicatedAdoptionQuoteGetResponseCount,
        otherDedicatedAdoptionQuoteGetResponseCount,
        failedDedicatedAdoptionQuoteGetRequestCount,
        pendingDedicatedAdoptionQuoteGetRequestCount: Math.max(
          0,
          dedicatedAdoptionQuoteGetRequestCount -
            successfulDedicatedAdoptionQuoteGetResponseCount -
            clientErrorDedicatedAdoptionQuoteGetResponseCount -
            serverErrorDedicatedAdoptionQuoteGetResponseCount -
            otherDedicatedAdoptionQuoteGetResponseCount -
            failedDedicatedAdoptionQuoteGetRequestCount,
        ),
        completedDedicatedAdoptionQuoteResponseBodyCount,
        parsedDedicatedAdoptionQuoteResponseBodyCount,
        decodedAdoptableDedicatedAdoptionQuoteCount,
        decodedUnavailableDedicatedAdoptionQuoteCount,
        uninspectableDedicatedAdoptionQuoteResponseBodyCount,
        dedicatedAdoptionConfirmationPostRequestCount,
        dedicatedApprovalBindingPresent: dedicatedApprovalBinding !== null,
        dedicatedLifecycleBindingMismatchCount,
        historyGetRequestCount,
        successfulHistoryGetCount,
        clientErrorHistoryGetResponseCount,
        serverErrorHistoryGetResponseCount,
        otherHistoryGetResponseCount,
        failedHistoryGetRequestCount,
        timedOutHistoryGetRequestCount,
        pendingHistoryGetRequestCount: Math.max(
          0,
          historyGetRequestCount - terminalHistoryGetCount,
        ),
        inspectedHistoryResponseCount,
        uninspectableHistoryResponseCount,
        historyResponseWithAnchorUserCount,
        historyResponseWithAnchoredAssistantCount,
      };
    },
  };
}

function normalizedApiBase(apiBase: string): string {
  try {
    const parsed = new URL(apiBase);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

/** Reduce private values to publishable booleans before they leave memory. */
export function compareCloudLiveRuntimeBindings(
  reference: CloudLiveRuntimeBinding,
  candidate: CloudLiveRuntimeBinding,
): CloudLiveBindingReuse {
  const referenceBase = normalizedApiBase(reference.apiBase);
  return {
    personalIdentityReused:
      reference.personalIdentity.length > 0 &&
      candidate.personalIdentity === reference.personalIdentity,
    runtimeBindingReused:
      reference.runtimeBinding.length > 0 &&
      candidate.runtimeBinding === reference.runtimeBinding &&
      candidate.runtime === reference.runtime,
    apiBaseReused:
      referenceBase.length > 0 &&
      normalizedApiBase(candidate.apiBase) === referenceBase,
  };
}

function requireTrue(value: unknown, label: string): void {
  if (value !== true) fail(`${label} must be true`);
}

function requireClosedRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} must use the exact closed schema`);
  }
  return value as Record<string, unknown>;
}

function requireObservation(
  observation: CloudLiveHistoryObservation,
  label: string,
): void {
  requireTrue(observation.historyGetSucceeded, `${label}.historyGetSucceeded`);
  requireTrue(
    observation.challengeUserLinePresent,
    `${label}.challengeUserLinePresent`,
  );
  requireTrue(
    observation.challengeAssistantLinePresent,
    `${label}.challengeAssistantLinePresent`,
  );
}

function requireCounter(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function createDedicatedMutationEvidence(input: {
  approvalGrantedCount: unknown;
  confirmationClickCount: unknown;
  confirmationKind: unknown;
  adoptionConfirmationPostCount: unknown;
  activationPostCount: unknown;
  cutoverPostCount: unknown;
  forbiddenAgentMutationCount: unknown;
}): CloudLiveDedicatedMutationEvidence {
  const approvalGrantedCount = requireCounter(
    input.approvalGrantedCount,
    "dedicatedMutationProof.approvalGrantedCount",
  );
  if (approvalGrantedCount !== 0 && approvalGrantedCount !== 1) {
    fail("dedicatedMutationProof.approvalGrantedCount must be zero or one");
  }
  const confirmationClickCount = requireCounter(
    input.confirmationClickCount,
    "dedicatedMutationProof.confirmationClickCount",
  );
  const adoptionConfirmationPostCount = requireCounter(
    input.adoptionConfirmationPostCount,
    "dedicatedMutationProof.adoptionConfirmationPostCount",
  );
  const activationPostCount = requireCounter(
    input.activationPostCount,
    "dedicatedMutationProof.activationPostCount",
  );
  const cutoverPostCount = requireCounter(
    input.cutoverPostCount,
    "dedicatedMutationProof.cutoverPostCount",
  );
  const forbiddenAgentMutationCount = requireCounter(
    input.forbiddenAgentMutationCount,
    "dedicatedMutationProof.forbiddenAgentMutationCount",
  );
  const approvalBindingPresent = input.approvalBindingPresent;
  if (typeof approvalBindingPresent !== "boolean") {
    fail("dedicatedMutationProof.approvalBindingPresent must be boolean");
  }
  const lifecycleBindingMismatchCount = requireCounter(
    input.lifecycleBindingMismatchCount,
    "dedicatedMutationProof.lifecycleBindingMismatchCount",
  );
  if (lifecycleBindingMismatchCount !== 0) {
    fail(
      "dedicatedMutationProof contains a lifecycle request outside the approved target or quote",
    );
  }
  const confirmationKind = input.confirmationKind;
  if (
    confirmationKind !== "none" &&
    confirmationKind !== "adoption" &&
    confirmationKind !== "activation"
  ) {
    fail("dedicatedMutationProof.confirmationKind is invalid");
  }
  const otherForbiddenAgentMutationCount =
    forbiddenAgentMutationCount - activationPostCount - cutoverPostCount;
  if (otherForbiddenAgentMutationCount !== 0) {
    fail(
      "dedicatedMutationProof contains an unauthorized agent lifecycle mutation",
    );
  }

  if (confirmationClickCount === 0) {
    if (
      confirmationKind !== "none" ||
      adoptionConfirmationPostCount !== 0 ||
      activationPostCount !== 0 ||
      cutoverPostCount !== 0 ||
      forbiddenAgentMutationCount !== 0 ||
      approvalBindingPresent
    ) {
      fail(
        "dedicatedMutationProof without a confirmation click must remain mutation-free and unbound",
      );
    }
    return {
      dedicatedApprovalDisposition:
        approvalGrantedCount === 1 ? "approval-unused" : "not-approved",
      dedicatedApprovalGrantedCount: approvalGrantedCount,
      dedicatedConfirmationKind: confirmationKind,
      dedicatedConfirmationClickCount: confirmationClickCount,
      dedicatedAdoptionConfirmationPostCount: adoptionConfirmationPostCount,
      dedicatedActivationPostCount: activationPostCount,
      dedicatedCutoverPostCount: cutoverPostCount,
      forbiddenAgentMutationCount,
      otherForbiddenAgentMutationCount: 0,
      dedicatedApprovalBindingPresent: false,
      dedicatedLifecycleBindingMismatchCount: 0,
    };
  }
  if (approvalGrantedCount !== 1 || confirmationClickCount !== 1) {
    fail(
      "dedicatedMutationProof confirmation requires one explicit approval and one click",
    );
  }
  if (!approvalBindingPresent) {
    fail(
      "dedicatedMutationProof confirmation requires an exact in-memory target and quote binding",
    );
  }
  if (cutoverPostCount < 1) {
    fail(
      "dedicatedMutationProof approved lifecycle must reach server-owned cutover",
    );
  }
  if (confirmationKind === "adoption") {
    if (
      adoptionConfirmationPostCount !== 1 ||
      (activationPostCount !== 0 && activationPostCount !== 1)
    ) {
      fail(
        "dedicatedMutationProof adoption requires one adoption POST and at most one selection POST",
      );
    }
    return {
      dedicatedApprovalDisposition: "approved-ui-confirmation",
      dedicatedApprovalGrantedCount: approvalGrantedCount,
      dedicatedConfirmationKind: confirmationKind,
      dedicatedConfirmationClickCount: confirmationClickCount,
      dedicatedAdoptionConfirmationPostCount: adoptionConfirmationPostCount,
      dedicatedActivationPostCount: activationPostCount,
      dedicatedCutoverPostCount: cutoverPostCount,
      forbiddenAgentMutationCount,
      otherForbiddenAgentMutationCount: 0,
      dedicatedApprovalBindingPresent: true,
      dedicatedLifecycleBindingMismatchCount: 0,
    };
  }
  if (confirmationKind === "activation") {
    if (adoptionConfirmationPostCount !== 0 || activationPostCount !== 1) {
      fail(
        "dedicatedMutationProof activation requires exactly one activation POST",
      );
    }
    return {
      dedicatedApprovalDisposition: "approved-ui-confirmation",
      dedicatedApprovalGrantedCount: approvalGrantedCount,
      dedicatedConfirmationKind: confirmationKind,
      dedicatedConfirmationClickCount: confirmationClickCount,
      dedicatedAdoptionConfirmationPostCount: adoptionConfirmationPostCount,
      dedicatedActivationPostCount: activationPostCount,
      dedicatedCutoverPostCount: cutoverPostCount,
      forbiddenAgentMutationCount,
      otherForbiddenAgentMutationCount: 0,
      dedicatedApprovalBindingPresent: true,
      dedicatedLifecycleBindingMismatchCount: 0,
    };
  }
  fail("dedicatedMutationProof clicked confirmation kind must be explicit");
}

const DEDICATED_MUTATION_EVIDENCE_KEYS = [
  "dedicatedApprovalDisposition",
  "dedicatedApprovalGrantedCount",
  "dedicatedConfirmationKind",
  "dedicatedConfirmationClickCount",
  "dedicatedAdoptionConfirmationPostCount",
  "dedicatedActivationPostCount",
  "dedicatedCutoverPostCount",
  "forbiddenAgentMutationCount",
  "otherForbiddenAgentMutationCount",
  "dedicatedApprovalBindingPresent",
  "dedicatedLifecycleBindingMismatchCount",
] as const satisfies readonly (keyof CloudLiveDedicatedMutationEvidence)[];

const EVIDENCE_KEYS = [
  ...Object.keys(VERIFIED_EVIDENCE_BASE),
  ...DEDICATED_MUTATION_EVIDENCE_KEYS,
] as Array<keyof CloudLiveContinuityEvidence>;

export function createCloudLiveContinuityEvidence(
  input: CloudLiveContinuityEvidenceInput,
): CloudLiveContinuityEvidence {
  if (input.challengeTurnCount !== 1) fail("challengeTurnCount must be one");
  requireTrue(
    input.noAdditionalChatSendAfterChallenge,
    "noAdditionalChatSendAfterChallenge",
  );
  requireTrue(
    input.personalIdentityEndpointPassed,
    "personalIdentityEndpointPassed",
  );
  requireObservation(input.reload, "reload");
  requireObservation(input.freshContext, "freshContext");
  requireTrue(
    input.freshContext.createdWithoutStorageState,
    "freshContext.createdWithoutStorageState",
  );
  requireTrue(
    input.freshContext.serviceWorkersBlocked,
    "freshContext.serviceWorkersBlocked",
  );
  for (const key of [
    "personalIdentityReused",
    "runtimeBindingReused",
    "apiBaseReused",
  ] as const) {
    requireTrue(input.bindingReuse[key], `bindingReuse.${key}`);
  }
  const dedicatedMutationEvidence = createDedicatedMutationEvidence(
    input.dedicatedMutationProof,
  );
  if (input.cleanupDisposition !== "no-test-owned-agent") {
    fail("cleanupDisposition must be no-test-owned-agent");
  }
  if (input.conversationHistoryDisposition !== "preserved") {
    fail("conversationHistoryDisposition must be preserved");
  }

  return { ...VERIFIED_EVIDENCE_BASE, ...dedicatedMutationEvidence };
}

export function parseCloudLiveContinuityEvidence(
  value: unknown,
): CloudLiveContinuityEvidence {
  const evidence = requireClosedRecord(value, EVIDENCE_KEYS, "artifact");
  const parsed = {
    ...VERIFIED_EVIDENCE_BASE,
    ...createDedicatedMutationEvidence({
      approvalGrantedCount: evidence.dedicatedApprovalGrantedCount,
      confirmationClickCount: evidence.dedicatedConfirmationClickCount,
      confirmationKind: evidence.dedicatedConfirmationKind,
      adoptionConfirmationPostCount:
        evidence.dedicatedAdoptionConfirmationPostCount,
      activationPostCount: evidence.dedicatedActivationPostCount,
      cutoverPostCount: evidence.dedicatedCutoverPostCount,
      forbiddenAgentMutationCount: evidence.forbiddenAgentMutationCount,
      approvalBindingPresent: evidence.dedicatedApprovalBindingPresent,
      lifecycleBindingMismatchCount:
        evidence.dedicatedLifecycleBindingMismatchCount,
    }),
  } satisfies CloudLiveContinuityEvidence;
  for (const key of EVIDENCE_KEYS) {
    if (evidence[key] !== parsed[key]) {
      fail(`artifact.${key} is invalid`);
    }
  }
  return parsed;
}

export async function writeCloudLiveContinuityEvidence(
  outputPath: string,
  input: CloudLiveContinuityEvidenceInput,
): Promise<string> {
  if (!outputPath.trim()) fail("output path must not be empty");
  const resolvedPath = resolve(outputPath);
  const evidence = createCloudLiveContinuityEvidence(input);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return resolvedPath;
}

export async function readCloudLiveContinuityEvidence(
  inputPath: string,
): Promise<CloudLiveContinuityEvidence> {
  if (!inputPath.trim()) fail("input path must not be empty");
  return parseCloudLiveContinuityEvidence(
    JSON.parse(await readFile(resolve(inputPath), "utf8")) as unknown,
  );
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) {
      fail("usage: bun cloud-live-continuity-contract.ts <artifact.json>");
    }
    await readCloudLiveContinuityEvidence(process.argv[2]);
    process.stdout.write("verified");
  } catch (error) {
    // error-policy:J1 fail closed without printing the artifact or private data.
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
