/**
 * Slack sends the &, < and > a user typed as &amp;, &lt; and &gt; in message
 * text. The memory the agent reads must hold the typed text on every inbound
 * path, so a reply that quotes it is escaped once, not twice.
 * Real AgentRuntime and @slack/web-api WebClient against a local Slack API.
 */
import http from "node:http";
import { AgentRuntime, type Memory } from "@elizaos/core";
import { WebClient } from "@slack/web-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeAccountId } from "./accounts.ts";
import { markdownToSlackMrkdwn } from "./formatting.ts";
import { SlackService } from "./service.ts";
import type { SlackChannel } from "./types.ts";

const ACCOUNT_ID = "acct-1";
const CHANNEL_ID = "C12345678";
const TYPED = "R&D: is a < b && c > d? (&lt; stays)";
const WIRE = "R&amp;D: is a &lt; b &amp;&amp; c &gt; d? (&amp;lt; stays)";

const servers: http.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** history, thread replies and pins each return the same one message. */
async function createService() {
  const apiUrl = await new Promise<string>((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        const message = {
          type: "message",
          ts: "1.000100",
          user: "U1",
          text: WIRE,
        };
        const items = [{ type: "message", message }];
        res.end(JSON.stringify({ ok: true, messages: [message], items }));
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" ? address?.port : 0;
      resolve(`http://127.0.0.1:${port}/api/`);
    });
  });
  const runtime = new AgentRuntime({ character: { name: "Slacky", bio: [] } });
  const client = new WebClient("xoxb-test-token", { slackApiUrl: apiUrl });
  const accountState = { accountId: ACCOUNT_ID, botUserId: "B0AGENT", client };
  const service = Object.assign(Object.create(SlackService.prototype), {
    runtime,
    defaultAccountId: ACCOUNT_ID,
    accountStates: new Map([[normalizeAccountId(ACCOUNT_ID), accountState]]),
    resolveAccountIdForTarget: vi.fn(async () => ACCOUNT_ID),
    getChannel: vi.fn(async () => ({ id: CHANNEL_ID }) as SlackChannel),
    getUser: vi.fn(async () => null),
  }) as SlackService;
  return { service, runtime };
}

type Reader = (
  service: SlackService,
  runtime: AgentRuntime,
) => Promise<unknown>;
/** The private builders that handleMessage and handleAppMention call. */
type Builders = Record<
  "buildMemoryFromMessage" | "buildMemoryFromMention",
  (event: object, accountId: string) => Promise<Memory>
>;
const event = { channel: CHANNEL_ID, user: "U1", ts: "1.000200" };
const build =
  (name: keyof Builders, text: string): Reader =>
  async (service) =>
    (
      await (service as unknown as Builders)[name](
        { ...event, text },
        ACCOUNT_ID,
      )
    ).content.text;
const history =
  (threadId?: string): Reader =>
  async (service, runtime) => {
    const target = { source: "slack", channelId: CHANNEL_ID, threadId };
    const params = { target } as never;
    const [memory] = await service.fetchConnectorMessages(
      { runtime } as never,
      params,
    );
    return memory?.content.text;
  };

describe("Slack inbound text entities", () => {
  it.each<[string, Reader]>([
    ["live message", build("buildMemoryFromMessage", WIRE)],
    ["app mention", build("buildMemoryFromMention", `<@B0AGENT> ${WIRE}`)],
    ["channel history", history()],
    ["thread replies", history("1.000100")],
    [
      "pinned messages",
      async (service) =>
        (await service.listPins(CHANNEL_ID, ACCOUNT_ID))[0]?.text,
    ],
  ])("%s: the agent reads the typed text", async (_name, read) => {
    const { service, runtime } = await createService();
    const text = await read(service, runtime);
    expect(text).toBe(TYPED);
    // A reply that quotes the message sends the same wire text back.
    expect(markdownToSlackMrkdwn(String(text))).toBe(WIRE);
  });
});
