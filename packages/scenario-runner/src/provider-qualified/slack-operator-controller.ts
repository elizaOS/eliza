/**
 * Defines the fail-closed operator boundary and read-only Slack observer for
 * the provider-qualified Slack canary. It validates the signed operation and
 * negative probes before network access, then correlates an independently
 * authenticated workspace with exact human ingress and a later bot effect.
 */

import { createHash } from "node:crypto";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import {
  assertDeployedCanaryCapabilities,
  type DeployedCanaryCapabilities,
  type DeployedCanaryContractDescriptor,
  validateDeployedCanaryContractDescriptor,
} from "./deployed-capability-contract.ts";
import {
  type AuthorizedProviderCanaryExecutionPreflight,
  type ProviderCanaryAuthorization,
  type ProviderFailureProbeMaterial,
  preflightAuthorizedProviderCanaryExecution,
} from "./operator-authorization.ts";

export const SLACK_OPERATOR_PLAN_SCHEMA =
  "eliza.slack-provider-canary-operator-plan.v1" as const;

const SLACK_API_ORIGIN = "https://slack.com";
const SLACK_TEAM_PATTERN = /^T[A-Z0-9]{5,}$/;
const SLACK_CHANNEL_PATTERN = /^[CDG][A-Z0-9]{5,}$/;
const SLACK_USER_PATTERN = /^[UW][A-Z0-9]{5,}$/;
const SLACK_BOT_PATTERN = /^B[A-Z0-9]{5,}$/;
const SLACK_TS_PATTERN = /^\d{10,16}\.\d{6}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const validatedPreflights = new WeakSet<object>();

export interface SlackOperatorPlan {
  schema: typeof SLACK_OPERATOR_PLAN_SCHEMA;
  slackApiOrigin: typeof SLACK_API_ORIGIN;
  teamId: string;
  channelId: string;
  humanOperatorUserId: string;
  agentBotUserId: string;
  observerUserId: string;
  runNonce: string;
  expectedHumanIngressContent: string;
  expectedProviderEffectContent: string;
  poll: { intervalMs: number; timeoutMs: number };
  deploymentEvidence: DeployedCanaryContractDescriptor;
}

export interface SlackOperatorPreflight {
  status: "slack-operator-inputs-validated";
  scenarioId: "provider.slack.confirmed-send";
  authorization: ProviderCanaryAuthorization;
  execution: AuthorizedProviderCanaryExecutionPreflight;
  plan: SlackOperatorPlan;
  blockers: readonly [];
}

export interface SlackObserverIdentityReceipt {
  teamId: string;
  observerUserId: string;
  url: string;
}

export interface SlackRawMessageReceipt {
  timestamp: string;
  userId: string;
  botId: string | null;
  text: string;
  textSha256: string;
}

export interface SlackRawReadback {
  schema: "eliza.slack-provider-canary-raw-readback.v1";
  collectedAtIso: string;
  teamId: string;
  channelId: string;
  observerIdentity: SlackObserverIdentityReceipt;
  humanIngress: SlackRawMessageReceipt;
  providerEffect: SlackRawMessageReceipt;
  qualificationClaimed: false;
}

export type SlackFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function fail(message: string): never {
  throw new Error(`slack provider-canary operator ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(`${path} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  path: string,
  expected: readonly string[],
): void {
  const expectedSet = new Set(expected);
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter((key) => !expectedSet.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    fail(
      `${path} violates the closed shape (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`,
    );
  }
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${path} must be a non-empty string`);
  }
  return value;
}

function identifier(value: unknown, path: string, pattern: RegExp): string {
  const candidate = string(value, path);
  if (!pattern.test(candidate)) fail(`${path} has an invalid Slack identifier`);
  return candidate;
}

function message(value: unknown, path: string): string {
  const candidate = string(value, path);
  if (candidate.length > MAX_MESSAGE_LENGTH) {
    fail(`${path} exceeds ${MAX_MESSAGE_LENGTH} characters`);
  }
  return candidate;
}

function boundedInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    fail(`${path} must be an integer from ${minimum} through ${maximum}`);
  }
  return Number(value);
}

function parsePlan(value: unknown): SlackOperatorPlan {
  const plan = record(value, "plan");
  exactKeys(plan, "plan", [
    "schema",
    "slackApiOrigin",
    "teamId",
    "channelId",
    "humanOperatorUserId",
    "agentBotUserId",
    "observerUserId",
    "runNonce",
    "expectedHumanIngressContent",
    "expectedProviderEffectContent",
    "poll",
    "deploymentEvidence",
  ]);
  if (plan.schema !== SLACK_OPERATOR_PLAN_SCHEMA)
    fail("plan.schema is unsupported");
  if (plan.slackApiOrigin !== SLACK_API_ORIGIN) {
    fail(`plan.slackApiOrigin must be ${SLACK_API_ORIGIN}`);
  }
  const poll = record(plan.poll, "plan.poll");
  exactKeys(poll, "plan.poll", ["intervalMs", "timeoutMs"]);
  const deploymentEvidence = record(
    plan.deploymentEvidence,
    "plan.deploymentEvidence",
  );
  const runNonce = string(plan.runNonce, "plan.runNonce");
  if (!NONCE_PATTERN.test(runNonce))
    fail("plan.runNonce must be canonical base64url");
  const humanOperatorUserId = identifier(
    plan.humanOperatorUserId,
    "plan.humanOperatorUserId",
    SLACK_USER_PATTERN,
  );
  const agentBotUserId = identifier(
    plan.agentBotUserId,
    "plan.agentBotUserId",
    SLACK_USER_PATTERN,
  );
  const observerUserId = identifier(
    plan.observerUserId,
    "plan.observerUserId",
    SLACK_USER_PATTERN,
  );
  if (
    new Set([humanOperatorUserId, agentBotUserId, observerUserId]).size !== 3
  ) {
    fail("human, agent bot, and observer Slack principals must be distinct");
  }
  return Object.freeze({
    schema: SLACK_OPERATOR_PLAN_SCHEMA,
    slackApiOrigin: SLACK_API_ORIGIN,
    teamId: identifier(plan.teamId, "plan.teamId", SLACK_TEAM_PATTERN),
    channelId: identifier(
      plan.channelId,
      "plan.channelId",
      SLACK_CHANNEL_PATTERN,
    ),
    humanOperatorUserId,
    agentBotUserId,
    observerUserId,
    runNonce,
    expectedHumanIngressContent: message(
      plan.expectedHumanIngressContent,
      "plan.expectedHumanIngressContent",
    ),
    expectedProviderEffectContent: message(
      plan.expectedProviderEffectContent,
      "plan.expectedProviderEffectContent",
    ),
    poll: Object.freeze({
      intervalMs: boundedInteger(
        poll.intervalMs,
        "plan.poll.intervalMs",
        60_000,
        5 * 60_000,
      ),
      timeoutMs: boundedInteger(
        poll.timeoutMs,
        "plan.poll.timeoutMs",
        60_000,
        30 * 60_000,
      ),
    }),
    deploymentEvidence:
      deploymentEvidence as unknown as DeployedCanaryContractDescriptor,
  });
}

/** Validate signed authorization and all private operation material before network access. */
export function preflightSlackOperatorCanary(input: {
  scenario: ScenarioDefinition;
  authorization: unknown;
  pinnedManifestAuthorityPublicKeysPem: readonly [string, ...string[]];
  providerTarget: unknown;
  operationInput: unknown;
  failureProbes: readonly [
    ProviderFailureProbeMaterial,
    ProviderFailureProbeMaterial,
    ...ProviderFailureProbeMaterial[],
  ];
  plan: unknown;
}): SlackOperatorPreflight {
  const plan = parsePlan(input.plan);
  if (input.scenario.id !== "provider.slack.confirmed-send") {
    fail("scenario must be provider.slack.confirmed-send");
  }
  const execution = preflightAuthorizedProviderCanaryExecution({
    scenario: input.scenario,
    authorization: input.authorization,
    pinnedManifestAuthorityPublicKeysPem:
      input.pinnedManifestAuthorityPublicKeysPem,
    operationKind: "slack.message-send",
    providerTarget: input.providerTarget,
    operationInput: input.operationInput,
    failureProbes: input.failureProbes,
  });
  const target = record(input.providerTarget, "providerTarget");
  const operation = record(input.operationInput, "operationInput");
  if (
    target.teamId !== plan.teamId ||
    target.channelId !== plan.channelId ||
    target.threadTs !== null
  ) {
    fail("plan Slack target does not match the signed root-channel target");
  }
  if (operation.text !== plan.expectedProviderEffectContent) {
    fail("plan effect content does not match the signed operation input");
  }
  if (!plan.expectedHumanIngressContent.includes(plan.runNonce)) {
    fail("plan human ingress content must contain the exact run nonce");
  }
  if (execution.authorization.manifest.run.nonce !== plan.runNonce) {
    fail("plan run nonce does not match the signed manifest");
  }
  const deploymentEvidence = validateDeployedCanaryContractDescriptor({
    descriptor: plan.deploymentEvidence,
    execution,
  });
  const result = Object.freeze({
    status: "slack-operator-inputs-validated",
    scenarioId: "provider.slack.confirmed-send",
    authorization: execution.authorization,
    execution,
    plan: Object.freeze({ ...plan, deploymentEvidence }),
    blockers: Object.freeze([] as const),
  });
  validatedPreflights.add(result);
  return result;
}

/** Return the complete executable seam only for the exact validated preflight. */
export function assertSlackOperatorCanaryExecutable(
  preflight: SlackOperatorPreflight,
  capabilities: unknown,
): DeployedCanaryCapabilities {
  if (!validatedPreflights.has(preflight)) {
    fail("execution requires the exact validated Slack preflight result");
  }
  return assertDeployedCanaryCapabilities(capabilities);
}

async function slackJsonRequest(input: {
  preflight: SlackOperatorPreflight;
  observerToken: string;
  method: "auth.test" | "conversations.history";
  fetchImpl: SlackFetch;
}): Promise<Record<string, unknown>> {
  if (!validatedPreflights.has(input.preflight)) {
    fail("readback requires the exact result of preflightSlackOperatorCanary");
  }
  if (!/^xox[pboa]-[A-Za-z0-9-]{20,}$/.test(input.observerToken)) {
    fail("observerToken is missing or invalid");
  }
  const url = new URL(`/api/${input.method}`, SLACK_API_ORIGIN);
  if (input.method === "conversations.history") {
    url.searchParams.set("channel", input.preflight.plan.channelId);
    url.searchParams.set("limit", "15");
  }
  let response: Response;
  try {
    response = await input.fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.observerToken}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    // error-policy:J2 preserve provider transport failure at the operator boundary.
    throw new Error(
      `slack provider-canary operator ${input.method} transport failed`,
      { cause: error },
    );
  }
  if (!response.ok) fail(`${input.method} returned HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    fail(`${input.method} response exceeds the byte limit`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES)
    fail(`${input.method} response exceeds the byte limit`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // error-policy:J2 retain malformed provider-response context without token data.
    throw new Error(
      `slack provider-canary operator ${input.method} returned invalid JSON`,
      { cause: error },
    );
  }
  const body = record(parsed, input.method);
  if (body.ok !== true)
    fail(
      `${input.method} failed with ${String(body.error ?? "unknown_error")}`,
    );
  return body;
}

function slackTimestamp(value: unknown, path: string): string {
  const candidate = string(value, path);
  if (!SLACK_TS_PATTERN.test(candidate))
    fail(`${path} must be a canonical Slack timestamp`);
  return candidate;
}

function parseHistory(value: unknown): readonly SlackRawMessageReceipt[] {
  const body = record(value, "conversations.history");
  if (!Array.isArray(body.messages) || body.messages.length > 15) {
    fail("conversations.history.messages must be an array of at most 15 items");
  }
  return Object.freeze(
    body.messages.map((entry, index) => {
      const item = record(entry, `messages[${index}]`);
      const text = message(item.text, `messages[${index}].text`);
      const botId =
        item.bot_id === undefined
          ? null
          : identifier(
              item.bot_id,
              `messages[${index}].bot_id`,
              SLACK_BOT_PATTERN,
            );
      return Object.freeze({
        timestamp: slackTimestamp(item.ts, `messages[${index}].ts`),
        userId: identifier(
          item.user,
          `messages[${index}].user`,
          SLACK_USER_PATTERN,
        ),
        botId,
        text,
        textSha256: createHash("sha256").update(text).digest("hex"),
      });
    }),
  );
}

function timestampNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    fail("Slack timestamp is outside the finite numeric range");
  return parsed;
}

/**
 * Poll Slack through a distinct read-only observer identity. This only returns
 * unsigned raw source material and cannot itself qualify the canary.
 */
export async function collectSlackRawReadback(input: {
  preflight: SlackOperatorPreflight;
  observerToken: string;
  fetchImpl?: SlackFetch;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<SlackRawReadback> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const identityBody = await slackJsonRequest({
    preflight: input.preflight,
    observerToken: input.observerToken,
    method: "auth.test",
    fetchImpl,
  });
  const identity = Object.freeze({
    teamId: identifier(
      identityBody.team_id,
      "auth.test.team_id",
      SLACK_TEAM_PATTERN,
    ),
    observerUserId: identifier(
      identityBody.user_id,
      "auth.test.user_id",
      SLACK_USER_PATTERN,
    ),
    url: string(identityBody.url, "auth.test.url"),
  });
  if (
    identity.teamId !== input.preflight.plan.teamId ||
    identity.observerUserId !== input.preflight.plan.observerUserId
  ) {
    fail(
      "observer token identity does not match the validated workspace and independent observer",
    );
  }
  const now = input.now ?? Date.now;
  const wait =
    input.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  while (now() - startedAt <= input.preflight.plan.poll.timeoutMs) {
    const historyBody = await slackJsonRequest({
      preflight: input.preflight,
      observerToken: input.observerToken,
      method: "conversations.history",
      fetchImpl,
    });
    const messages = [...parseHistory(historyBody)].sort(
      (left, right) =>
        timestampNumber(left.timestamp) - timestampNumber(right.timestamp),
    );
    const humanIngress = messages.find(
      (item) =>
        item.userId === input.preflight.plan.humanOperatorUserId &&
        item.botId === null &&
        item.text === input.preflight.plan.expectedHumanIngressContent,
    );
    const providerEffect = humanIngress
      ? messages.find(
          (item) =>
            timestampNumber(item.timestamp) >
              timestampNumber(humanIngress.timestamp) &&
            item.userId === input.preflight.plan.agentBotUserId &&
            item.botId !== null &&
            item.text === input.preflight.plan.expectedProviderEffectContent,
        )
      : undefined;
    if (humanIngress && providerEffect) {
      return Object.freeze({
        schema: "eliza.slack-provider-canary-raw-readback.v1",
        collectedAtIso: new Date(now()).toISOString(),
        teamId: input.preflight.plan.teamId,
        channelId: input.preflight.plan.channelId,
        observerIdentity: identity,
        humanIngress,
        providerEffect,
        qualificationClaimed: false,
      });
    }
    await wait(input.preflight.plan.poll.intervalMs);
  }
  fail(
    "timed out waiting for exact human ingress and a strictly later bot effect",
  );
}
