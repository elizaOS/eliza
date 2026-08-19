/** Builds deterministic approval, transport-receipt, and retry contracts around production VOICE_CALL. */

import type { IAgentRuntime } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

const ACCOUNT_SID = "ACconnectorcontract";
const AUTH_TOKEN = "voice-contract-token";
const FROM = "+14155550100";
const TO = "+14155550123";
const BODY = "The appointment is running ten minutes late.";
const MOCK_BASE = "https://twilio.connector-contract.test";
const EXPECTED_AUTH = `Basic ${btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`)}`;

type ObservedRequest = {
  url: string;
  authorization: string | null;
  idempotencyKey: string | null;
  body: string;
};

type VoiceFixture = {
  requests: ObservedRequest[];
  originalFetch: typeof globalThis.fetch;
  previousEnv: Record<string, string | undefined>;
};

const fixtures = new WeakMap<object, VoiceFixture>();

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function installVoiceFixture(retry: boolean) {
  return (ctx: ScenarioContext): string | undefined => {
    const runtime = ctx.runtime as IAgentRuntime;
    const previousEnv = {
      TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
      TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER,
      ELIZA_MOCK_TWILIO_BASE: process.env.ELIZA_MOCK_TWILIO_BASE,
    };
    process.env.TWILIO_ACCOUNT_SID = ACCOUNT_SID;
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    process.env.TWILIO_PHONE_NUMBER = FROM;
    process.env.ELIZA_MOCK_TWILIO_BASE = MOCK_BASE;

    const originalFetch = globalThis.fetch;
    const fixture: VoiceFixture = { requests: [], originalFetch, previousEnv };
    fixtures.set(runtime as object, fixture);
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (!url.startsWith(MOCK_BASE)) return originalFetch(input, init);
      const headers = new Headers(init?.headers);
      fixture.requests.push({
        url,
        authorization: headers.get("Authorization"),
        idempotencyKey: headers.get("I-Twilio-Idempotency-Token"),
        body: String(init?.body ?? ""),
      });
      if (retry && fixture.requests.length === 1) {
        return Response.json(
          { message: "temporary upstream outage" },
          { status: 503 },
        );
      }
      return Response.json({ sid: "CA-contract-001" }, { status: 201 });
    }) as typeof globalThis.fetch;
    return undefined;
  };
}

function cleanupVoiceFixture(ctx: ScenarioContext): string | undefined {
  const runtime = ctx.runtime as IAgentRuntime;
  const fixture = fixtures.get(runtime as object);
  if (!fixture) return undefined;
  globalThis.fetch = fixture.originalFetch;
  for (const [key, value] of Object.entries(fixture.previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fixtures.delete(runtime as object);
  return undefined;
}

function assertHeldDraft(turn: ScenarioTurnExecution): string | undefined {
  const call = turn.actionsCalled.find(
    (candidate) => candidate.actionName === "VOICE_CALL",
  );
  const data = record(call?.result?.data);
  const values = record(call?.result?.values);
  if (
    call?.result?.success !== false ||
    data.draft !== true ||
    data.awaitingUserInput !== true ||
    values.error !== "DRAFT_REQUIRES_CONFIRMATION"
  ) {
    return `first VOICE_CALL turn was not a held approval draft: ${JSON.stringify(call?.result)}`;
  }
  return undefined;
}

function assertVoiceContract(retry: boolean) {
  return (ctx: ScenarioContext): string | undefined => {
    const fixture = fixtures.get(ctx.runtime as object);
    if (!fixture) return "Twilio voice fixture was not installed";
    const calls = ctx.actionsCalled.filter(
      (candidate) => candidate.actionName === "VOICE_CALL",
    );
    if (calls.length !== 2)
      return `expected two VOICE_CALL turns, saw ${calls.length}`;
    const first = record(calls[0]?.result?.data);
    if (first.draft !== true || first.awaitingUserInput !== true) {
      return `dispatch was not preceded by a held draft: ${JSON.stringify(first)}`;
    }
    const result = calls[1]?.result;
    const data = record(result?.data);
    const expectedRequests = retry ? 2 : 1;
    if (
      result?.success !== true ||
      data.sid !== "CA-contract-001" ||
      data.status !== 201 ||
      data.retryCount !== (retry ? 1 : 0)
    ) {
      return `confirmed VOICE_CALL omitted the exact Twilio receipt: ${JSON.stringify(result)}`;
    }
    if (fixture.requests.length !== expectedRequests) {
      return `expected ${expectedRequests} Twilio attempts, saw ${fixture.requests.length}`;
    }
    const idempotencyKeys = new Set<string>();
    for (const request of fixture.requests) {
      if (
        request.url !==
        `${MOCK_BASE}/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`
      ) {
        return `unexpected Twilio endpoint: ${request.url}`;
      }
      if (request.authorization !== EXPECTED_AUTH) {
        return `Twilio request omitted exact Basic auth: ${request.authorization}`;
      }
      const form = new URLSearchParams(request.body);
      if (
        form.get("To") !== TO ||
        form.get("From") !== FROM ||
        form.get("Twiml") !== `<Response><Say>${BODY}</Say></Response>`
      ) {
        return `Twilio request payload was not exact: ${request.body}`;
      }
      if (!request.idempotencyKey?.startsWith("voice-call:")) {
        return "Twilio request omitted its confirmation-bound idempotency key";
      }
      idempotencyKeys.add(request.idempotencyKey);
    }
    if (
      idempotencyKeys.size !== 1 ||
      data.idempotencyKey !== [...idempotencyKeys][0]
    ) {
      return "retry attempts and action receipt did not share one idempotency key";
    }
    return undefined;
  };
}

export function buildVoiceCallDraftContract(config: {
  evidenceScope: "connector-contract";
  id: string;
  title: string;
  replay?: boolean;
}) {
  const retry = config.replay === true;
  const options = {
    parameters: {
      action: "dial",
      recipientKind: "e164",
      phoneNumber: TO,
      bodyText: BODY,
      reason: "appointment update",
    },
  };
  const routing = {
    metadata: { __responseContext: { primaryContext: "phone" } },
  };
  return scenario({
    lane: "pr-deterministic",
    id: config.id,
    title: config.title,
    domain: "connector-contract",
    evidenceScope: config.evidenceScope,
    executionProfile: "simulated",
    tags: [
      "connector-contract",
      "twilio-voice",
      "approval-gate",
      "provider-receipt",
      ...(retry ? ["retry-idempotent"] : []),
    ],
    description:
      "Executes production VOICE_CALL through its confirmation gate and Twilio transport against a deterministic HTTP boundary. It proves no pre-approval request, exact target/TwiML/auth, a provider SID receipt, and one stable confirmation-bound idempotency key across transient retries; it does not claim a live PSTN call.",
    isolation: "per-scenario",
    requires: { plugins: ["@elizaos/plugin-agent-skills"] },
    seed: [
      {
        type: "custom",
        name: "install deterministic Twilio voice boundary",
        apply: installVoiceFixture(retry),
      },
    ],
    cleanup: [
      {
        type: "custom",
        name: "restore Twilio voice boundary",
        apply: cleanupVoiceFixture,
      },
    ],
    rooms: [
      {
        id: "main",
        source: "dashboard",
        channelType: "DM",
        title: config.title,
      },
    ],
    turns: [
      {
        kind: "action",
        name: "voice-call-draft",
        room: "main",
        actionName: "VOICE_CALL",
        text: "Call the number with the exact appointment update.",
        content: routing,
        options,
        assertTurn: assertHeldDraft,
      },
      {
        kind: "action",
        name: "voice-call-confirm",
        room: "main",
        actionName: "VOICE_CALL",
        text: "Yes, place that exact call now.",
        content: routing,
        options,
      },
    ],
    finalChecks: [
      {
        type: "actionCalled",
        actionName: "VOICE_CALL",
        status: "success",
        minCount: 1,
      },
      {
        type: "actionCalled",
        actionName: "VOICE_CALL",
        status: "failure",
        minCount: 1,
      },
      {
        type: "custom",
        name: `${config.id}-approval-transport-receipt`,
        predicate: assertVoiceContract(retry),
      },
    ],
  });
}
