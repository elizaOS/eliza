/**
 * Proves the launch-critical personal Eliza path against the real local Worker,
 * PGlite database, and Durable Objects. External model credentials are blanked,
 * so no paid provider can be dialed; the OpenRouter backup (the route the
 * shared default model takes once Cerebras is unconfigured) is pointed at an
 * in-spec scripted model that answers the first turn with one fixed capability
 * refusal. Since #22844 the Shared capability wall is no longer a canned reply
 * but a constraint the runtime injects into the model prompt, so the refusal is
 * model-voiced: this spec pins that injected constraint verbatim and counts the
 * scripted model's calls, which also proves the racing first deliveries land
 * exactly one model turn.
 *
 * Harness notes:
 * - Env passthrough: sync-api-dev-vars explicitly recognizes
 *   OPENROUTER_BASE_URL as a provider override, so the fixture can route the
 *   Worker to its ephemeral loopback server without mutating developer env
 *   files or permitting a real OpenRouter request.
 * - Request shape: every Telegram delivery carries the connector account id the
 *   gateway sends (required by the route since #24322), and the Steward claim
 *   carries the explicit Telegram claim confirmation marker (#21925).
 */

import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { mintStewardTokenFromClaims } from "@elizaos/cloud-shared/lib/auth/steward-client";
import { personalSharedAgentId } from "@elizaos/cloud-shared/lib/services/shared-runtime/personal-shared-agent";
// The coverage classifier requires a direct Playwright marker for changed specs.
import type {} from "@playwright/test";
import { retrySharedRuntimeWarming } from "../src/helpers/shared-runtime";
import { test as base, expect } from "../src/helpers/test-fixtures";

const STEWARD_JWT_SECRET = "personal-eliza-first-five-local-secret-32-bytes";
const STEWARD_USER_ID = "steward-personal-eliza-first-five";
const RUN_ID = randomUUID();
const TELEGRAM_USER_ID = BigInt(
  `0x${RUN_ID.replaceAll("-", "").slice(0, 15)}`,
).toString();
const TELEGRAM_CONNECTOR_ACCOUNT = "telegram:first-five-bot";
const CAPABILITY_REQUEST = "save this as a note";
// Served by the in-spec scripted model for the capability request and asserted
// exactly; the runtime voices the wall through the model since #22844.
const CAPABILITY_REPLY =
  "I can't save notes on this chat, so nothing was stored. I'll keep it in our conversation instead: save this as a note.";
// The capability wall the runtime injects for a notes request, pinned verbatim
// to shared-capability-wall.ts (constraint) and run-shared-agent-turn.ts
// (prompt block).
const NOTES_CAPABILITY_CONSTRAINT =
  "Unavailable actions detected in this turn:\n- Notes: This runtime has no separate persistent notes store, so it cannot read or change notes.";

interface SharedDeliveryResponse {
  success?: boolean;
  data?: {
    identity?: { id?: string; runtime?: string };
    account?: { userId?: string; organizationId?: string };
    reply?: string;
    /** Only group turns carry a send authority; a DM turn never does. */
    groupDelivery?: unknown;
  };
  code?: string;
  retryable?: boolean;
}

type OpenAiMessage = { role: string; content?: unknown };
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

interface ScriptedModel {
  /** Scripted OpenAI-compatible `/v1` base the Worker's OpenRouter client dials. */
  url: string;
  /** Chat-completion requests served so far. */
  calls: () => number;
  /** Every prompt the scripted model received, one joined text per call. */
  prompts: string[];
}

/**
 * OpenAI-compatible scripted model (stream + non-stream). It answers the
 * runtime's HANDLE_RESPONSE projection with the fixed capability refusal as
 * `replyText`, which the shared runtime returns as the turn's reply, and
 * records each prompt so the spec can pin the injected capability wall.
 */
function createScriptedModelServer(prompts: string[]): {
  server: Server;
  calls: () => number;
} {
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
      prompts.push(
        (body.messages ?? [])
          .map((message) => `${message.role}: ${contentText(message.content)}`)
          .join("\n"),
      );
      const toolNames = (body.tools ?? [])
        .map((tool) => tool.function?.name ?? tool.name ?? "")
        .filter(Boolean);
      const toolCalls = toolNames.includes("HANDLE_RESPONSE")
        ? [
            {
              id: `call_scripted_${sequence}`,
              type: "function",
              function: {
                name: "HANDLE_RESPONSE",
                arguments: JSON.stringify({
                  shouldRespond: "RESPOND",
                  contexts: ["simple"],
                  intents: ["decline unavailable notes action"],
                  replyText: CAPABILITY_REPLY,
                  replyEffectStatus: "none",
                  candidateActionNames: [],
                  facts: [],
                  relationships: [],
                  topics: ["notes"],
                  addressedTo: [],
                  emotion: "none",
                }),
              },
            },
          ]
        : undefined;
      const id = `chatcmpl-scripted-${sequence}`;
      const created = Math.floor(Date.now() / 1000);
      const model = String(body.model ?? "scripted");
      const usage = {
        prompt_tokens: 42,
        completion_tokens: 24,
        total_tokens: 66,
      };
      const finish = toolCalls ? "tool_calls" : "stop";

      if (body.stream === true) {
        const chunkBase = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
        };
        const delta = toolCalls
          ? {
              role: "assistant",
              tool_calls: toolCalls.map((call) => ({ index: 0, ...call })),
            }
          : { role: "assistant", content: CAPABILITY_REPLY };
        const chunks = [
          { ...chunkBase, choices: [{ index: 0, delta, finish_reason: null }] },
          {
            ...chunkBase,
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
        : { role: "assistant", content: CAPABILITY_REPLY };
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

const test = base.extend<
  Record<never, never>,
  { scriptedModel: ScriptedModel }
>({
  // The scripted model binds an ephemeral loopback port before the stack
  // boots, so the worker env can name it and nothing collides with other
  // local stacks.
  scriptedModel: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright derives fixture dependencies from this destructuring pattern; the model has none.
    async ({}, use) => {
      const prompts: string[] = [];
      const model = createScriptedModelServer(prompts);
      const origin = await listen(model.server);
      try {
        await use({ url: `${origin}/v1`, calls: model.calls, prompts });
      } finally {
        await close(model.server);
      }
    },
    { scope: "worker" },
  ],
  stackOptions: async ({ scriptedModel }, use) => {
    await use({
      frontend: false,
      env: {
        STEWARD_JWT_SECRET,
        STEWARD_TENANT_ID: "elizacloud",
        // The sync script normally preserves real provider keys from a
        // developer's shell/.env. Explicit empty overrides keep this proof
        // offline and free; the OpenRouter backup alone is pointed at the
        // scripted model.
        PRESERVE_E2E_PROVIDER_ENV: "1",
        CEREBRAS_API_KEY: "",
        OPENAI_API_KEY: "",
        OPENAI_BASE_URL: "",
        ANTHROPIC_API_KEY: "",
        GROQ_API_KEY: "",
        OPENROUTER_API_KEY: "local-scripted-model-key",
        OPENROUTER_BASE_URL: scriptedModel.url,
      },
    });
  },
});

interface SharedHistoryResponse {
  messages?: Array<{ id: string; role: "user" | "assistant"; text: string }>;
  code?: string;
  retryable?: boolean;
}

async function readJson<T>(
  response: Response,
): Promise<{ status: number; json: T }> {
  return {
    status: response.status,
    json: (await response.json()) as T,
  };
}

async function postTelegramDelivery(
  apiBase: string,
  input: { messageId: string; message: string },
): Promise<{ status: number; json: SharedDeliveryResponse }> {
  return await readJson<SharedDeliveryResponse>(
    await fetch(`${apiBase}/api/internal/eliza-app/personal-shared/messages`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-internal-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        platform: "telegram",
        project: "eliza-app",
        connectorAccountId: TELEGRAM_CONNECTOR_ACCOUNT,
        chatId: TELEGRAM_USER_ID,
        telegramUserId: TELEGRAM_USER_ID,
        telegramUsername: "first_five_nubs",
        displayName: "Nubs",
        ...input,
      }),
    }),
  );
}

function continuationTokenFromReply(reply: string): string {
  const urlStart = reply.indexOf("http");
  if (urlStart < 0)
    throw new Error("Telegram /connect reply did not include a URL");
  const token = new URL(reply.slice(urlStart)).searchParams.get(
    "onboardingSession",
  );
  if (!token)
    throw new Error("Telegram /connect URL did not include onboardingSession");
  return token;
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
}

async function waitForMirroredHistory(agentId: string): Promise<{
  channelIds: string[];
  history: Array<{ role: "user" | "assistant"; content: string }>;
}> {
  const { sharedRuntimeHistoryRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/shared-runtime-history"
  );
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const channelIds =
      await sharedRuntimeHistoryRepository.listChannelsByAgent(agentId);
    const channelId = channelIds[0];
    const history = channelId
      ? await sharedRuntimeHistoryRepository.get(agentId, channelId)
      : [];
    const visibleHistory = history.filter(
      (entry): entry is typeof entry & { role: "user" | "assistant" } =>
        entry.role !== "system",
    );
    if (channelIds.length === 1 && visibleHistory.length === 2) {
      return { channelIds, history: visibleHistory };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const channelIds =
    await sharedRuntimeHistoryRepository.listChannelsByAgent(agentId);
  const channelId = channelIds[0];
  return {
    channelIds,
    history: channelId
      ? (await sharedRuntimeHistoryRepository.get(agentId, channelId)).filter(
          (entry): entry is typeof entry & { role: "user" | "assistant" } =>
            entry.role !== "system",
        )
      : [],
  };
}

test.describe("personal Eliza first five minutes", () => {
  test("keeps first contact rowless and free, replays it, then claims the same account and history", async ({
    stack,
    scriptedModel,
  }) => {
    test.setTimeout(180_000);

    // Both initial webhook deliveries race before the Telegram account exists.
    // The DB convergence and Durable Object claim ledger must still produce one
    // account and one landed turn rather than duplicate users or model work.
    const firstDeliveries = await Promise.all(
      [0, 1].map(() =>
        retrySharedRuntimeWarming(() =>
          postTelegramDelivery(stack.urls.api, {
            messageId: `telegram:first-five:${RUN_ID}:1`,
            message: CAPABILITY_REQUEST,
          }),
        ),
      ),
    );
    for (const delivery of firstDeliveries) {
      expect(
        delivery.status,
        `first delivery failed: ${JSON.stringify(delivery.json)}`,
      ).toBe(200);
      expect(delivery.json.data?.reply).toBe(CAPABILITY_REPLY);
      expect(delivery.json.data?.identity?.runtime).toBe("shared");
      expect(delivery.json.data?.groupDelivery).toBeUndefined();
    }
    // One landed turn: the racing pair produced exactly one model call, and
    // that call carried the capability wall for the notes request, so the
    // refusal was governed by the runtime rather than improvised by the model.
    expect(scriptedModel.calls()).toBe(1);
    expect(scriptedModel.prompts[0]).toContain(NOTES_CAPABILITY_CONSTRAINT);
    expect(scriptedModel.prompts[0]).toContain(CAPABILITY_REQUEST);

    const account = firstDeliveries[0]?.json.data?.account;
    const personalId = firstDeliveries[0]?.json.data?.identity?.id;
    expect(account?.userId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(account?.organizationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(personalId).toMatch(/^personal:/);
    if (!account?.userId || !account.organizationId || !personalId) {
      throw new Error(
        "first contact did not return the canonical account identity",
      );
    }
    expect(personalId).toBe(
      personalSharedAgentId({
        userId: account.userId,
        organizationId: account.organizationId,
      }),
    );
    expect(firstDeliveries[1]?.json.data?.account).toEqual(account);
    expect(firstDeliveries[1]?.json.data?.identity?.id).toBe(personalId);

    const { usersRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/users"
    );
    const { organizationsRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/organizations"
    );
    const { apiKeysService } = await import(
      "@elizaos/cloud-shared/lib/services/api-keys"
    );
    const { agentSandboxesRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/agent-sandboxes"
    );
    const { containersRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/containers"
    );
    const { jobsRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/jobs"
    );
    const { creditTransactionsRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/credit-transactions"
    );

    const provisional =
      await usersRepository.findByTelegramIdWithOrganization(TELEGRAM_USER_ID);
    expect(provisional?.id).toBe(account.userId);
    expect(provisional?.organization_id).toBe(account.organizationId);
    expect(
      await usersRepository.listByOrganization(account.organizationId),
    ).toHaveLength(1);
    expect(
      (await organizationsRepository.findById(account.organizationId))
        ?.credit_balance,
    ).toBe("0.000000");
    expect(
      await apiKeysService.listByOrganization(account.organizationId),
    ).toHaveLength(0);
    expect(
      await agentSandboxesRepository.listByOrganization(account.organizationId),
    ).toHaveLength(0);
    expect(
      await containersRepository.listByOrganization(account.organizationId),
    ).toHaveLength(0);
    expect(
      await jobsRepository.findByFilters({
        organizationId: account.organizationId,
      }),
    ).toHaveLength(0);
    expect(
      await creditTransactionsRepository.listByOrganization(
        account.organizationId,
      ),
    ).toHaveLength(0);

    const mirrored = await waitForMirroredHistory(personalId);
    expect(mirrored.channelIds).toHaveLength(1);
    expect(
      mirrored.history.map(({ role, content }) => ({ role, content })),
    ).toEqual([
      { role: "user", content: CAPABILITY_REQUEST },
      { role: "assistant", content: CAPABILITY_REPLY },
    ]);

    // /connect creates a separate opaque, account-bound continuation in the
    // real onboarding Durable Object without entering chat or provisioning.
    const connect = await postTelegramDelivery(stack.urls.api, {
      messageId: `telegram:first-five:${RUN_ID}:connect`,
      message: "/connect",
    });
    expect(connect.status, JSON.stringify(connect.json)).toBe(200);
    expect(connect.json.data?.account).toEqual(account);
    expect(connect.json.data?.identity?.id).toBe(personalId);
    expect(connect.json.data?.groupDelivery).toBeUndefined();
    // /connect is route-owned: no model turn.
    expect(scriptedModel.calls()).toBe(1);
    const reply = connect.json.data?.reply;
    if (!reply) throw new Error("Telegram /connect did not return a reply");
    const continuationToken = continuationTokenFromReply(reply);

    const now = Math.floor(Date.now() / 1000);
    const minted = await mintStewardTokenFromClaims(
      { STEWARD_JWT_SECRET },
      {
        userId: STEWARD_USER_ID,
        email: "nubs-first-five@e2e.test",
        tenantId: "elizacloud",
        issuedAt: now,
        expiration: now + 900,
      },
      900,
    );
    if (!minted) throw new Error("local Steward token mint was not configured");

    const claimResponse = await fetch(
      `${stack.urls.api}/api/auth/steward-session`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: stack.urls.api,
        },
        // The browser's explicit claim ceremony: since #21925 a continuation
        // is only honoured with this marker, which ordinary login sync never
        // sends.
        body: JSON.stringify({
          token: minted.token,
          telegramContinuation: continuationToken,
          telegramClaimConfirmation: "explicit",
        }),
      },
    );
    const claimBody = (await claimResponse.clone().json()) as {
      ok?: boolean;
      userId?: string;
      stewardUserId?: string;
    };
    expect(
      claimResponse.status,
      `Steward claim failed: ${JSON.stringify(claimBody)}`,
    ).toBe(200);
    expect(claimBody).toMatchObject({
      ok: true,
      userId: account.userId,
      stewardUserId: STEWARD_USER_ID,
    });

    const claimed =
      await usersRepository.findByStewardIdWithOrganization(STEWARD_USER_ID);
    expect(claimed?.id).toBe(account.userId);
    expect(claimed?.organization_id).toBe(account.organizationId);
    expect(claimed?.telegram_id).toBe(TELEGRAM_USER_ID);
    expect(
      await usersRepository.listByOrganization(account.organizationId),
    ).toHaveLength(1);

    const cookie = cookieHeader(claimResponse);
    expect(cookie).toContain("steward-token-local=");
    const personalResponse = await fetch(
      `${stack.urls.api}/api/v1/eliza/personal`,
      {
        headers: { Cookie: cookie },
      },
    );
    const personalBody = (await personalResponse.json()) as {
      data?: { identity?: { id?: string; runtime?: string } };
    };
    expect(personalResponse.status, JSON.stringify(personalBody)).toBe(200);
    expect(personalBody.data?.identity).toMatchObject({
      id: personalId,
      runtime: "shared",
    });

    const historyPath = `/api/v1/eliza/agents/${encodeURIComponent(
      personalId,
    )}/api/conversations/${encodeURIComponent(personalId)}/messages`;
    const authenticatedHistory = await retrySharedRuntimeWarming(async () =>
      readJson<SharedHistoryResponse>(
        await fetch(`${stack.urls.api}${historyPath}`, {
          headers: { Cookie: cookie },
        }),
      ),
    );
    expect(
      authenticatedHistory.status,
      `authenticated history failed: ${JSON.stringify(authenticatedHistory.json)}`,
    ).toBe(200);
    expect(
      authenticatedHistory.json.messages?.map(({ role, text }) => ({
        role,
        text,
      })),
    ).toEqual([
      { role: "user", text: CAPABILITY_REQUEST },
      { role: "assistant", text: CAPABILITY_REPLY },
    ]);

    // Account claim and authenticated reads must not silently mint spendable
    // balance, an API credential, or any compute/provisioning artifact.
    expect(
      (await organizationsRepository.findById(account.organizationId))
        ?.credit_balance,
    ).toBe("0.000000");
    expect(
      await apiKeysService.listByOrganization(account.organizationId),
    ).toHaveLength(0);
    expect(
      await agentSandboxesRepository.listByOrganization(account.organizationId),
    ).toHaveLength(0);
    expect(
      await containersRepository.listByOrganization(account.organizationId),
    ).toHaveLength(0);
    expect(
      await jobsRepository.findByFilters({
        organizationId: account.organizationId,
      }),
    ).toHaveLength(0);
    expect(
      await creditTransactionsRepository.listByOrganization(
        account.organizationId,
      ),
    ).toHaveLength(0);
    // Nor did the claim or the authenticated reads dispatch any model work.
    expect(scriptedModel.calls()).toBe(1);
  });
});
