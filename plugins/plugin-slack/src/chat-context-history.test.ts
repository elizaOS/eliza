/**
 * The platform chat-context hook runs on every planned Slack turn. It must read
 * the room's stored messages, not page the channel through the Slack API.
 * Drives the real `getConnectorChatContext` with a real @slack/web-api
 * WebClient against a local Slack API that holds a 3,000-message channel.
 */
import http from "node:http";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { WebClient } from "@slack/web-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeAccountId } from "./accounts.ts";
import { SlackService } from "./service.ts";
import type { SlackChannel } from "./types.ts";

const ACCOUNT_ID = "acct-1";
const CHANNEL_ID = "C12345678";
const AGENT_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const HUMAN_ENTITY_ID = "22222222-2222-4222-8222-222222222222" as UUID;
const CHANNEL_MESSAGES = 3000;
const PAGE_SIZE = 15;

const servers: http.Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

/** conversations.history over a long channel, 15 rows per page like Slack. */
function startSlackApi(): Promise<{ apiUrl: string; historyCalls: number[] }> {
  const historyCalls: number[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        if (!req.url?.includes("/conversations.history")) {
          res.end(JSON.stringify({ ok: false, error: "unknown_method" }));
          return;
        }
        const offset = Number(new URLSearchParams(body).get("cursor") ?? 0);
        historyCalls.push(offset);
        const next = offset + PAGE_SIZE;
        res.end(
          JSON.stringify({
            ok: true,
            messages: Array.from({ length: PAGE_SIZE }, (_, index) => ({
              type: "message",
              ts: `${1700000000 - offset - index}.000001`,
              user: "U123HUMAN",
              text: `old message ${offset + index}`,
            })),
            response_metadata: {
              next_cursor: next < CHANNEL_MESSAGES ? String(next) : "",
            },
          }),
        );
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" ? address?.port : 0;
      resolve({ apiUrl: `http://127.0.0.1:${port}/api/`, historyCalls });
    });
  });
}

function storedMessage(
  createdAt: number,
  entityId: UUID,
  text: string,
): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    agentId: AGENT_ID,
    entityId,
    roomId: crypto.randomUUID() as UUID,
    createdAt,
    content: { text, source: "slack", name: "Human" },
  };
}

describe("Slack platform chat context", () => {
  it("reads the room's stored messages without paging the channel history", async () => {
    const { apiUrl, historyCalls } = await startSlackApi();
    const stored = [
      storedMessage(3000, AGENT_ID, "agent reply"),
      storedMessage(2000, HUMAN_ENTITY_ID, "hello"),
      storedMessage(1000, HUMAN_ENTITY_ID, " "),
    ];
    const getMemories = vi.fn(async () => stored);
    const runtime = {
      agentId: AGENT_ID,
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getRoom: vi.fn(async () => null),
      getMemories,
    } as unknown as IAgentRuntime;
    const service = Object.assign(
      Object.create(SlackService.prototype) as SlackService,
      {
        runtime,
        defaultAccountId: ACCOUNT_ID,
        accountStates: new Map([
          [
            normalizeAccountId(ACCOUNT_ID),
            {
              accountId: ACCOUNT_ID,
              account: { accountId: ACCOUNT_ID, name: "A" },
              teamId: "TA",
              botUserId: "B0AGENT",
              client: new WebClient("xoxb-test-token", {
                slackApiUrl: apiUrl,
              }),
            },
          ],
        ]),
        resolveAccountIdForTarget: vi.fn(async () => ACCOUNT_ID),
        getChannel: vi.fn(
          async () => ({ id: CHANNEL_ID, name: "general" }) as SlackChannel,
        ),
        getUser: vi.fn(async () => null),
      },
    );

    const context = await service.getConnectorChatContext(
      { channelId: CHANNEL_ID } as never,
      { runtime, accountId: ACCOUNT_ID } as never,
    );

    expect(historyCalls).toHaveLength(0);
    expect(getMemories).toHaveBeenCalledWith(
      expect.objectContaining({
        tableName: "messages",
        roomId: context?.target.roomId,
      }),
    );
    expect(
      (context?.recentMessages ?? []).map((message) => [
        message.entityId,
        message.text,
      ]),
    ).toEqual([
      [HUMAN_ENTITY_ID, "hello"],
      [AGENT_ID, "agent reply"],
    ]);
  });
});

describe("Slack history date bounds", () => {
  it("sends ISO date bounds to conversations.history as Unix timestamps", async () => {
    // Slack documents latest/oldest as Unix timestamps and answers
    // invalid_ts_latest / invalid_ts_oldest for any other value.
    const bounds: Array<{ latest: string | null; oldest: string | null }> = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const params = new URLSearchParams(body);
        const latest = params.get("latest");
        const oldest = params.get("oldest");
        bounds.push({ latest, oldest });
        res.writeHead(200, { "Content-Type": "application/json" });
        const isTs = (value: string | null) =>
          value === null || /^\d+(\.\d+)?$/.test(value);
        if (!isTs(latest) || !isTs(oldest)) {
          res.end(
            JSON.stringify({
              ok: false,
              error: isTs(latest) ? "invalid_ts_oldest" : "invalid_ts_latest",
            }),
          );
          return;
        }
        res.end(JSON.stringify({ ok: true, messages: [] }));
      });
    });
    servers.push(server);
    const apiUrl = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" ? address?.port : 0;
        resolve(`http://127.0.0.1:${port}/api/`);
      });
    });
    const service = Object.assign(
      Object.create(SlackService.prototype) as SlackService,
      {
        defaultAccountId: ACCOUNT_ID,
        accountStates: new Map([
          [
            normalizeAccountId(ACCOUNT_ID),
            {
              accountId: ACCOUNT_ID,
              client: new WebClient("xoxb-test-token", {
                slackApiUrl: apiUrl,
                retryConfig: { retries: 0 },
              }),
            },
          ],
        ]),
      },
    );

    await (
      service as unknown as {
        readHistory: (
          channelId: string,
          options: { before?: string; after?: string },
          accountId: string,
        ) => Promise<unknown>;
      }
    ).readHistory(
      CHANNEL_ID,
      { before: "2026-10-24T00:00:00Z", after: "2026-10-23" },
      ACCOUNT_ID,
    );

    expect(bounds).toEqual([
      {
        latest: (Date.parse("2026-10-24T00:00:00Z") / 1000).toFixed(6),
        oldest: (Date.parse("2026-10-23") / 1000).toFixed(6),
      },
    ]);
  });
});
