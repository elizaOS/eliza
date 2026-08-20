/** Closed, privacy-safe continuity evidence for the real Cloud UI lane. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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
  forbiddenAgentMutationCount: number;
  cleanupDisposition: "no-test-owned-agent";
  conversationHistoryDisposition: "preserved";
}

const VERIFIED_EVIDENCE = {
  schemaVersion: 1,
  lane: LANE,
  challengeTurnCount: 1,
  noAdditionalChatSendAfterChallenge: true,
  personalIdentityEndpointPassed: true,
  reloadHistoryPassed: true,
  freshContextHistoryPassed: true,
  personalIdentityReused: true,
  runtimeBindingReused: true,
  apiBaseReused: true,
  forbiddenAgentMutationCount: 0,
  cleanupDisposition: "no-test-owned-agent",
  conversationHistoryDisposition: "preserved",
} as const;

export type CloudLiveContinuityEvidence = typeof VERIFIED_EVIDENCE;

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

/** Counts only; request URLs and their embedded IDs are never retained. */
export function createCloudLiveNetworkAudit(): {
  observeRequest(
    method: string,
    rawUrl: string,
    postData?: string | null,
  ): void;
  observeResponse(method: string, rawUrl: string, status: number): void;
  snapshot(): {
    forbiddenAgentMutationCount: number;
    chatSendAttemptCount: number;
    logicalChatSendCount: number;
    unidentifiedChatSendAttemptCount: number;
    successfulChatSendResponseCount: number;
    clientErrorChatSendResponseCount: number;
    serverErrorChatSendResponseCount: number;
    otherChatSendResponseCount: number;
    successfulPersonalIdentityGetCount: number;
    successfulHistoryGetCount: number;
  };
} {
  let forbiddenAgentMutationCount = 0;
  let chatSendAttemptCount = 0;
  let unidentifiedChatSendAttemptCount = 0;
  const logicalChatSendIds = new Set<string>();
  let successfulChatSendResponseCount = 0;
  let clientErrorChatSendResponseCount = 0;
  let serverErrorChatSendResponseCount = 0;
  let otherChatSendResponseCount = 0;
  let successfulPersonalIdentityGetCount = 0;
  let successfulHistoryGetCount = 0;
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
    },
    observeResponse(method, rawUrl, status) {
      if (chatSendScope(method, rawUrl)) {
        if (status >= 200 && status < 300) {
          successfulChatSendResponseCount += 1;
        } else if (status >= 400 && status < 500) {
          clientErrorChatSendResponseCount += 1;
        } else if (status >= 500 && status < 600) {
          serverErrorChatSendResponseCount += 1;
        } else {
          otherChatSendResponseCount += 1;
        }
      }
      if (status >= 200 && status < 300 && isHistoryGet(method, rawUrl)) {
        successfulHistoryGetCount += 1;
      }
      if (
        status >= 200 &&
        status < 300 &&
        isPersonalIdentityGet(method, rawUrl)
      ) {
        successfulPersonalIdentityGetCount += 1;
      }
    },
    snapshot: () => ({
      forbiddenAgentMutationCount,
      chatSendAttemptCount,
      logicalChatSendCount: logicalChatSendIds.size,
      unidentifiedChatSendAttemptCount,
      successfulChatSendResponseCount,
      clientErrorChatSendResponseCount,
      serverErrorChatSendResponseCount,
      otherChatSendResponseCount,
      successfulPersonalIdentityGetCount,
      successfulHistoryGetCount,
    }),
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

const EVIDENCE_KEYS = Object.keys(VERIFIED_EVIDENCE) as Array<
  keyof CloudLiveContinuityEvidence
>;

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
  if (input.forbiddenAgentMutationCount !== 0) {
    fail("forbiddenAgentMutationCount must be zero");
  }
  if (input.cleanupDisposition !== "no-test-owned-agent") {
    fail("cleanupDisposition must be no-test-owned-agent");
  }
  if (input.conversationHistoryDisposition !== "preserved") {
    fail("conversationHistoryDisposition must be preserved");
  }

  return { ...VERIFIED_EVIDENCE };
}

export function parseCloudLiveContinuityEvidence(
  value: unknown,
): CloudLiveContinuityEvidence {
  const evidence = requireClosedRecord(value, EVIDENCE_KEYS, "artifact");
  for (const key of EVIDENCE_KEYS) {
    if (evidence[key] !== VERIFIED_EVIDENCE[key]) {
      fail(`artifact.${key} is invalid`);
    }
  }
  return { ...VERIFIED_EVIDENCE };
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
