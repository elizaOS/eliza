/**
 * Defines the fail-closed operator boundary for the Discord provider canary.
 * It validates every private execution input before network access and can
 * collect read-only Discord receipts. Execution becomes available only when a
 * manifest-bound deployment descriptor and every production capability seam
 * pass the shared fail-closed contract.
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

export const DISCORD_OPERATOR_PLAN_SCHEMA =
  "eliza.discord-provider-canary-operator-plan.v1" as const;

const DISCORD_API_ORIGIN = "https://discord.com";
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const validatedPreflights = new WeakSet<object>();

export interface DiscordOperatorPlan {
  schema: typeof DISCORD_OPERATOR_PLAN_SCHEMA;
  discordApiOrigin: typeof DISCORD_API_ORIGIN;
  guildId: string;
  channelId: string;
  humanOperatorUserId: string;
  agentBotUserId: string;
  runNonce: string;
  expectedHumanIngressContent: string;
  expectedProviderEffectContent: string;
  poll: {
    intervalMs: number;
    timeoutMs: number;
  };
  deploymentEvidence: DeployedCanaryContractDescriptor;
}

export interface DiscordOperatorPreflight {
  status: "discord-operator-inputs-validated";
  scenarioId: "provider.discord.confirmed-send";
  authorization: ProviderCanaryAuthorization;
  execution: AuthorizedProviderCanaryExecutionPreflight;
  plan: DiscordOperatorPlan;
  blockers: readonly [];
}

export interface DiscordRawMessageReceipt {
  messageId: string;
  channelId: string;
  guildId: string | null;
  author: {
    id: string;
    bot: boolean;
  };
  timestamp: string;
  content: string;
  contentSha256: string;
}

export interface DiscordObserverIdentityReceipt {
  userId: string;
  bot: true;
  rawResponseSha256: string;
}

export interface DiscordRawReadback {
  schema: "eliza.discord-provider-canary-raw-readback.v1";
  collectedAtIso: string;
  channelId: string;
  observerIdentity: DiscordObserverIdentityReceipt;
  humanIngress: DiscordRawMessageReceipt;
  providerEffect: DiscordRawMessageReceipt;
  qualificationClaimed: false;
}

export type DiscordFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function fail(message: string): never {
  throw new Error(`discord provider-canary operator ${message}`);
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

function snowflake(value: unknown, path: string): string {
  const candidate = string(value, path);
  if (!SNOWFLAKE_PATTERN.test(candidate)) {
    fail(`${path} must be a Discord snowflake`);
  }
  return candidate;
}

function boundedMessage(value: unknown, path: string): string {
  const candidate = string(value, path);
  if (candidate.length > MAX_MESSAGE_LENGTH) {
    fail(`${path} cannot exceed ${MAX_MESSAGE_LENGTH} characters`);
  }
  return candidate;
}

function positiveInteger(
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

function parsePlan(value: unknown): DiscordOperatorPlan {
  const plan = record(value, "plan");
  exactKeys(plan, "plan", [
    "schema",
    "discordApiOrigin",
    "guildId",
    "channelId",
    "humanOperatorUserId",
    "agentBotUserId",
    "runNonce",
    "expectedHumanIngressContent",
    "expectedProviderEffectContent",
    "poll",
    "deploymentEvidence",
  ]);
  if (plan.schema !== DISCORD_OPERATOR_PLAN_SCHEMA) {
    fail("plan.schema is unsupported");
  }
  if (plan.discordApiOrigin !== DISCORD_API_ORIGIN) {
    fail(`plan.discordApiOrigin must be ${DISCORD_API_ORIGIN}`);
  }
  const poll = record(plan.poll, "plan.poll");
  exactKeys(poll, "plan.poll", ["intervalMs", "timeoutMs"]);
  const deploymentEvidence = record(
    plan.deploymentEvidence,
    "plan.deploymentEvidence",
  );
  const runNonce = string(plan.runNonce, "plan.runNonce");
  if (!NONCE_PATTERN.test(runNonce)) {
    fail("plan.runNonce must be 32-128 unpadded base64url characters");
  }
  const humanOperatorUserId = snowflake(
    plan.humanOperatorUserId,
    "plan.humanOperatorUserId",
  );
  const agentBotUserId = snowflake(plan.agentBotUserId, "plan.agentBotUserId");
  if (humanOperatorUserId === agentBotUserId) {
    fail("plan human operator and agent bot must be distinct principals");
  }
  return Object.freeze({
    schema: DISCORD_OPERATOR_PLAN_SCHEMA,
    discordApiOrigin: DISCORD_API_ORIGIN,
    guildId: snowflake(plan.guildId, "plan.guildId"),
    channelId: snowflake(plan.channelId, "plan.channelId"),
    humanOperatorUserId,
    agentBotUserId,
    runNonce,
    expectedHumanIngressContent: boundedMessage(
      plan.expectedHumanIngressContent,
      "plan.expectedHumanIngressContent",
    ),
    expectedProviderEffectContent: boundedMessage(
      plan.expectedProviderEffectContent,
      "plan.expectedProviderEffectContent",
    ),
    poll: Object.freeze({
      intervalMs: positiveInteger(
        poll.intervalMs,
        "plan.poll.intervalMs",
        250,
        30_000,
      ),
      timeoutMs: positiveInteger(
        poll.timeoutMs,
        "plan.poll.timeoutMs",
        1_000,
        15 * 60_000,
      ),
    }),
    deploymentEvidence:
      deploymentEvidence as unknown as DeployedCanaryContractDescriptor,
  });
}

/**
 * Validate authorization and all raw target, operation, and negative-probe
 * material before a controller is allowed to make even a read-only request.
 */
export function preflightDiscordOperatorCanary(input: {
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
}): DiscordOperatorPreflight {
  const plan = parsePlan(input.plan);
  if (input.scenario.id !== "provider.discord.confirmed-send") {
    fail("scenario must be provider.discord.confirmed-send");
  }
  const execution = preflightAuthorizedProviderCanaryExecution({
    scenario: input.scenario,
    authorization: input.authorization,
    pinnedManifestAuthorityPublicKeysPem:
      input.pinnedManifestAuthorityPublicKeysPem,
    operationKind: "discord.message-send",
    providerTarget: input.providerTarget,
    operationInput: input.operationInput,
    failureProbes: input.failureProbes,
  });
  const target = record(input.providerTarget, "providerTarget");
  const operation = record(input.operationInput, "operationInput");
  if (target.guildId !== plan.guildId || target.channelId !== plan.channelId) {
    fail("plan Discord target does not match the signed raw provider target");
  }
  if (operation.text !== plan.expectedProviderEffectContent) {
    fail(
      "plan provider-effect content does not match the signed operation input",
    );
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
    status: "discord-operator-inputs-validated",
    scenarioId: "provider.discord.confirmed-send",
    authorization: execution.authorization,
    execution,
    plan: Object.freeze({ ...plan, deploymentEvidence }),
    blockers: Object.freeze([] as const),
  });
  validatedPreflights.add(result);
  return result;
}

/** Return the complete executable seam only for the exact validated preflight. */
export function assertDiscordOperatorCanaryExecutable(
  preflight: DiscordOperatorPreflight,
  capabilities: unknown,
): DeployedCanaryCapabilities {
  if (!validatedPreflights.has(preflight)) {
    fail("execution requires the exact validated Discord preflight result");
  }
  return assertDeployedCanaryCapabilities(capabilities);
}

function receipt(value: unknown, path: string): DiscordRawMessageReceipt {
  const message = record(value, path);
  const author = record(message.author, `${path}.author`);
  const content = boundedMessage(message.content, `${path}.content`);
  const timestamp = string(message.timestamp, `${path}.timestamp`);
  if (!Number.isFinite(Date.parse(timestamp))) {
    fail(`${path}.timestamp must be an ISO timestamp`);
  }
  if (typeof author.bot !== "boolean") {
    fail(`${path}.author.bot must be a boolean`);
  }
  const guildId =
    message.guild_id === undefined || message.guild_id === null
      ? null
      : snowflake(message.guild_id, `${path}.guild_id`);
  return Object.freeze({
    messageId: snowflake(message.id, `${path}.id`),
    channelId: snowflake(message.channel_id, `${path}.channel_id`),
    guildId,
    author: Object.freeze({
      id: snowflake(author.id, `${path}.author.id`),
      bot: author.bot,
    }),
    timestamp: new Date(timestamp).toISOString(),
    content,
    contentSha256: createHash("sha256").update(content).digest("hex"),
  });
}

function parseDiscordMessages(
  value: unknown,
): readonly DiscordRawMessageReceipt[] {
  if (!Array.isArray(value) || value.length > 100) {
    fail("Discord messages response must be an array of at most 100 items");
  }
  return Object.freeze(
    value.map((message, index) => receipt(message, `messages[${index}]`)),
  );
}

async function discordJsonRequest(input: {
  preflight: DiscordOperatorPreflight;
  discordBotToken: string;
  url: URL;
  fetchImpl: DiscordFetch;
  label: string;
}): Promise<{ value: unknown; rawSha256: string }> {
  if (!validatedPreflights.has(input.preflight)) {
    fail(
      "readback requires the exact result of preflightDiscordOperatorCanary",
    );
  }
  if (input.discordBotToken.trim().length < 20) {
    fail("discordBotToken is missing or invalid");
  }
  let response: Response;
  try {
    response = await input.fetchImpl(input.url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bot ${input.discordBotToken}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    // error-policy:J2 preserve the Discord transport cause at the operator boundary.
    throw new Error(
      `discord provider-canary operator Discord ${input.label} failed`,
      { cause: error },
    );
  }
  if (!response.ok) {
    fail(`Discord ${input.label} returned HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    fail(`Discord ${input.label} response exceeds the byte limit`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    fail(`Discord ${input.label} response exceeds the byte limit`);
  }
  try {
    return {
      value: JSON.parse(text),
      rawSha256: createHash("sha256").update(text).digest("hex"),
    };
  } catch (error) {
    // error-policy:J2 retain malformed provider response context without token data.
    throw new Error(
      `discord provider-canary operator Discord ${input.label} returned invalid JSON`,
      { cause: error },
    );
  }
}

async function authenticateDiscordObserver(input: {
  preflight: DiscordOperatorPreflight;
  discordBotToken: string;
  fetchImpl: DiscordFetch;
}): Promise<DiscordObserverIdentityReceipt> {
  const response = await discordJsonRequest({
    ...input,
    url: new URL("/api/v10/users/@me", DISCORD_API_ORIGIN),
    label: "observer identity request",
  });
  const identity = record(response.value, "observerIdentity");
  const userId = snowflake(identity.id, "observerIdentity.id");
  if (identity.bot !== true) {
    fail("Discord observer credential must authenticate a bot principal");
  }
  if (userId !== input.preflight.plan.agentBotUserId) {
    fail("Discord observer credential does not match the bound agent bot");
  }
  return Object.freeze({
    userId,
    bot: true,
    rawResponseSha256: response.rawSha256,
  });
}

async function discordMessagesRequest(input: {
  preflight: DiscordOperatorPreflight;
  discordBotToken: string;
  fetchImpl: DiscordFetch;
}): Promise<readonly DiscordRawMessageReceipt[]> {
  const url = new URL(
    `/api/v10/channels/${input.preflight.plan.channelId}/messages`,
    DISCORD_API_ORIGIN,
  );
  url.searchParams.set("limit", "100");
  const response = await discordJsonRequest({
    ...input,
    url,
    label: "REST readback",
  });
  try {
    return parseDiscordMessages(response.value);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("discord provider-canary")
    ) {
      throw error;
    }
    // error-policy:J2 retain malformed provider response context without token data.
    throw new Error(
      "discord provider-canary operator Discord REST readback returned invalid JSON",
      { cause: error },
    );
  }
}

/**
 * Poll the real Discord channel for a matching human-authored nonce message and
 * a later exact bot-authored provider effect. The result is unsigned private
 * source material and deliberately carries no qualification claim.
 */
export async function collectDiscordRawReadback(input: {
  preflight: DiscordOperatorPreflight;
  discordBotToken: string;
  fetchImpl?: DiscordFetch;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<DiscordRawReadback> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const wait =
    input.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const observerIdentity = await authenticateDiscordObserver({
    preflight: input.preflight,
    discordBotToken: input.discordBotToken,
    fetchImpl,
  });
  const startedAt = now();
  while (now() - startedAt <= input.preflight.plan.poll.timeoutMs) {
    const messages = await discordMessagesRequest({
      preflight: input.preflight,
      discordBotToken: input.discordBotToken,
      fetchImpl,
    });
    const chronological = [...messages].sort(
      (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
    );
    const humanIngress = chronological.find(
      (message) =>
        message.channelId === input.preflight.plan.channelId &&
        message.guildId === input.preflight.plan.guildId &&
        message.author.id === input.preflight.plan.humanOperatorUserId &&
        message.author.bot === false &&
        message.content === input.preflight.plan.expectedHumanIngressContent,
    );
    const providerEffect = humanIngress
      ? chronological.find(
          (message) =>
            Date.parse(message.timestamp) >
              Date.parse(humanIngress.timestamp) &&
            message.messageId !== humanIngress.messageId &&
            message.channelId === input.preflight.plan.channelId &&
            message.guildId === input.preflight.plan.guildId &&
            message.author.id === input.preflight.plan.agentBotUserId &&
            message.author.bot === true &&
            message.content ===
              input.preflight.plan.expectedProviderEffectContent,
        )
      : undefined;
    if (humanIngress && providerEffect) {
      return Object.freeze({
        schema: "eliza.discord-provider-canary-raw-readback.v1",
        collectedAtIso: new Date(now()).toISOString(),
        channelId: input.preflight.plan.channelId,
        observerIdentity,
        humanIngress,
        providerEffect,
        qualificationClaimed: false,
      });
    }
    await wait(input.preflight.plan.poll.intervalMs);
  }
  fail(
    "timed out waiting for the exact human-authored ingress and later bot-authored provider effect",
  );
}
