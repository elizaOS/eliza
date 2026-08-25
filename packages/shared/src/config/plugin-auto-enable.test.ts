/**
 * Unit tests for the backward-compat plugin-auto-enable wrapper. The suite
 * drives the real re-export surface (CONNECTOR_PLUGINS and
 * isConnectorConfigured) without mocks: the map must stay sourced from the
 * generated first-party channel-plugin-map, and configured-detection must
 * follow the live connector-specific branches.
 */
import { describe, expect, it } from "vitest";

import { isConnectorConfigured } from "./plugin-auto-enable";

describe("isConnectorConfigured", () => {
  it("rejects nullish, primitive, and empty non-object configuration", () => {
    expect(isConnectorConfigured("discord", undefined)).toBe(false);
    expect(isConnectorConfigured("discord", null)).toBe(false);
    expect(isConnectorConfigured("discord", "")).toBe(false);
    expect(isConnectorConfigured("discord", 0)).toBe(false);
    expect(isConnectorConfigured("discord", false)).toBe(false);
    expect(isConnectorConfigured("discord", true)).toBe(false);
    expect(isConnectorConfigured("discord", "token")).toBe(false);
  });

  it("rejects an empty config object and a config with enabled:false even when credentials exist", () => {
    expect(isConnectorConfigured("discord", {})).toBe(false);
    expect(
      isConnectorConfigured("discord", {
        enabled: false,
        apiKey: "secret",
        botToken: "tok",
      }),
    ).toBe(false);
    expect(
      isConnectorConfigured("wechat", { enabled: false, apiKey: "secret" }),
    ).toBe(false);
  });

  it("accepts the universal credential fields botToken, token, and apiKey", () => {
    expect(isConnectorConfigured("discord", { botToken: "b" })).toBe(true);
    expect(isConnectorConfigured("slack", { token: "t" })).toBe(true);
    expect(isConnectorConfigured("unknown", { apiKey: "k" })).toBe(true);
    expect(isConnectorConfigured("discord", { botToken: "" })).toBe(false);
    expect(isConnectorConfigured("discord", { token: 0 })).toBe(false);
  });

  it("requires both serverUrl and password for bluebubbles", () => {
    expect(
      isConnectorConfigured("bluebubbles", { serverUrl: "https://x" }),
    ).toBe(false);
    expect(isConnectorConfigured("bluebubbles", { password: "p" })).toBe(false);
    expect(
      isConnectorConfigured("bluebubbles", {
        serverUrl: "https://x",
        password: "p",
      }),
    ).toBe(true);
  });

  it("requires both clientId and clientSecret for discordLocal, not discord", () => {
    expect(
      isConnectorConfigured("discordLocal", {
        clientId: "id",
        clientSecret: "secret",
      }),
    ).toBe(true);
    expect(isConnectorConfigured("discordLocal", { clientId: "id" })).toBe(
      false,
    );
    expect(
      isConnectorConfigured("discord", {
        clientId: "id",
        clientSecret: "secret",
      }),
    ).toBe(false);
  });

  it("treats imessage as configured when enabled, cliPath, or dbPath is set", () => {
    expect(isConnectorConfigured("imessage", {})).toBe(false);
    expect(isConnectorConfigured("imessage", { enabled: true })).toBe(true);
    expect(isConnectorConfigured("imessage", { cliPath: "/usr/bin/im" })).toBe(
      true,
    );
    expect(isConnectorConfigured("imessage", { dbPath: "/tmp/chat.db" })).toBe(
      true,
    );
    expect(isConnectorConfigured("imessage", { enabled: "true" })).toBe(false);
  });

  it("accepts whatsapp legacy session fields and any enabled account with authDir", () => {
    expect(isConnectorConfigured("whatsapp", { authState: "state" })).toBe(
      true,
    );
    expect(isConnectorConfigured("whatsapp", { sessionPath: "/tmp/s" })).toBe(
      true,
    );
    expect(isConnectorConfigured("whatsapp", { authDir: "/tmp/auth" })).toBe(
      true,
    );
    expect(
      isConnectorConfigured("whatsapp", {
        accounts: { a: { authDir: "/tmp/a" } },
      }),
    ).toBe(true);
    expect(
      isConnectorConfigured("whatsapp", {
        accounts: { a: { authDir: "/tmp/a", enabled: false } },
      }),
    ).toBe(false);
    expect(
      isConnectorConfigured("whatsapp", {
        accounts: { a: null, b: "skip", c: { authDir: "/tmp/c" } },
      }),
    ).toBe(true);
    expect(isConnectorConfigured("whatsapp", { accounts: {} })).toBe(false);
    expect(
      isConnectorConfigured("whatsapp", { accounts: "not-an-object" }),
    ).toBe(false);
    expect(isConnectorConfigured("whatsapp", {})).toBe(false);
  });

  it("accepts twitch accessToken, clientId, or enabled:true", () => {
    expect(isConnectorConfigured("twitch", { accessToken: "tok" })).toBe(true);
    expect(isConnectorConfigured("twitch", { clientId: "id" })).toBe(true);
    expect(isConnectorConfigured("twitch", { enabled: true })).toBe(true);
    expect(isConnectorConfigured("twitch", {})).toBe(false);
  });

  it("detects wechat via top-level apiKey or any enabled account apiKey", () => {
    expect(isConnectorConfigured("wechat", { apiKey: "k" })).toBe(true);
    expect(
      isConnectorConfigured("wechat", {
        accounts: { a: { apiKey: "k" } },
      }),
    ).toBe(true);
    expect(
      isConnectorConfigured("wechat", {
        accounts: { a: { apiKey: "k", enabled: false } },
      }),
    ).toBe(false);
    expect(
      isConnectorConfigured("wechat", {
        accounts: { a: null, b: { apiKey: "k" } },
      }),
    ).toBe(true);
    expect(isConnectorConfigured("wechat", { accounts: {} })).toBe(false);
    expect(isConnectorConfigured("wechat", {})).toBe(false);
  });

  it("detects googlechat via service-account material at the top level or on an enabled account", () => {
    expect(
      isConnectorConfigured("googlechat", { serviceAccount: "sa.json" }),
    ).toBe(true);
    expect(
      isConnectorConfigured("googlechat", {
        serviceAccount: { client_email: "x" },
      }),
    ).toBe(true);
    expect(
      isConnectorConfigured("googlechat", {
        serviceAccountFile: "/tmp/sa.json",
      }),
    ).toBe(true);
    expect(
      isConnectorConfigured("googlechat", { serviceAccountKey: "key" }),
    ).toBe(true);
    expect(isConnectorConfigured("googlechat", { serviceAccount: "   " })).toBe(
      false,
    );
    expect(isConnectorConfigured("googlechat", { serviceAccount: [] })).toBe(
      false,
    );
    expect(isConnectorConfigured("googlechat", { projectId: "p" })).toBe(false);
    expect(
      isConnectorConfigured("googlechat", {
        accounts: { a: { serviceAccountFile: "/tmp/a.json" } },
      }),
    ).toBe(true);
    expect(
      isConnectorConfigured("googlechat", {
        accounts: {
          a: { serviceAccountFile: "/tmp/a.json", enabled: false },
        },
      }),
    ).toBe(false);
    expect(
      isConnectorConfigured("googlechat", {
        accounts: { a: ["not", "a", "record"] },
      }),
    ).toBe(false);
    expect(
      isConnectorConfigured("googlechat", {
        accounts: [{ serviceAccount: "sa.json" }],
      }),
    ).toBe(false);
    expect(isConnectorConfigured("googlechat", {})).toBe(false);
  });

  it("returns false for unknown connector names without universal credentials", () => {
    expect(isConnectorConfigured("matrix", { clientId: "id" })).toBe(false);
    expect(isConnectorConfigured("", { enabled: true })).toBe(false);
    expect(isConnectorConfigured("not-a-connector", { serverUrl: "x" })).toBe(
      false,
    );
  });
});
