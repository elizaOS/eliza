import { afterEach, describe, expect, it } from "vitest";
import { createGitHubOctokitFixture } from "../helpers/github-octokit-fixture.ts";
import { type StartedMocks, startMocks } from "../scripts/start-mocks.ts";

type JsonRecord = Record<string, unknown>;

async function readJson<T = JsonRecord>(response: Response): Promise<T> {
  expect(response.headers.get("content-type")).toContain("application/json");
  return (await response.json()) as T;
}

describe("non-Google central provider mocks", () => {
  let mocks: StartedMocks | null = null;

  afterEach(async () => {
    await mocks?.stop();
    mocks = null;
  });

  it("serves X read, search, tweet, DM surfaces and records request metadata", async () => {
    mocks = await startMocks({ envs: ["x-twitter"] });
    const baseUrl = mocks.baseUrls["x-twitter"];

    const dmEvents = await fetch(`${baseUrl}/2/dm_events?max_results=1`, {
      headers: { "X-Eliza-Test-Run": "run-x" },
    });
    expect(dmEvents.status).toBe(200);
    expect((await readJson<{ data: unknown[] }>(dmEvents)).data).toHaveLength(
      1,
    );

    const timeline = await fetch(
      `${baseUrl}/2/users/user-owner/timelines/reverse_chronological`,
    );
    expect(timeline.status).toBe(200);
    expect(
      (await readJson<{ data: unknown[] }>(timeline)).data.length,
    ).toBeGreaterThan(0);

    const mentions = await fetch(`${baseUrl}/2/users/user-owner/mentions`);
    expect(mentions.status).toBe(200);
    expect((await readJson<{ data: unknown[] }>(mentions)).data.length).toBe(1);

    const search = await fetch(
      `${baseUrl}/2/tweets/search/recent?${new URLSearchParams({
        query: "elizaOS",
      })}`,
    );
    expect(search.status).toBe(200);
    expect(
      (await readJson<{ data: unknown[] }>(search)).data.length,
    ).toBeGreaterThan(0);

    const tweet = await fetch(`${baseUrl}/2/tweets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "posting through central mock" }),
    });
    expect(tweet.status).toBe(200);
    const tweetBody = await readJson<{ data: { id: string; text: string } }>(
      tweet,
    );
    expect(tweetBody.data.id).toMatch(/^tweet-/);

    const dmSend = await fetch(
      `${baseUrl}/2/dm_conversations/with/user-alice/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "central DM fixture" }),
      },
    );
    expect(dmSend.status).toBe(200);
    expect(
      (await readJson<{ data: { dm_event_id: string } }>(dmSend)).data
        .dm_event_id,
    ).toMatch(/^dm-event-/);

    expect(mocks.requestLedger()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-x",
          x: expect.objectContaining({
            action: "dm_events.list",
            runId: "run-x",
          }),
        }),
        expect.objectContaining({
          x: expect.objectContaining({
            action: "tweets.search_recent",
            query: "elizaOS",
          }),
        }),
        expect.objectContaining({
          x: expect.objectContaining({ action: "tweets.create" }),
        }),
        expect.objectContaining({
          x: expect.objectContaining({
            action: "dm_conversations.messages.create",
          }),
        }),
      ]),
    );
  });

  it("serves WhatsApp send and inbound webhook buffer surfaces", async () => {
    mocks = await startMocks({ envs: ["whatsapp"] });
    const baseUrl = mocks.baseUrls.whatsapp;

    const send = await fetch(`${baseUrl}/v21.0/phone-123/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: "15551112222",
        type: "text",
        text: { body: "hello" },
      }),
    });
    expect(send.status).toBe(200);
    expect(
      (await readJson<{ messages: Array<{ id: string }> }>(send)).messages[0]
        ?.id,
    ).toMatch(/^wamid\./);

    const webhook = await fetch(`${baseUrl}/webhooks/whatsapp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Eliza-Test-Run": "run-whatsapp",
      },
      body: JSON.stringify({
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: "wamid.inbound",
                      from: "15551112222",
                      timestamp: "1777132800",
                      type: "text",
                      text: { body: "inbound fixture" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    });
    expect(webhook.status).toBe(200);
    expect((await readJson<{ ingested: number }>(webhook)).ingested).toBe(1);

    const buffered = await fetch(`${baseUrl}/__mock/whatsapp/inbound`);
    expect(buffered.status).toBe(200);
    const bufferedBody = await readJson<{ messages: Array<{ id: string }> }>(
      buffered,
    );
    expect(bufferedBody.messages.map((message) => message.id)).toEqual([
      "wamid.inbound",
    ]);

    expect(mocks.requestLedger()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          whatsapp: expect.objectContaining({
            action: "messages.send",
            phoneNumberId: "phone-123",
            recipient: "15551112222",
          }),
        }),
        expect.objectContaining({
          runId: "run-whatsapp",
          whatsapp: expect.objectContaining({
            action: "webhook.ingest",
            ingested: 1,
            runId: "run-whatsapp",
          }),
        }),
      ]),
    );
  });

  it("serves Signal check, receive, REST send, and JSON-RPC send", async () => {
    mocks = await startMocks({ envs: ["signal"] });
    const baseUrl = mocks.baseUrls.signal;

    const check = await fetch(`${baseUrl}/api/v1/check`);
    expect(check.status).toBe(200);

    const receive = await fetch(
      `${baseUrl}/v1/receive/${encodeURIComponent("+15550000000")}`,
      { headers: { "X-Eliza-Test-Run": "run-signal" } },
    );
    expect(receive.status).toBe(200);
    expect((await readJson<unknown[]>(receive)).length).toBe(2);

    const send = await fetch(`${baseUrl}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        number: "+15550000000",
        recipients: ["+15551110001"],
        message: "Signal REST fixture",
      }),
    });
    expect(send.status).toBe(200);
    expect(
      (await readJson<{ timestamp: number }>(send)).timestamp,
    ).toBeGreaterThan(0);

    const rpc = await fetch(`${baseUrl}/api/v1/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "rpc-1",
        method: "send",
        params: {
          account: "+15550000000",
          recipients: ["+15551110002"],
          message: "Signal RPC fixture",
        },
      }),
    });
    expect(rpc.status).toBe(200);
    expect(
      (await readJson<{ result: { timestamp: number } }>(rpc)).result.timestamp,
    ).toBeGreaterThan(0);

    expect(mocks.requestLedger()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-signal",
          signal: expect.objectContaining({
            action: "receive",
            account: "+15550000000",
            runId: "run-signal",
          }),
        }),
        expect.objectContaining({
          signal: expect.objectContaining({
            action: "send",
            recipients: ["+15551110001"],
          }),
        }),
        expect.objectContaining({
          signal: expect.objectContaining({
            action: "rpc.send",
            recipients: ["+15551110002"],
          }),
        }),
      ]),
    );
  });

  it("serves Discord browser workspace tab routes behind the workspace token", async () => {
    mocks = await startMocks({ envs: ["browser-workspace"] });
    const baseUrl = mocks.baseUrls["browser-workspace"];
    const headers = {
      Authorization: `Bearer ${mocks.envVars.ELIZA_BROWSER_WORKSPACE_TOKEN}`,
      "Content-Type": "application/json",
    };

    expect((await fetch(`${baseUrl}/tabs`)).status).toBe(401);

    const created = await fetch(`${baseUrl}/tabs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        url: "https://discord.com/channels/@me",
        partition: "lifeops-discord-agent-owner",
        kind: "internal",
        title: "Discord",
        show: true,
      }),
    });
    expect(created.status).toBe(200);
    const createdBody = await readJson<{ tab: { id: string } }>(created);
    const tabId = createdBody.tab.id;

    const evalResponse = await fetch(`${baseUrl}/tabs/${tabId}/eval`, {
      method: "POST",
      headers,
      body: JSON.stringify({ script: "probeDiscordDocumentState()" }),
    });
    expect(evalResponse.status).toBe(200);
    expect(
      (await readJson<{ result: { loggedIn: boolean } }>(evalResponse)).result
        .loggedIn,
    ).toBe(true);

    const snapshot = await fetch(`${baseUrl}/tabs/${tabId}/snapshot`, {
      headers: { Authorization: headers.Authorization },
    });
    expect(snapshot.status).toBe(200);
    expect((await readJson<{ data: string }>(snapshot)).data).toBeTruthy();

    expect(
      await fetch(`${baseUrl}/tabs/${tabId}`, {
        method: "DELETE",
        headers: { Authorization: headers.Authorization },
      }),
    ).toHaveProperty("status", 200);

    expect(mocks.requestLedger()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          browserWorkspace: expect.objectContaining({
            action: "tabs.create",
            partition: "lifeops-discord-agent-owner",
          }),
        }),
        expect.objectContaining({
          browserWorkspace: expect.objectContaining({
            action: "tabs.eval",
            tabId,
          }),
        }),
      ]),
    );
  });

  it("serves BlueBubbles info, chat, message, send, search, and receipt routes", async () => {
    mocks = await startMocks({ envs: ["bluebubbles"] });
    const baseUrl = mocks.baseUrls.bluebubbles;
    const headers = {
      Authorization: `Bearer ${mocks.envVars.ELIZA_BLUEBUBBLES_PASSWORD}`,
      "Content-Type": "application/json",
    };

    const info = await fetch(`${baseUrl}/api/v1/server/info`, { headers });
    expect(info.status).toBe(200);
    expect(
      (await readJson<{ data: { private_api: boolean } }>(info)).data
        .private_api,
    ).toBe(true);

    const chats = await fetch(`${baseUrl}/api/v1/chat/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({ limit: 100 }),
    });
    expect(chats.status).toBe(200);
    const chatGuid = (await readJson<{ data: Array<{ guid: string }> }>(chats))
      .data[0]?.guid;
    expect(chatGuid).toBe("iMessage;-;+15551112222");

    const search = await fetch(`${baseUrl}/api/v1/message/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({ search: "BlueBubbles", chatGuid }),
    });
    expect(search.status).toBe(200);
    expect((await readJson<{ data: unknown[] }>(search)).data.length).toBe(1);

    const sent = await fetch(`${baseUrl}/api/v1/message/text`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        chatGuid,
        message: "sent from BlueBubbles fixture",
        method: "private-api",
      }),
    });
    expect(sent.status).toBe(200);
    const messageGuid = (await readJson<{ data: { guid: string } }>(sent)).data
      .guid;

    const detail = await fetch(`${baseUrl}/api/v1/message/${messageGuid}`, {
      headers,
    });
    expect(detail.status).toBe(200);
    expect(
      (await readJson<{ data: { isDelivered: boolean } }>(detail)).data
        .isDelivered,
    ).toBe(true);

    expect(mocks.requestLedger()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bluebubbles: expect.objectContaining({ action: "server.info" }),
        }),
        expect.objectContaining({
          bluebubbles: expect.objectContaining({
            action: "message.search",
            chatGuid,
            query: "BlueBubbles",
          }),
        }),
        expect.objectContaining({
          bluebubbles: expect.objectContaining({
            action: "message.text",
            messageGuid,
          }),
        }),
      ]),
    );
  });

  it("serves GitHub REST routes and reusable Octokit-shaped fixtures", async () => {
    mocks = await startMocks({ envs: ["github"] });
    const baseUrl = mocks.baseUrls.github;

    const pulls = await fetch(
      `${baseUrl}/repos/elizaOS/eliza/pulls?state=open`,
      {
        headers: { "X-Eliza-Test-Run": "run-github" },
      },
    );
    expect(pulls.status).toBe(200);
    expect((await readJson<Array<{ number: number }>>(pulls))[0]?.number).toBe(
      17,
    );

    const issue = await fetch(`${baseUrl}/repos/elizaOS/eliza/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "central mock issue" }),
    });
    expect(issue.status).toBe(200);
    expect((await readJson<{ number: number }>(issue)).number).toBe(101);

    const review = await fetch(
      `${baseUrl}/repos/elizaOS/eliza/pulls/17/reviews`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "APPROVE" }),
      },
    );
    expect(review.status).toBe(200);
    expect((await readJson<{ id: number }>(review)).id).toBe(777);

    const notifications = await fetch(`${baseUrl}/notifications`);
    expect(notifications.status).toBe(200);
    expect((await readJson<unknown[]>(notifications)).length).toBe(2);

    const octokit = createGitHubOctokitFixture();
    expect(
      (await octokit.client.pulls.list({ state: "open" })).data[0]?.number,
    ).toBe(17);
    expect(
      (await octokit.client.issues.addAssignees({ assignees: ["alice"] })).data
        .assignees[0]?.login,
    ).toBe("alice");
    expect(octokit.requests.map((request) => request.action)).toEqual([
      "pulls.list",
      "issues.addAssignees",
    ]);

    expect(mocks.requestLedger()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-github",
          github: expect.objectContaining({
            action: "pulls.list",
            owner: "elizaOS",
            repo: "eliza",
            runId: "run-github",
          }),
        }),
        expect.objectContaining({
          github: expect.objectContaining({
            action: "issues.create",
            number: 101,
          }),
        }),
        expect.objectContaining({
          github: expect.objectContaining({
            action: "pulls.createReview",
            number: 17,
          }),
        }),
      ]),
    );
  });
});
