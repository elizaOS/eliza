/**
 * Error-policy pins for the Discord app-automation post path (#13415).
 *
 * `postAnnouncement` is a connector send: an internal failure from the Discord
 * REST send must surface as a failed `PostResult` (`success:false` + the error),
 * NEVER read as delivered, and must NOT record the post in stats. These tests
 * drive the real exported `discordAppAutomationService.postAnnouncement` and pin
 * three distinguishable outcomes: (1) a designed validation-empty (automation
 * disabled) that never touches the wire, (2) an internal send failure that
 * propagates without mutating stats, and (3) a real delivery that records stats.
 * The file already fails closed — this locks that in against regression.
 *
 * Harness: bun:test with mock.module + dynamic import; no real DB/network.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG_ID = "00000000-0000-4000-8000-00000000c001";
const APP_ID = "00000000-0000-4000-8000-00000000c002";
const CHANNEL_ID = "channel-under-test";

interface AppRow {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  app_url: string;
  website_url: string | null;
  logo_url: string | null;
  promotional_assets: unknown[] | null;
  discord_automation: unknown;
}

let appRow: AppRow;
const updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];

let sendResult: { success: boolean; messageId?: string; error?: string };
const sendCalls: Array<{ channelId: string; content: string }> = [];

let channelExists: boolean;

mock.module("../../../db/repositories/apps", () => ({
  appsRepository: {
    findById: async (id: string) => (id === appRow.id ? appRow : null),
    update: async (id: string, patch: Record<string, unknown>) => {
      updateCalls.push({ id, patch });
      return { ...appRow, ...patch };
    },
  },
}));

mock.module("../../../db/repositories/discord-channels", () => ({
  discordChannelsRepository: {
    findByChannelId: async (_org: string, channelId: string) =>
      channelExists ? { channel_id: channelId, channel_name: "general" } : null,
  },
}));

mock.module("./index", () => ({
  discordAutomationService: {
    sendMessage: async (channelId: string, content: string) => {
      sendCalls.push({ channelId, content });
      return sendResult;
    },
  },
}));

// Isolate the send path from the credit/LLM generator: postAnnouncement is
// called with explicit text so generateAnnouncement is never reached.
mock.module("../credits", () => ({
  creditsService: {
    deductCredits: async () => ({ success: true, newBalance: 100, transaction: null }),
    refundCredits: async () => ({ transaction: {}, newBalance: 100 }),
  },
}));

mock.module("../character-prompt-helper", () => ({
  getCharacterPromptContext: async () => null,
  buildCharacterSystemPrompt: () => "",
}));

const { discordAppAutomationService } = await import("./app-automation");

function makeAppRow(overrides: Partial<AppRow["discord_automation"] & object> = {}): void {
  appRow = {
    id: APP_ID,
    organization_id: ORG_ID,
    name: "Test App",
    description: "An app under test",
    app_url: "https://test-app.example",
    website_url: "https://test-app.example",
    logo_url: null,
    promotional_assets: null,
    discord_automation: {
      enabled: true,
      channelId: CHANNEL_ID,
      autoAnnounce: true,
      announceIntervalMin: 120,
      announceIntervalMax: 240,
      totalMessages: 7,
      ...overrides,
    },
  };
}

beforeEach(() => {
  updateCalls.length = 0;
  sendCalls.length = 0;
  channelExists = true;
  sendResult = { success: true, messageId: "message-ok" };
  makeAppRow();
});

describe("postAnnouncement fails closed on internal send failure (#13415)", () => {
  test("designed validation-empty: automation disabled returns a designed error, never sends, never mutates stats", async () => {
    makeAppRow({ enabled: false });

    const result = await discordAppAutomationService.postAnnouncement(ORG_ID, APP_ID, "hi");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Automation not enabled for this app");
    // Designed-empty must not touch the wire or record a post.
    expect(sendCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
  });

  test("internal send failure propagates as failure and is NOT recorded as delivered", async () => {
    sendResult = { success: false, error: "Failed to send message" };

    const result = await discordAppAutomationService.postAnnouncement(ORG_ID, APP_ID, "hi");

    // The send was attempted (distinct from the designed-empty case)...
    expect(sendCalls).toHaveLength(1);
    // ...and the failure surfaces instead of reading as delivered.
    expect(result.success).toBe(false);
    expect(result.error).toBe("Failed to send message");
    expect(result.messageId).toBeUndefined();
    // A failed send must never be written into stats.
    expect(updateCalls).toHaveLength(0);
  });

  test("successful send returns a delivered result and records the post in stats", async () => {
    sendResult = { success: true, messageId: "message-ok" };

    const result = await discordAppAutomationService.postAnnouncement(ORG_ID, APP_ID, "hi");

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("message-ok");
    expect(result.channelId).toBe(CHANNEL_ID);
    // Delivery is distinguishable from failure: exactly one send, stats bumped.
    expect(sendCalls).toHaveLength(1);
    expect(updateCalls).toHaveLength(1);
    const patched = updateCalls[0].patch.discord_automation as { totalMessages: number };
    expect(patched.totalMessages).toBe(8);
  });
});
