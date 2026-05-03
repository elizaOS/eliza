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

    const timelineAfterTweet = await fetch(
      `${baseUrl}/2/users/user-owner/timelines/reverse_chronological?max_results=1`,
    );
    expect(timelineAfterTweet.status).toBe(200);
    expect(
      (
        await readJson<{ data: Array<{ id: string; text: string }> }>(
          timelineAfterTweet,
        )
      ).data[0],
    ).toEqual(
      expect.objectContaining({
        id: tweetBody.data.id,
        text: "posting through central mock",
      }),
    );

    const dmSend = await fetch(
      `${baseUrl}/2/dm_conversations/with/user-alice/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "central DM fixture" }),
      },
    );
    expect(dmSend.status).toBe(200);
    const dmSendBody = await readJson<{ data: { dm_event_id: string } }>(
      dmSend,
    );
    expect(dmSendBody.data.dm_event_id).toMatch(/^dm-event-/);
    const dmEventsAfterSend = await fetch(
      `${baseUrl}/2/dm_events?max_results=1`,
    );
    expect(dmEventsAfterSend.status).toBe(200);
    expect(
      (
        await readJson<{ data: Array<{ id: string; text: string }> }>(
          dmEventsAfterSend,
        )
      ).data[0],
    ).toEqual(
      expect.objectContaining({
        id: dmSendBody.data.dm_event_id,
        text: "central DM fixture",
      }),
    );

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
    expect(bufferedBody.messages[0]).toEqual(
      expect.objectContaining({
        text: { body: "inbound fixture" },
      }),
    );

    const updateWebhook = await fetch(`${baseUrl}/webhooks/whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
                      timestamp: "1777132860",
                      type: "text",
                      text: { body: "updated inbound fixture" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    });
    expect(updateWebhook.status).toBe(200);

    const updatedBuffer = await fetch(`${baseUrl}/__mock/whatsapp/inbound`);
    const updatedBufferBody = await readJson<{
      messages: Array<{ id: string; text?: { body?: string } }>;
    }>(updatedBuffer);
    expect(updatedBufferBody.messages).toHaveLength(1);
    expect(updatedBufferBody.messages[0]).toEqual(
      expect.objectContaining({
        id: "wamid.inbound",
        text: { body: "updated inbound fixture" },
      }),
    );

    const drained = await fetch(`${baseUrl}/__mock/whatsapp/inbound`, {
      method: "DELETE",
    });
    expect(drained.status).toBe(200);
    expect((await readJson<{ drained: number }>(drained)).drained).toBe(1);

    const afterDrain = await fetch(`${baseUrl}/__mock/whatsapp/inbound`);
    expect(
      (await readJson<{ messages: unknown[] }>(afterDrain)).messages,
    ).toHaveLength(0);

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
    const accountNumber = mocks.envVars.SIGNAL_ACCOUNT_NUMBER;

    const check = await fetch(`${baseUrl}/api/v1/check`);
    expect(check.status).toBe(200);

    const receive = await fetch(
      `${baseUrl}/v1/receive/${encodeURIComponent(accountNumber)}`,
      { headers: { "X-Eliza-Test-Run": "run-signal" } },
    );
    expect(receive.status).toBe(200);
    expect((await readJson<unknown[]>(receive)).length).toBe(2);

    const receiveAfterDrain = await fetch(
      `${baseUrl}/v1/receive/${encodeURIComponent(accountNumber)}`,
    );
    expect(receiveAfterDrain.status).toBe(200);
    expect(await readJson<unknown[]>(receiveAfterDrain)).toHaveLength(0);

    const send = await fetch(`${baseUrl}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        number: accountNumber,
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
          account: accountNumber,
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
            account: accountNumber,
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

    const navigated = await fetch(`${baseUrl}/tabs/${tabId}/navigate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: "https://discord.com/channels/@me/222" }),
    });
    expect(navigated.status).toBe(200);
    expect((await readJson<{ tab: { url: string } }>(navigated)).tab.url).toBe(
      "https://discord.com/channels/@me/222",
    );

    const hidden = await fetch(`${baseUrl}/tabs/${tabId}/hide`, {
      method: "POST",
      headers,
    });
    expect(hidden.status).toBe(200);
    expect((await readJson<{ tab: { show: boolean } }>(hidden)).tab.show).toBe(
      false,
    );

    const shown = await fetch(`${baseUrl}/tabs/${tabId}/show`, {
      method: "POST",
      headers,
    });
    expect(shown.status).toBe(200);
    expect((await readJson<{ tab: { show: boolean } }>(shown)).tab.show).toBe(
      true,
    );

    const listedTabs = await fetch(`${baseUrl}/tabs`, { headers });
    expect(listedTabs.status).toBe(200);
    expect(
      (
        await readJson<{
          tabs: Array<{ id: string; url: string; show: boolean }>;
        }>(listedTabs)
      ).tabs,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: tabId,
          url: "https://discord.com/channels/@me/222",
          show: true,
        }),
      ]),
    );

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

    const sentSearch = await fetch(`${baseUrl}/api/v1/message/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({ search: "sent from BlueBubbles", chatGuid }),
    });
    expect(sentSearch.status).toBe(200);
    expect(
      (
        await readJson<{ data: Array<{ guid: string; text: string }> }>(
          sentSearch,
        )
      ).data[0],
    ).toEqual(
      expect.objectContaining({
        guid: messageGuid,
        text: "sent from BlueBubbles fixture",
      }),
    );

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
    const issueBody = await readJson<{
      number: number;
      title: string;
      assignees: Array<{ login: string }>;
    }>(issue);
    expect(issueBody.number).toBe(101);
    expect(issueBody.assignees).toEqual([]);

    const assignees = await fetch(
      `${baseUrl}/repos/elizaOS/eliza/issues/${issueBody.number}/assignees`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignees: ["alice", "bob"] }),
      },
    );
    expect(assignees.status).toBe(200);
    expect(
      (await readJson<{ assignees: Array<{ login: string }> }>(assignees))
        .assignees,
    ).toEqual([{ login: "alice" }, { login: "bob" }]);

    const issueDetail = await fetch(
      `${baseUrl}/repos/elizaOS/eliza/issues/${issueBody.number}`,
    );
    expect(issueDetail.status).toBe(200);
    expect(
      await readJson<{
        number: number;
        title: string;
        assignees: Array<{ login: string }>;
      }>(issueDetail),
    ).toEqual(
      expect.objectContaining({
        number: issueBody.number,
        title: "central mock issue",
        assignees: [{ login: "alice" }, { login: "bob" }],
      }),
    );

    const issueList = await fetch(
      `${baseUrl}/repos/elizaOS/eliza/issues?state=open`,
    );
    expect(issueList.status).toBe(200);
    expect(
      await readJson<Array<{ number: number; title: string }>>(issueList),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          number: issueBody.number,
          title: "central mock issue",
        }),
      ]),
    );

    const review = await fetch(
      `${baseUrl}/repos/elizaOS/eliza/pulls/17/reviews`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "APPROVE" }),
      },
    );
    expect(review.status).toBe(200);
    const reviewBody = await readJson<{ id: number; event: string }>(review);
    expect(reviewBody.id).toBe(777);
    expect(reviewBody.event).toBe("APPROVE");

    const reviews = await fetch(
      `${baseUrl}/repos/elizaOS/eliza/pulls/17/reviews`,
    );
    expect(reviews.status).toBe(200);
    expect(
      await readJson<Array<{ id: number; event: string }>>(reviews),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: reviewBody.id, event: "APPROVE" }),
      ]),
    );

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
