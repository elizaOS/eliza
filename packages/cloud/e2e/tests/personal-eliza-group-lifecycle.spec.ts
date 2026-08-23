/**
 * Proves the Personal Shared GROUP-CHAT lifecycle against the real local
 * Worker, PGlite database, and Durable Objects — the nine-step choreography
 * verified live in the group-sim proof run: first-DM auto-account, `/group`
 * claim, group link, mention reply, mention_only silence, ambient-on + ambient
 * reply, an owner group reminder fired by the cron INTO the group, non-owner
 * control rejection, and leave + the inactive-link copy afterwards.
 *
 * Deterministic and offline. Every real provider key is blanked, and the
 * OpenRouter backup (the route the shared default model takes once Cerebras is
 * unconfigured) is pointed at an in-spec scripted model that replays the exact
 * HANDLE_RESPONSE / REMINDERS tool-call protocol the live run recorded. The
 * reminder cron's connector egress is captured by an in-spec gateway stand-in
 * on `ELIZA_APP_WEBHOOK_GATEWAY_URL`, so the "Reminder for this group from …"
 * payload is asserted at the same `/internal/deliver` boundary production
 * uses. Command, policy, link, and claim copy is pinned verbatim to the route
 * source (packages/cloud/api/internal/eliza-app/personal-shared/messages/route.ts).
 *
 * Harness notes:
 * - Env passthrough: the Worker only sees env keys sync-api-dev-vars knows
 *   (.env.example keys, real values in cloud/shared/.env[.local], and the
 *   provider-key allowlist). OPENROUTER_BASE_URL is not in .env.example, so
 *   this spec requires an `OPENROUTER_BASE_URL=` line in cloud/shared/.env or
 *   .env.local (any value — the spec's override wins). The worker fixture
 *   fails fast with that instruction instead of letting the Worker dial the
 *   real OpenRouter host with the scripted key.
 * - Schema seam: the fresh-DB migrate lane pauses at the 0282 usage-quotas
 *   release barrier, so the 0297 group tables never exist on a booted e2e
 *   stack. `ensureGroupTables` applies that one migration's DDL directly
 *   (idempotent). On current develop the group tables also need 0303 / 0304
 *   (authority_version / delivery_lease); this worktree is on the older base.
 * - The scripted REMINDERS call schedules 0.05 minutes (3 s) so the cron lane
 *   stays fast; the plugin acks the model-scheduled delay verbatim.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
// The coverage classifier requires a direct Playwright marker for changed specs.
import type {} from "@playwright/test";
import { retrySharedRuntimeWarming } from "../src/helpers/shared-runtime";
import { test as base, expect } from "../src/helpers/test-fixtures";

const CLOUD_SHARED_DIR = resolve(import.meta.dirname, "../../shared");
const GROUP_TABLES_MIGRATION = resolve(
  CLOUD_SHARED_DIR,
  "src/db/migrations/0297_personal_shared_group_bindings.sql",
);

const GATEWAY_SECRET = "local-e2e-gateway-internal-secret";
const INTERNAL_AUTH = "Bearer test-internal-secret";
const CRON_AUTH = "Bearer test-cron-secret";

const PROJECT = "eliza-app";
const CONNECTOR_ACCOUNT = "+15550009999";
const OWNER_PHONE = "+15550001111";
const PARTICIPANT_PHONE = "+15550002222";
const GROUP_CHAT_ID = "chat_demo123";

// Scripted model replies (served by the in-spec model server, asserted exactly).
const DM_REPLY =
  "Hi! I'm Eliza. I can chat with you here over iMessage, answer questions, set free reminders, and join your group chats — DM me /group to link one.";
const MENTION_REPLY =
  "For a quiet dinner I'd try a small ramen bar or a cozy trattoria — somewhere with booths, not a sports bar. Want me to pick between the two?";
const AMBIENT_REPLY =
  "Friday sounds good — want me to set a reminder so nobody forgets?";
const DEFAULT_REPLY = "Noted! I'm here if the group needs me.";

const REMINDER_CREATE_MESSAGE = "Eliza remind us in 2 minutes: pizza time";
const REMINDER_ACK = "Got it — I'll remind this group in 3 seconds: pizza time";
const REMINDER_EGRESS_TEXT =
  "Reminder for this group from the group owner: pizza time";

// Route-source copy pinned verbatim.
const GROUP_BOUND_REPLY =
  "Eliza is linked to this group. I respond to explicit mentions, commands, and replies by default. The owner can say `Eliza ambient on`, `Eliza ambient off`, or `Eliza leave`.";
const AMBIENT_ON_REPLY =
  "Ambient replies are on. I may respond without a mention when I have something useful to add. Say `Eliza ambient off` to return to mention-only.";
const OWNER_REQUIRED_REPLY =
  "Only the owner who linked Eliza can change this group's response policy.";
const REVOKED_REPLY =
  "This group is disconnected from your Eliza. Remove the bot/account here, or DM Eliza `/group` later to reconnect.";
const SUSPENDED_REPLY =
  "This group link is inactive. The owner can DM Eliza `/group` to reconnect it.";

interface DeliveryResponse {
  success?: boolean;
  data?: {
    code?: string;
    identity?: { id?: string; runtime?: string };
    account?: { userId?: string; organizationId?: string };
    reply?: string;
  };
  code?: string;
  error?: string;
  retryable?: boolean;
}

interface CronResponse {
  success?: boolean;
  stats?: {
    scanned: number;
    fired: number;
    raced: number;
    deferred: number;
    failed: number;
  };
}

interface CapturedDelivery {
  internalSecret: string | undefined;
  body: {
    platform?: string;
    project?: string;
    chatId?: string;
    text?: string;
    idempotencyKey?: string;
  };
}

type OpenAiMessage = { role: string; content?: unknown; tool_calls?: unknown };
interface ChatCompletionBody {
  model?: string;
  stream?: boolean;
  messages?: OpenAiMessage[];
  tools?: Array<{ type?: string; function?: { name?: string }; name?: string }>;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .filter(Boolean)
    .join(" ");
}

/**
 * The shared runtime packs the whole turn into one user message; the live user
 * turn follows the final "message:user:" marker. Fall back to the raw last
 * user message for plain OpenAI-style calls (same rule the live proof used).
 */
function currentTurnText(messages: OpenAiMessage[]): string {
  let lastUser = "";
  for (const message of messages) {
    if (message.role === "user") lastUser = contentText(message.content);
  }
  const marker = lastUser.lastIndexOf("message:user:");
  return marker >= 0
    ? lastUser.slice(marker + "message:user:".length).trim()
    : lastUser;
}

function cannedReply(current: string): string {
  if (/what can you do/i.test(current)) return DM_REPLY;
  if (/dinner/i.test(current)) return MENTION_REPLY;
  if (/friday/i.test(current)) return AMBIENT_REPLY;
  return DEFAULT_REPLY;
}

/**
 * Scripted replay of the two-stage tool protocol the live group-sim run
 * recorded: a HANDLE_RESPONSE projection first, then a native REMINDERS create
 * when the turn is a reminder command, then (if the runtime ever asks again
 * with the tool result) the tool-result echo as the final assistant text.
 */
function decide(body: ChatCompletionBody): {
  content: string | null;
  toolCall?: { name: string; arguments: string };
} {
  const messages = body.messages ?? [];
  const toolNames = (body.tools ?? [])
    .map((tool) => tool.function?.name ?? tool.name ?? "")
    .filter(Boolean);
  const hadToolResult = messages.some((message) => message.role === "tool");
  const current = currentTurnText(messages);
  const wantsReminder = /\bremind\b/i.test(current);

  if (toolNames.includes("HANDLE_RESPONSE")) {
    const args = {
      shouldRespond: "RESPOND",
      contexts: wantsReminder ? [] : ["simple"],
      intents: wantsReminder ? ["create group reminder"] : ["reply to group"],
      replyText: wantsReminder ? "On it." : cannedReply(current),
      replyEffectStatus: "none",
      candidateActionNames: wantsReminder ? ["REMINDERS"] : [],
      facts: [],
      relationships: [],
      topics: ["group chat"],
      addressedTo: [],
      emotion: "none",
    };
    return {
      content: null,
      toolCall: { name: "HANDLE_RESPONSE", arguments: JSON.stringify(args) },
    };
  }

  if (toolNames.includes("REMINDERS") && wantsReminder && !hadToolResult) {
    const reminderText =
      current
        .match(/in\s+\d+\s*min(?:ute)?s?\s*:\s*([^\n"}\\]+)/i)?.[1]
        ?.trim() ?? "pizza time";
    return {
      content: null,
      toolCall: {
        name: "REMINDERS",
        arguments: JSON.stringify({
          operation: "create",
          reminderText,
          // 0.05 minutes = 3000 ms — a CI-fast due time the cron can fire.
          inMinutes: 0.05,
        }),
      },
    };
  }

  if (hadToolResult) {
    let toolText = "";
    for (const message of messages) {
      if (message.role === "tool") toolText = contentText(message.content);
    }
    return { content: toolText.trim() || "Done." };
  }

  return { content: cannedReply(current) };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function respondJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

/** Bind a loopback server on an ephemeral port and return its origin. */
function listen(server: Server): Promise<string> {
  return new Promise((resolveOrigin, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveOrigin(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClosed, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolveClosed()));
  });
}

interface ScriptedModelServer {
  server: Server;
  calls: () => number;
}

/** OpenAI-compatible scripted model server (stream + non-stream + tool calls). */
function createScriptedModelServer(): ScriptedModelServer {
  let sequence = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? "";
      if (request.method === "GET" && url.endsWith("/models")) {
        respondJson(response, 200, { object: "list", data: [] });
        return;
      }
      if (request.method !== "POST" || !url.endsWith("/chat/completions")) {
        respondJson(response, 404, { error: { message: "not found" } });
        return;
      }
      let body: ChatCompletionBody;
      try {
        body = JSON.parse(await readBody(request)) as ChatCompletionBody;
      } catch {
        // error-policy:J3 malformed model input is explicitly invalid.
        respondJson(response, 400, { error: { message: "bad json" } });
        return;
      }
      sequence += 1;
      const decision = decide(body);
      const id = `chatcmpl-scripted-${sequence}`;
      const created = Math.floor(Date.now() / 1000);
      const model = String(body.model ?? "scripted");
      const usage = {
        prompt_tokens: 42,
        completion_tokens: 24,
        total_tokens: 66,
      };
      const finish = decision.toolCall ? "tool_calls" : "stop";
      const toolCalls = decision.toolCall
        ? [
            {
              id: `call_scripted_${sequence}`,
              type: "function",
              function: decision.toolCall,
            },
          ]
        : undefined;

      if (body.stream === true) {
        const base = { id, object: "chat.completion.chunk", created, model };
        const delta = toolCalls
          ? {
              role: "assistant",
              tool_calls: toolCalls.map((call) => ({ index: 0, ...call })),
            }
          : { role: "assistant", content: decision.content };
        const chunks = [
          { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
          {
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: finish }],
            usage,
          },
        ];
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        response.end(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`,
        );
        return;
      }

      const message = toolCalls
        ? { role: "assistant", content: null, tool_calls: toolCalls }
        : { role: "assistant", content: decision.content };
      respondJson(response, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message, finish_reason: finish, logprobs: null }],
        usage,
      });
    })().catch(() => {
      // error-policy:J1 the scripted model boundary answers one HTTP failure.
      if (!response.writableEnded) {
        respondJson(response, 500, {
          error: { message: "scripted model failure" },
        });
      }
    });
  });
  return { server, calls: () => sequence };
}

/** Connector-gateway stand-in capturing the cron's `/internal/deliver` egress. */
function createGatewayCaptureServer(captured: CapturedDelivery[]): Server {
  let sequence = 0;
  return createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/internal/deliver") {
        respondJson(response, 404, { error: "not found" });
        return;
      }
      const raw = await readBody(request);
      let body: CapturedDelivery["body"];
      try {
        body = JSON.parse(raw) as CapturedDelivery["body"];
      } catch {
        // error-policy:J3 malformed gateway input is explicitly invalid.
        respondJson(response, 400, { error: "bad json" });
        return;
      }
      const secretHeader = request.headers["x-internal-secret"];
      captured.push({
        internalSecret: Array.isArray(secretHeader)
          ? secretHeader[0]
          : secretHeader,
        body,
      });
      sequence += 1;
      respondJson(response, 200, {
        success: true,
        acceptedAt: new Date().toISOString(),
        idempotencyKey: body.idempotencyKey,
        providerMessageIds: [`mock_blooio_msg_${sequence}`],
      });
    })().catch(() => {
      // error-policy:J1 the capture boundary answers one HTTP failure.
      if (!response.writableEnded) {
        respondJson(response, 500, { error: "gateway capture failure" });
      }
    });
  });
}

/**
 * sync-api-dev-vars forwards a process-env override into the Worker's
 * `.dev.vars` only for keys it already knows. Fail before the stack boots when
 * OPENROUTER_BASE_URL cannot reach the Worker, naming the fix.
 */
function assertScriptedModelRouteIsForwardable(): void {
  const known = [".env.example", ".env", ".env.local"].some((name) => {
    const file = resolve(CLOUD_SHARED_DIR, name);
    return (
      existsSync(file) &&
      /^\s*OPENROUTER_BASE_URL\s*=\s*\S/m.test(readFileSync(file, "utf8"))
    );
  });
  if (!known) {
    throw new Error(
      "personal-eliza-group-lifecycle needs the Worker to honour OPENROUTER_BASE_URL, " +
        "which sync-api-dev-vars only forwards for keys present in cloud/shared/.env[.local]. " +
        "Add a line `OPENROUTER_BASE_URL=http://127.0.0.1:1/v1` to packages/cloud/shared/.env.local " +
        "(any value; this spec overrides it with the scripted model URL).",
    );
  }
}

interface GroupHarness {
  /** Scripted OpenAI-compatible `/v1` base the Worker's OpenRouter client dials. */
  modelUrl: string;
  /** Gateway origin the reminder cron posts `/internal/deliver` to. */
  gatewayUrl: string;
  /** Chat-completion requests the scripted model has served so far. */
  modelCalls: () => number;
  /** Every `/internal/deliver` payload the cron dispatched, in order. */
  deliveries: CapturedDelivery[];
}

const test = base.extend<Record<never, never>, { groupHarness: GroupHarness }>({
  // Both stand-ins bind ephemeral loopback ports before the stack boots, so
  // the worker env can name them and nothing collides with other local stacks.
  groupHarness: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright derives fixture dependencies from this destructuring pattern; the harness has none.
    async ({}, use) => {
      assertScriptedModelRouteIsForwardable();
      const deliveries: CapturedDelivery[] = [];
      const model = createScriptedModelServer();
      const gateway = createGatewayCaptureServer(deliveries);
      const modelOrigin = await listen(model.server);
      const gatewayUrl = await listen(gateway);
      try {
        await use({
          modelUrl: `${modelOrigin}/v1`,
          gatewayUrl,
          modelCalls: model.calls,
          deliveries,
        });
      } finally {
        await close(model.server);
        await close(gateway);
      }
    },
    { scope: "worker" },
  ],
  stackOptions: async ({ groupHarness }, use) => {
    await use({
      frontend: false,
      env: {
        // The sync script normally preserves real provider keys from the
        // developer's shell/.env.local. Blank them all so no paid provider can
        // be dialed, then point the OpenRouter backup at the scripted model.
        PRESERVE_E2E_PROVIDER_ENV: "1",
        CEREBRAS_API_KEY: "",
        OPENAI_API_KEY: "",
        OPENAI_BASE_URL: "",
        ANTHROPIC_API_KEY: "",
        GROQ_API_KEY: "",
        OPENROUTER_API_KEY: "local-scripted-model-key",
        OPENROUTER_BASE_URL: groupHarness.modelUrl,
        // The reminder cron dispatches group deliveries to this gateway URL
        // with this internal secret; the capture server stands at that boundary.
        ELIZA_APP_WEBHOOK_GATEWAY_URL: groupHarness.gatewayUrl,
        GATEWAY_INTERNAL_SECRET: GATEWAY_SECRET,
      },
    });
  },
});

async function readJson<T>(
  response: Response,
): Promise<{ status: number; json: T }> {
  return { status: response.status, json: (await response.json()) as T };
}

/**
 * Harness seam for the 0282 release barrier (see the header): apply the 0297
 * group-binding DDL directly when the booted stack's schema lacks it.
 * Everything else this spec touches (users, organizations, shared history,
 * shared scheduled tasks) predates the barrier.
 */
async function ensureGroupTables(): Promise<void> {
  const { executeSharedSchedulingSql } = await import(
    "@elizaos/cloud-shared/lib/services/shared-runtime/shared-scheduling"
  );
  const existing = await executeSharedSchedulingSql(
    "SELECT to_regclass('personal_shared_group_claims') AS claims",
  );
  if (existing[0]?.claims) return;
  const statements = readFileSync(GROUP_TABLES_MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) {
    await executeSharedSchedulingSql(statement);
  }
}

function postDelivery(
  apiBase: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; json: DeliveryResponse }> {
  return retrySharedRuntimeWarming(async () =>
    readJson<DeliveryResponse>(
      await fetch(
        `${apiBase}/api/internal/eliza-app/personal-shared/messages`,
        {
          method: "POST",
          headers: {
            Authorization: INTERNAL_AUTH,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      ),
    ),
  );
}

async function sweepSharedScheduledTasks(
  apiBase: string,
): Promise<NonNullable<CronResponse["stats"]>> {
  const sweep = await readJson<CronResponse>(
    await fetch(`${apiBase}/api/cron/shared-scheduled-tasks`, {
      method: "POST",
      headers: { Authorization: CRON_AUTH },
    }),
  );
  expect(sweep.status, JSON.stringify(sweep.json)).toBe(200);
  if (!sweep.json.stats) throw new Error("cron sweep returned no stats");
  return sweep.json.stats;
}

function blooioDm(
  phoneNumber: string,
  messageId: string,
  message: string,
): Record<string, unknown> {
  return {
    platform: "blooio",
    project: PROJECT,
    connectorAccountId: CONNECTOR_ACCOUNT,
    phoneNumber,
    messageId: `blooio:${PROJECT}:${messageId}`,
    message,
  };
}

function blooioGroup(
  sender: string,
  messageId: string,
  message: string,
  invocation: "mention" | "command" | "reply" | "ambient",
): Record<string, unknown> {
  return {
    platform: "blooio",
    chatType: "group",
    project: PROJECT,
    connectorAccountId: CONNECTOR_ACCOUNT,
    chatId: GROUP_CHAT_ID,
    actor: { platformUserId: sender, role: "possessor" },
    messageId: `blooio:${PROJECT}:${messageId}`,
    message,
    invocation,
  };
}

test.describe("personal Eliza group lifecycle", () => {
  test("first DM auto-account → /group claim → link → mention/ambient policy → cron-fired group reminder → owner controls → leave", async ({
    stack,
    groupHarness,
  }) => {
    test.setTimeout(180_000);
    const api = stack.urls.api;
    await ensureGroupTables();
    let personalId = "";
    let account: { userId?: string; organizationId?: string } | undefined;
    let claimCode = "";

    await test.step("1. first DM from a new phone auto-creates the account and replies", async () => {
      const first = await postDelivery(
        api,
        blooioDm(OWNER_PHONE, "step1-dm-hello", "Hey Eliza, what can you do?"),
      );
      expect(first.status, JSON.stringify(first.json)).toBe(200);
      expect(first.json.data?.reply).toBe(DM_REPLY);
      expect(first.json.data?.identity?.id).toMatch(/^personal:/);
      expect(first.json.data?.identity?.runtime).toBe("shared");
      expect(first.json.data?.account?.userId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(first.json.data?.account?.organizationId).toMatch(
        /^[0-9a-f-]{36}$/i,
      );
      expect(groupHarness.modelCalls()).toBe(1);
      personalId = first.json.data?.identity?.id ?? "";
      account = first.json.data?.account;
    });

    await test.step("2. DM /group issues a one-time claim code", async () => {
      const claim = await postDelivery(
        api,
        blooioDm(OWNER_PHONE, "step2-dm-group", "/group"),
      );
      expect(claim.status, JSON.stringify(claim.json)).toBe(200);
      expect(claim.json.data?.code).toBe("group_claim_issued");
      expect(claim.json.data?.identity?.id).toBe(personalId);
      expect(claim.json.data?.account).toEqual(account);
      const reply = claim.json.data?.reply ?? "";
      const code = reply.match(/^Eliza link ([2-9A-HJ-NP-Z]{8})$/m)?.[1];
      if (!code) throw new Error(`no link code in claim reply: ${reply}`);
      claimCode = code;
      expect(reply).toBe(
        `Add Eliza to the group, then send this there within 10 minutes:\n\nEliza link ${claimCode}\n\nUse the same iMessage identity that requested this code.`,
      );
      // Commands are answered by the route, never by the model.
      expect(groupHarness.modelCalls()).toBe(1);
    });

    await test.step("3. group link binds the chat and states the owner controls", async () => {
      const bound = await postDelivery(
        api,
        blooioGroup(
          OWNER_PHONE,
          "step3-group-link",
          `Eliza link ${claimCode}`,
          "command",
        ),
      );
      expect(bound.status, JSON.stringify(bound.json)).toBe(200);
      expect(bound.json.data?.code).toBe("group_bound");
      expect(bound.json.data?.identity?.id).toBe(personalId);
      expect(bound.json.data?.account).toEqual(account);
      expect(bound.json.data?.reply).toBe(GROUP_BOUND_REPLY);
      expect(groupHarness.modelCalls()).toBe(1);
    });

    await test.step("4. a different participant's mention is answered into the group", async () => {
      const mention = await postDelivery(
        api,
        blooioGroup(
          PARTICIPANT_PHONE,
          "step4-group-mention",
          "@eliza where should we get dinner, quiet place?",
          "mention",
        ),
      );
      expect(mention.status, JSON.stringify(mention.json)).toBe(200);
      expect(mention.json.data?.reply).toBe(MENTION_REPLY);
      // The group turn runs under the owner's canonical personal agent.
      expect(mention.json.data?.identity?.id).toBe(personalId);
      expect(mention.json.data?.account).toEqual(account);
      expect(groupHarness.modelCalls()).toBe(2);
    });

    await test.step("5. an ambient message stays silent under the default mention_only policy", async () => {
      const ambient = await postDelivery(
        api,
        blooioGroup(
          PARTICIPANT_PHONE,
          "step5-group-ambient",
          "honestly I could also just cook at home tonight",
          "ambient",
        ),
      );
      expect(ambient.status, JSON.stringify(ambient.json)).toBe(200);
      expect(ambient.json.data).toEqual({ code: "group_silent", reply: "" });
      // The silent branch answers before any runtime dispatch: no model call,
      // no identity or account projection, and no outbound send.
      expect(groupHarness.modelCalls()).toBe(2);
      expect(groupHarness.deliveries).toHaveLength(0);
    });

    await test.step("6. owner enables ambient; a plain message then gets a reply", async () => {
      const policy = await postDelivery(
        api,
        blooioGroup(
          OWNER_PHONE,
          "step6a-ambient-on",
          "Eliza ambient on",
          "command",
        ),
      );
      expect(policy.status, JSON.stringify(policy.json)).toBe(200);
      expect(policy.json.data?.code).toBe("group_policy_updated");
      expect(policy.json.data?.reply).toBe(AMBIENT_ON_REPLY);

      const ambient = await postDelivery(
        api,
        blooioGroup(
          PARTICIPANT_PHONE,
          "step6b-ambient-chat",
          "ok so friday works for everyone right",
          "ambient",
        ),
      );
      expect(ambient.status, JSON.stringify(ambient.json)).toBe(200);
      expect(ambient.json.data?.reply).toBe(AMBIENT_REPLY);
      expect(groupHarness.modelCalls()).toBe(3);
    });

    await test.step("7. owner group reminder is acked, then cron-fired INTO the group", async () => {
      const created = await postDelivery(
        api,
        blooioGroup(
          OWNER_PHONE,
          "step7-group-reminder",
          REMINDER_CREATE_MESSAGE,
          "command",
        ),
      );
      expect(created.status, JSON.stringify(created.json)).toBe(200);
      expect(created.json.data?.reply).toBe(REMINDER_ACK);
      // HANDLE_RESPONSE projection, then the native REMINDERS tool call.
      expect(groupHarness.modelCalls()).toBe(5);
      // Creation only schedules; nothing reaches the connector until the cron.
      expect(groupHarness.deliveries).toHaveLength(0);

      // The task is due 3 s after creation; sweep the real cron route until it
      // claims and fires it through the gateway dispatcher.
      let fired = 0;
      let lastStats: CronResponse["stats"];
      for (let attempt = 0; attempt < 15 && fired === 0; attempt += 1) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
        lastStats = await sweepSharedScheduledTasks(api);
        expect(lastStats.failed, JSON.stringify(lastStats)).toBe(0);
        fired += lastStats.fired;
      }
      expect(
        fired,
        `cron never fired the reminder: ${JSON.stringify(lastStats)}`,
      ).toBe(1);

      // The provider egress the cron dispatched — captured verbatim at the
      // gateway's /internal/deliver boundary, in the provider-addressable
      // wire shape (binding id and owner label never leave the Worker).
      expect(groupHarness.deliveries).toHaveLength(1);
      const delivery = groupHarness.deliveries[0];
      expect(delivery.internalSecret).toBe(GATEWAY_SECRET);
      expect(delivery.body).toEqual({
        platform: "blooio",
        project: PROJECT,
        chatId: GROUP_CHAT_ID,
        text: REMINDER_EGRESS_TEXT,
        idempotencyKey: expect.stringMatching(
          /^st_[0-9a-z]+_[0-9a-z]+:\d{4}-\d{2}-\d{2}T/,
        ),
      });

      // A fired one-off never fires twice.
      const again = await sweepSharedScheduledTasks(api);
      expect(again.fired, JSON.stringify(again)).toBe(0);
      expect(again.failed, JSON.stringify(again)).toBe(0);
      expect(groupHarness.deliveries).toHaveLength(1);
    });

    await test.step("8. a non-owner control command is rejected", async () => {
      const rejected = await postDelivery(
        api,
        blooioGroup(
          PARTICIPANT_PHONE,
          "step8-nonowner-off",
          "Eliza ambient off",
          "command",
        ),
      );
      expect(rejected.status, JSON.stringify(rejected.json)).toBe(200);
      expect(rejected.json.data?.code).toBe("group_owner_required");
      expect(rejected.json.data?.reply).toBe(OWNER_REQUIRED_REPLY);
    });

    await test.step("9. owner leave revokes the binding; later messages get the inactive-link copy", async () => {
      const left = await postDelivery(
        api,
        blooioGroup(OWNER_PHONE, "step9a-leave", "Eliza leave", "command"),
      );
      expect(left.status, JSON.stringify(left.json)).toBe(200);
      expect(left.json.data?.code).toBe("group_binding_revoked");
      expect(left.json.data?.reply).toBe(REVOKED_REPLY);

      const afterMention = await postDelivery(
        api,
        blooioGroup(
          PARTICIPANT_PHONE,
          "step9b-mention-after-leave",
          "@eliza are you still there?",
          "mention",
        ),
      );
      expect(afterMention.status, JSON.stringify(afterMention.json)).toBe(200);
      expect(afterMention.json.data?.code).toBe("group_binding_suspended");
      expect(afterMention.json.data?.reply).toBe(SUSPENDED_REPLY);

      // Ambient messages in the revoked state are silent per the same branch.
      const afterAmbient = await postDelivery(
        api,
        blooioGroup(
          PARTICIPANT_PHONE,
          "step9c-ambient-after-leave",
          "guess she left",
          "ambient",
        ),
      );
      expect(afterAmbient.status, JSON.stringify(afterAmbient.json)).toBe(200);
      expect(afterAmbient.json.data?.code).toBe("group_binding_suspended");
      expect(afterAmbient.json.data?.reply).toBe("");

      // Steps 8–9 are route-owned: the scripted model saw no further turns and
      // the connector received nothing beyond the one cron-fired reminder.
      expect(groupHarness.modelCalls()).toBe(5);
      expect(groupHarness.deliveries).toHaveLength(1);
    });
  });
});
