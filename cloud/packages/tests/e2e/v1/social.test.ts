import { describe, expect, test } from "bun:test";
import * as api from "../helpers/api-client";

/**
 * Social & Messaging Platform API E2E Tests
 *
 * Each platform has: /connect, /disconnect, /status routes.
 * Webhooks are at /api/webhooks/[platform]/[orgId] or /api/v1/[platform]/webhook/[orgId].
 */

describe("Telegram API", () => {
  test("POST /api/v1/telegram/connect requires auth", async () => {
    const response = await api.post("/api/v1/telegram/connect", {
      botToken: "test",
    });
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/telegram/status requires auth", async () => {
    const response = await api.get("/api/v1/telegram/status");
    expect([401, 403]).toContain(response.status);
  });

  test("DELETE /api/v1/telegram/disconnect requires auth", async () => {
    const response = await api.del("/api/v1/telegram/disconnect");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/telegram/chats requires auth", async () => {
    const response = await api.get("/api/v1/telegram/chats");
    expect([401, 403]).toContain(response.status);
  });
});

describe("Twitter API", () => {
  test("POST /api/v1/twitter/connect requires auth", async () => {
    const response = await api.post("/api/v1/twitter/connect");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/twitter/status requires auth", async () => {
    const response = await api.get("/api/v1/twitter/status");
    expect([401, 403]).toContain(response.status);
  });

  test("DELETE /api/v1/twitter/disconnect requires auth", async () => {
    const response = await api.del("/api/v1/twitter/disconnect");
    expect([401, 403]).toContain(response.status);
  });
});

describe("Discord API", () => {
  test("GET /api/v1/discord/status requires auth", async () => {
    const response = await api.get("/api/v1/discord/status");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/discord/guilds requires auth", async () => {
    const response = await api.get("/api/v1/discord/guilds");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/discord/channels requires auth", async () => {
    const response = await api.get("/api/v1/discord/channels");
    expect([401, 403]).toContain(response.status);
  });

  test("POST /api/v1/discord/disconnect requires auth", async () => {
    const response = await api.post("/api/v1/discord/disconnect");
    expect([401, 403]).toContain(response.status);
  });
});

describe("WhatsApp API", () => {
  test("POST /api/v1/whatsapp/connect requires auth", async () => {
    const response = await api.post("/api/v1/whatsapp/connect", {
      phoneNumber: "+1234567890",
    });
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/whatsapp/status requires auth", async () => {
    const response = await api.get("/api/v1/whatsapp/status");
    expect([401, 403]).toContain(response.status);
  });

  test("DELETE /api/v1/whatsapp/disconnect requires auth", async () => {
    const response = await api.del("/api/v1/whatsapp/disconnect");
    expect([401, 403]).toContain(response.status);
  });
});

describe("Twilio API", () => {
  test("POST /api/v1/twilio/connect requires auth", async () => {
    const response = await api.post("/api/v1/twilio/connect", {
      accountSid: "test",
    });
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/twilio/status requires auth", async () => {
    const response = await api.get("/api/v1/twilio/status");
    expect([401, 403]).toContain(response.status);
  });

  test("DELETE /api/v1/twilio/disconnect requires auth", async () => {
    const response = await api.del("/api/v1/twilio/disconnect");
    expect([401, 403]).toContain(response.status);
  });
});

describe("Blooio API", () => {
  test("POST /api/v1/blooio/connect requires auth", async () => {
    const response = await api.post("/api/v1/blooio/connect");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/blooio/status requires auth", async () => {
    const response = await api.get("/api/v1/blooio/status");
    expect([401, 403]).toContain(response.status);
  });

  test("DELETE /api/v1/blooio/disconnect requires auth", async () => {
    const response = await api.del("/api/v1/blooio/disconnect");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/blooio/webhook-secret requires auth", async () => {
    const response = await api.get("/api/v1/blooio/webhook-secret");
    expect([401, 403]).toContain(response.status);
  });
});
