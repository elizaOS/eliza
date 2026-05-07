/**
 * Integration tests for per-connector CredentialProvider implementations.
 * Verifies the resolve() / checkCredentialTypes() contract for every wired connector.
 */
import { describe, test, expect } from "bun:test";
import { SlackN8nCredentialProvider } from "../../../plugin-slack/src/n8n-credential-provider";
import { WhatsAppN8nCredentialProvider } from "../../../plugin-whatsapp/src/n8n-credential-provider";
import { MatrixN8nCredentialProvider } from "../../../plugin-matrix/src/n8n-credential-provider";
import { TwitchN8nCredentialProvider } from "../../../plugin-twitch/src/n8n-credential-provider";
import { GoogleChatN8nCredentialProvider } from "../../../plugin-google-chat/src/n8n-credential-provider";
import { LineN8nCredentialProvider } from "../../../plugin-line/src/n8n-credential-provider";
import { FeishuN8nCredentialProvider } from "../../../plugin-feishu/src/n8n-credential-provider";
import { SignalN8nCredentialProvider } from "../../../plugin-signal/src/n8n-credential-provider";
import { BlueBubblesN8nCredentialProvider } from "../../../plugin-bluebubbles/src/n8n-credential-provider";
import { InstagramN8nCredentialProvider } from "../../../plugin-instagram/src/n8n-credential-provider";
import { FarcasterN8nCredentialProvider } from "../../../plugin-farcaster/n8n-credential-provider";
import { BlueskyN8nCredentialProvider } from "../../../plugin-bluesky/n8n-credential-provider";

function makeRuntime(settings: Record<string, string>) {
  return {
    agentId: "test-agent",
    getSetting: (key: string) => settings[key] ?? undefined,
    logger: { warn: () => {}, error: () => {} },
    services: new Map(),
  } as unknown;
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------
describe("SlackN8nCredentialProvider", () => {
  test("returns slackApi credential when SLACK_BOT_TOKEN is set", async () => {
    const runtime = makeRuntime({ SLACK_BOT_TOKEN: "xoxb-test-token" });
    const provider = await SlackN8nCredentialProvider.start(runtime as never);
    const result = await provider.resolve("user1", "slackApi");
    expect(result).not.toBeNull();
    expect(result?.status).toBe("credential_data");
  });

  test("returns slackOAuth2Api credential when SLACK_APP_TOKEN is set", async () => {
    const runtime = makeRuntime({ SLACK_APP_TOKEN: "xapp-test-token" });
    const provider = await SlackN8nCredentialProvider.start(runtime as never);
    const result = await provider.resolve("user1", "slackOAuth2Api");
    expect(result).not.toBeNull();
    expect(result?.status).toBe("credential_data");
  });

  test("returns null when env vars are absent", async () => {
    const runtime = makeRuntime({});
    const provider = await SlackN8nCredentialProvider.start(runtime as never);
    expect(await provider.resolve("user1", "slackApi")).toBeNull();
    expect(await provider.resolve("user1", "slackOAuth2Api")).toBeNull();
  });

  test("returns null for unsupported cred type", async () => {
    const runtime = makeRuntime({ SLACK_BOT_TOKEN: "xoxb-test-token" });
    const provider = await SlackN8nCredentialProvider.start(runtime as never);
    expect(await provider.resolve("user1", "telegramApi")).toBeNull();
  });

  test("checkCredentialTypes returns correct split", async () => {
    const runtime = makeRuntime({});
    const provider = await SlackN8nCredentialProvider.start(runtime as never);
    const result = provider.checkCredentialTypes(["slackApi", "slackOAuth2Api", "telegramApi"]);
    expect(result.supported).toEqual(expect.arrayContaining(["slackApi", "slackOAuth2Api"]));
    expect(result.unsupported).toEqual(["telegramApi"]);
  });
});

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------
describe("WhatsAppN8nCredentialProvider", () => {
  test("returns whatsAppApi credential when both env vars are set", async () => {
    const runtime = makeRuntime({
      WHATSAPP_ACCESS_TOKEN: "wa-token",
      WHATSAPP_PHONE_NUMBER_ID: "12345",
    });
    const provider = await WhatsAppN8nCredentialProvider.start(runtime as never);
    const result = await provider.resolve("user1", "whatsAppApi");
    expect(result?.status).toBe("credential_data");
  });

  test("returns null when only one env var is set", async () => {
    const runtime = makeRuntime({ WHATSAPP_ACCESS_TOKEN: "wa-token" });
    const provider = await WhatsAppN8nCredentialProvider.start(runtime as never);
    expect(await provider.resolve("user1", "whatsAppApi")).toBeNull();
  });

  test("returns null when env vars are absent", async () => {
    const runtime = makeRuntime({});
    const provider = await WhatsAppN8nCredentialProvider.start(runtime as never);
    expect(await provider.resolve("user1", "whatsAppApi")).toBeNull();
  });

  test("checkCredentialTypes returns correct split", async () => {
    const runtime = makeRuntime({});
    const provider = await WhatsAppN8nCredentialProvider.start(runtime as never);
    const result = provider.checkCredentialTypes(["whatsAppApi", "slackApi"]);
    expect(result.supported).toEqual(["whatsAppApi"]);
    expect(result.unsupported).toEqual(["slackApi"]);
  });
});

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------
describe("MatrixN8nCredentialProvider", () => {
  test("returns matrixApi credential when both env vars are set", async () => {
    const runtime = makeRuntime({
      MATRIX_ACCESS_TOKEN: "mat-token",
      MATRIX_HOMESERVER: "https://matrix.example.com",
    });
    const provider = await MatrixN8nCredentialProvider.start(runtime as never);
    const result = await provider.resolve("user1", "matrixApi");
    expect(result?.status).toBe("credential_data");
  });

  test("returns null when env vars are absent", async () => {
    const runtime = makeRuntime({});
    const provider = await MatrixN8nCredentialProvider.start(runtime as never);
    expect(await provider.resolve("user1", "matrixApi")).toBeNull();
  });

  test("returns null for unsupported cred type", async () => {
    const runtime = makeRuntime({ MATRIX_ACCESS_TOKEN: "mat-token", MATRIX_HOMESERVER: "https://matrix.example.com" });
    const provider = await MatrixN8nCredentialProvider.start(runtime as never);
    expect(await provider.resolve("user1", "slackApi")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Twitch
// ---------------------------------------------------------------------------
describe("TwitchN8nCredentialProvider", () => {
  test("returns httpHeaderAuth credential when TWITCH_ACCESS_TOKEN is set", async () => {
    const runtime = makeRuntime({ TWITCH_ACCESS_TOKEN: "twitch-token" });
    const provider = await TwitchN8nCredentialProvider.start(runtime as never);
    const result = await provider.resolve("user1", "httpHeaderAuth");
    expect(result?.status).toBe("credential_data");
    expect((result as { data: { value: string } }).data.value).toMatch(/^Bearer /);
  });

  test("returns null when TWITCH_ACCESS_TOKEN is absent", async () => {
    const runtime = makeRuntime({});
    const provider = await TwitchN8nCredentialProvider.start(runtime as never);
    expect(await provider.resolve("user1", "httpHeaderAuth")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Google Chat
// ---------------------------------------------------------------------------
describe("GoogleChatN8nCredentialProvider", () => {
  test("returns googleChatOAuth2Api credential when GOOGLE_APPLICATION_CREDENTIALS is set", async () => {
    const runtime = makeRuntime({ GOOGLE_APPLICATION_CREDENTIALS: "/path/to/service-account.json" });
    const provider = await GoogleChatN8nCredentialProvider.start(runtime as never);
    const result = await provider.resolve("user1", "googleChatOAuth2Api");
    expect(result?.status).toBe("credential_data");
  });

  test("returns null when no Google credential env vars are set", async () => {
    const runtime = makeRuntime({});
    const provider = await GoogleChatN8nCredentialProvider.start(runtime as never);
    expect(await provider.resolve("user1", "googleChatOAuth2Api")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LINE
// ---------------------------------------------------------------------------
describe("LineN8nCredentialProvider", () => {
  test("returns httpHeaderAuth credential when LINE_CHANNEL_ACCESS_TOKEN is set", async () => {
    const runtime = makeRuntime({ LINE_CHANNEL_ACCESS_TOKEN: "line-token" });
    const provider = await LineN8nCredentialProvider.start(runtime as never);
    const result = await provider.resolve("user1", "httpHeaderAuth");
    expect(result?.status).toBe("credential_data");
    expect((result as { data: { value: string } }).data.value).toMatch(/^Bearer /);
  });

  test("returns null when LINE_CHANNEL_ACCESS_TOKEN is absent", async () => {
    const runtime = makeRuntime({});
    const provider = await LineN8nCredentialProvider.start(runtime as never);
    expect(await provider.resolve("user1", "httpHeaderAuth")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Feishu
// ---------------------------------------------------------------------------
describe("FeishuN8nCredentialProvider", () => {
  test("returns httpHeaderAuth credential when FEISHU_APP_ID and FEISHU_APP_SECRET are set", async () => {
    const runtime = makeRuntime({ FEISHU_APP_ID: "app-id", FEISHU_APP_SECRET: "app-secret" });
    const provider = await FeishuN8nCredentialProvider.start(runtime as never);
    const result = await provider.resolve("user1", "httpHeaderAuth");
    expect(result?.status).toBe("credential_data");
  });

  test("returns null when only one env var is set", async () => {
    const runtime = makeRuntime({ FEISHU_APP_ID: "app-id" });
    const provider = await FeishuN8nCredentialProvider.start(runtime as never);
    expect(await provider.resolve("user1", "httpHeaderAuth")).toBeNull();
  });

  test("returns null when env vars are absent", async () => {
    const runtime = makeRuntime({});
    const provider = await FeishuN8nCredentialProvider.start(runtime as never);
    expect(await provider.resolve("user1", "httpHeaderAuth")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Signal
// ---------------------------------------------------------------------------
describe("SignalN8nCredentialProvider", () => {
  test("returns httpHeaderAuth credential when SIGNAL_HTTP_URL and SIGNAL_ACCOUNT_NUMBER are set", async () => {
    const runtime = makeRuntime({ SIGNAL_HTTP_URL: "http://localhost:8080", SIGNAL_ACCOUNT_NUMBER: "+15551234567" });
    const provider = await SignalN8nCredentialProvider.start(runtime as never);
    const result = await provider.resolve("user1", "httpHeaderAuth");
    expect(result?.status).toBe("credential_data");
  });

  test("returns null when env vars are absent", async () => {
    const runtime = makeRuntime({});
    const provider = await SignalN8nCredentialProvider.start(runtime as never);
    expect(await provider.resolve("user1", "httpHeaderAuth")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BlueBubbles
// ---------------------------------------------------------------------------
describe("BlueBubblesN8nCredentialProvider", () => {
  test("returns httpQueryAuth credential when both env vars are set", async () => {
    const runtime = makeRuntime({ BLUEBUBBLES_PASSWORD: "secret", BLUEBUBBLES_SERVER_URL: "http://localhost:1234" });
    const provider = await BlueBubblesN8nCredentialProvider.start(runtime as never);
    const result = await provider.resolve("user1", "httpQueryAuth");
    expect(result?.status).toBe("credential_data");
  });

  test("returns null when env vars are absent", async () => {
    const runtime = makeRuntime({});
    const provider = await BlueBubblesN8nCredentialProvider.start(runtime as never);
    expect(await provider.resolve("user1", "httpQueryAuth")).toBeNull();
  });

  test("returns null for unsupported cred type", async () => {
    const runtime = makeRuntime({ BLUEBUBBLES_PASSWORD: "secret", BLUEBUBBLES_SERVER_URL: "http://localhost:1234" });
    const provider = await BlueBubblesN8nCredentialProvider.start(runtime as never);
    expect(await provider.resolve("user1", "httpHeaderAuth")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------
describe("InstagramN8nCredentialProvider", () => {
  test("returns facebookGraphApi credential when INSTAGRAM_PAGE_ACCESS_TOKEN is set", async () => {
    const runtime = makeRuntime({ INSTAGRAM_PAGE_ACCESS_TOKEN: "page-access-token" });
    const provider = await InstagramN8nCredentialProvider.start(runtime as never);
    const result = await provider.resolve("user1", "facebookGraphApi");
    expect(result?.status).toBe("credential_data");
  });

  test("returns null when INSTAGRAM_PAGE_ACCESS_TOKEN is absent", async () => {
    const runtime = makeRuntime({});
    const provider = await InstagramN8nCredentialProvider.start(runtime as never);
    expect(await provider.resolve("user1", "facebookGraphApi")).toBeNull();
  });

  test("returns null for unsupported cred type (private API creds not wirable)", async () => {
    const runtime = makeRuntime({ INSTAGRAM_PAGE_ACCESS_TOKEN: "page-access-token" });
    const provider = await InstagramN8nCredentialProvider.start(runtime as never);
    expect(await provider.resolve("user1", "httpHeaderAuth")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Farcaster
// ---------------------------------------------------------------------------
describe("FarcasterN8nCredentialProvider", () => {
  test("returns httpHeaderAuth credential when FARCASTER_NEYNAR_API_KEY is set", async () => {
    const runtime = makeRuntime({ FARCASTER_NEYNAR_API_KEY: "neynar-key" });
    const provider = await FarcasterN8nCredentialProvider.start(runtime as never);
    const result = await provider.resolve("user1", "httpHeaderAuth");
    expect(result?.status).toBe("credential_data");
  });

  test("returns null when FARCASTER_NEYNAR_API_KEY is absent", async () => {
    const runtime = makeRuntime({});
    const provider = await FarcasterN8nCredentialProvider.start(runtime as never);
    expect(await provider.resolve("user1", "httpHeaderAuth")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bluesky
// ---------------------------------------------------------------------------
describe("BlueskyN8nCredentialProvider", () => {
  test("returns httpHeaderAuth credential when BLUESKY_HANDLE and BLUESKY_PASSWORD are set", async () => {
    const runtime = makeRuntime({ BLUESKY_HANDLE: "user.bsky.social", BLUESKY_PASSWORD: "app-password" });
    const provider = await BlueskyN8nCredentialProvider.start(runtime as never);
    const result = await provider.resolve("user1", "httpHeaderAuth");
    expect(result?.status).toBe("credential_data");
  });

  test("returns null when only BLUESKY_HANDLE is set", async () => {
    const runtime = makeRuntime({ BLUESKY_HANDLE: "user.bsky.social" });
    const provider = await BlueskyN8nCredentialProvider.start(runtime as never);
    expect(await provider.resolve("user1", "httpHeaderAuth")).toBeNull();
  });

  test("returns null when env vars are absent", async () => {
    const runtime = makeRuntime({});
    const provider = await BlueskyN8nCredentialProvider.start(runtime as never);
    expect(await provider.resolve("user1", "httpHeaderAuth")).toBeNull();
  });
});
