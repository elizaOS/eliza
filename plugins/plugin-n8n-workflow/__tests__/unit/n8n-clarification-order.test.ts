import { describe, test, expect } from "bun:test";
import { coerceClarifications } from "../../src/lib/n8n-clarification";

describe("coerceClarifications — sort order", () => {
  test("target_server is asked before target_channel even when LLM emits reverse order", async () => {
    // The exact failure mode the user hit in the Automations UI: LLM
    // emitted the channel question first, panel rendered the unscoped
    // catalog (every channel from every guild) before the user could
    // pick a server.
    const raw = [
      {
        kind: "target_channel",
        platform: "discord",
        question: "Which Discord channel should receive the alert?",
        paramPath: 'nodes["Send"].parameters.channelId',
      },
      {
        kind: "target_server",
        platform: "discord",
        question: "Which Discord server?",
        paramPath: 'nodes["Send"].parameters.guildId',
      },
    ];

    const out = coerceClarifications(raw);
    expect(out.map((c) => c.kind)).toEqual(["target_server", "target_channel"]);
  });

  test("preserves LLM order within the same kind bucket (stable sort)", async () => {
    const raw = [
      {
        kind: "value",
        question: "First value",
        paramPath: "a",
      },
      {
        kind: "value",
        question: "Second value",
        paramPath: "b",
      },
      {
        kind: "value",
        question: "Third value",
        paramPath: "c",
      },
    ];

    const out = coerceClarifications(raw);
    expect(out.map((c) => c.question)).toEqual([
      "First value",
      "Second value",
      "Third value",
    ]);
  });

  test("recipient sorts after target_server (recipient depends on server context)", async () => {
    const raw = [
      {
        kind: "recipient",
        platform: "slack",
        question: "Which user to DM?",
        paramPath: 'nodes["DM"].parameters.userId',
      },
      {
        kind: "target_server",
        platform: "slack",
        question: "Which Slack workspace?",
        paramPath: 'nodes["DM"].parameters.workspaceId',
      },
    ];

    const out = coerceClarifications(raw);
    expect(out[0].kind).toBe("target_server");
    expect(out[1].kind).toBe("recipient");
  });

  test("free_text drops to the end", async () => {
    const raw = [
      {
        kind: "free_text",
        question: "Anything else to note?",
        paramPath: "",
      },
      {
        kind: "value",
        question: "What hour to run?",
        paramPath: 'nodes["Cron"].parameters.hour',
      },
      {
        kind: "target_server",
        platform: "discord",
        question: "Which server?",
        paramPath: 'nodes["Send"].parameters.guildId',
      },
    ];

    const out = coerceClarifications(raw);
    expect(out.map((c) => c.kind)).toEqual([
      "target_server",
      "value",
      "free_text",
    ]);
  });

  test("legacy bare-string clarifications normalize to free_text and stay at the end", async () => {
    const raw = [
      "Anything special about your setup?",
      {
        kind: "target_server",
        platform: "discord",
        question: "Which server?",
        paramPath: "x",
      },
    ];

    const out = coerceClarifications(raw);
    expect(out[0].kind).toBe("target_server");
    expect(out[1].kind).toBe("free_text");
    expect(out[1].question).toBe("Anything special about your setup?");
  });

  test("mixed multi-platform: server-then-channel ordering applies per platform group", async () => {
    // Two different connectors emitting clarifications in the same draft.
    // Each platform's server should still come before its channel — global
    // sort by kind achieves this trivially because all servers sort
    // ahead of all channels.
    const raw = [
      {
        kind: "target_channel",
        platform: "discord",
        question: "Discord channel?",
        paramPath: "x",
      },
      {
        kind: "target_channel",
        platform: "slack",
        question: "Slack channel?",
        paramPath: "y",
      },
      {
        kind: "target_server",
        platform: "discord",
        question: "Discord server?",
        paramPath: "z",
      },
      {
        kind: "target_server",
        platform: "slack",
        question: "Slack workspace?",
        paramPath: "w",
      },
    ];

    const out = coerceClarifications(raw);
    expect(out[0].kind).toBe("target_server");
    expect(out[1].kind).toBe("target_server");
    expect(out[2].kind).toBe("target_channel");
    expect(out[3].kind).toBe("target_channel");
    // Within each kind bucket, the LLM order survives.
    expect(out[0].platform).toBe("discord");
    expect(out[1].platform).toBe("slack");
  });
});
