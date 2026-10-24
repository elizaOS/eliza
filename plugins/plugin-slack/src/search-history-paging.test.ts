/**
 * MESSAGE op=search with a limit reads a Slack channel through
 * `searchConnectorMessages`. History pages arrive newest-first, so the search
 * has its newest `limit` matches as soon as it has read them. Drives the real
 * search with a real AgentRuntime and a real @slack/web-api WebClient against
 * a local Slack API that holds a 3,000-message channel.
 */
import http from "node:http";
import { AgentRuntime } from "@elizaos/core";
import { WebClient } from "@slack/web-api";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeAccountId } from "./accounts.ts";
import { SlackService } from "./service.ts";

const ACCOUNT_ID = "acct-1";
const CHANNEL_ID = "C12345678";
const CHANNEL_MESSAGES = 3000;
const PAGE_SIZE = 15;
const NEWEST_TS = 1700000000;

// Row index (0 = newest) -> text or author that the searches below look for.
const DEPLOY_ROWS = new Set([3, 40]);
const ALICE_ROW = 20;

const servers: http.Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

function historyRow(index: number) {
  return {
    type: "message",
    ts: `${NEWEST_TS - index}.000001`,
    user: index === ALICE_ROW ? "U0ALICE01" : "U123HUMAN",
    text: DEPLOY_ROWS.has(index)
      ? `deploy note ${index}`
      : `chat message ${index}`,
  };
}

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
        const form = new URLSearchParams(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        if (req.url?.includes("/conversations.history")) {
          const offset = Number(form.get("cursor") ?? 0);
          historyCalls.push(offset);
          const next = offset + PAGE_SIZE;
          res.end(
            JSON.stringify({
              ok: true,
              messages: Array.from({ length: PAGE_SIZE }, (_, index) =>
                historyRow(offset + index),
              ),
              response_metadata: {
                next_cursor: next < CHANNEL_MESSAGES ? String(next) : "",
              },
            }),
          );
          return;
        }
        if (req.url?.includes("/conversations.info")) {
          res.end(
            JSON.stringify({
              ok: true,
              channel: { id: form.get("channel"), name: "general" },
            }),
          );
          return;
        }
        if (req.url?.includes("/users.info")) {
          const id = form.get("user");
          const name = id === "U0ALICE01" ? "Alice" : "Human";
          res.end(
            JSON.stringify({
              ok: true,
              user: { id, name: name.toLowerCase(), real_name: name },
            }),
          );
          return;
        }
        res.end(JSON.stringify({ ok: false, error: "unknown_method" }));
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

async function createSearchService() {
  const { apiUrl, historyCalls } = await startSlackApi();
  const runtime = new AgentRuntime({
    character: { name: "SlackSearch", bio: [] },
  });
  const service: SlackService = Object.assign(
    Object.create(SlackService.prototype),
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
            client: new WebClient("xoxb-test-token", { slackApiUrl: apiUrl }),
            userCache: new Map(),
            channelCache: new Map(),
          },
        ],
      ]),
    },
  );
  const search = (query: string, limit?: number) =>
    service.searchConnectorMessages(
      { runtime, accountId: ACCOUNT_ID } as never,
      {
        query,
        target: { source: "slack", channelId: CHANNEL_ID },
        accountId: ACCOUNT_ID,
        ...(limit === undefined ? {} : { limit }),
      },
    );
  return { search, historyCalls };
}

describe("Slack connector search", () => {
  it("stops paging the channel once it has the newest `limit` matches", async () => {
    const { search, historyCalls } = await createSearchService();

    const newest = await search("deploy", 1);
    expect(newest.map((memory) => memory.content.text)).toEqual([
      "deploy note 3",
    ]);
    expect(historyCalls).toEqual([0]);

    historyCalls.length = 0;
    const both = await search("deploy", 2);
    expect(both.map((memory) => memory.content.text)).toEqual([
      "deploy note 3",
      "deploy note 40",
    ]);
    expect(historyCalls).toEqual([0, 15, 30]);
  });

  it("still matches the author's name and stops at that match", async () => {
    const { search, historyCalls } = await createSearchService();

    const byAlice = await search("alice", 1);
    expect(byAlice.map((memory) => memory.content.text)).toEqual([
      "chat message 20",
    ]);
    expect(historyCalls).toEqual([0, 15]);
  });

  it("reads the whole channel when the search has no limit", async () => {
    const { search, historyCalls } = await createSearchService();

    const all = await search("deploy");
    expect(all.map((memory) => memory.content.text)).toEqual([
      "deploy note 3",
      "deploy note 40",
    ]);
    expect(historyCalls).toHaveLength(CHANNEL_MESSAGES / PAGE_SIZE);
  });
});
