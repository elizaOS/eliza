/**
 * Checks that the agent compat bridge behind the frozen
 * `@elizaos/agent/config/plugin-auto-enable` subpath keeps forwarding the live
 * shared surface by identity and that the forwarded connector map and
 * configured-detection helper still behave the way boot-time auto-enable and
 * host config sync consume them. Deterministic: drives the real modules with
 * no mocks.
 */
import * as SHARED_SURFACE from "@elizaos/shared";
import { describe, expect, test } from "vitest";

import {
  CONNECTOR_PLUGINS,
  isConnectorConfigured,
} from "./plugin-auto-enable.ts";

describe("plugin-auto-enable compat bridge", () => {
  test("forwards the live shared exports by identity", () => {
    expect(typeof isConnectorConfigured).toBe("function");
    expect(CONNECTOR_PLUGINS).toBe(SHARED_SURFACE.CONNECTOR_PLUGINS);
    expect(isConnectorConfigured).toBe(SHARED_SURFACE.isConnectorConfigured);
  });
});

describe("CONNECTOR_PLUGINS", () => {
  test("is a populated record of connector keys to plugin package names", () => {
    const entries = Object.entries(CONNECTOR_PLUGINS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [connectorKey, pluginName] of entries) {
      expect(connectorKey.length).toBeGreaterThan(0);
      expect(typeof pluginName).toBe("string");
      expect(pluginName.length).toBeGreaterThan(0);
    }
  });

  test("detects every mapped connector once a universal credential is present", () => {
    for (const connectorKey of Object.keys(CONNECTOR_PLUGINS)) {
      expect(isConnectorConfigured(connectorKey, { apiKey: "secret" })).toBe(
        true,
      );
    }
  });

  test("leaves every mapped connector unconfigured on an empty block", () => {
    for (const connectorKey of Object.keys(CONNECTOR_PLUGINS)) {
      expect(isConnectorConfigured(connectorKey, {})).toBe(false);
    }
  });
});

describe("isConnectorConfigured", () => {
  test("rejects missing or non-object configuration blocks", () => {
    expect(isConnectorConfigured("discord", undefined)).toBe(false);
    expect(isConnectorConfigured("discord", null)).toBe(false);
    expect(isConnectorConfigured("discord", "")).toBe(false);
    expect(isConnectorConfigured("discord", 0)).toBe(false);
    expect(isConnectorConfigured("discord", false)).toBe(false);
    expect(isConnectorConfigured("discord", "botToken")).toBe(false);
  });

  test("an explicit enabled:false wins over present credentials", () => {
    expect(
      isConnectorConfigured("discord", { botToken: "t", enabled: false }),
    ).toBe(false);
  });

  test("any truthy universal credential configures an otherwise unknown name", () => {
    expect(isConnectorConfigured("discord", { botToken: "t" })).toBe(true);
    expect(isConnectorConfigured("slack", { token: "t" })).toBe(true);
    expect(isConnectorConfigured("not-a-connector", { apiKey: "k" })).toBe(
      true,
    );
  });

  test("falsy universal credential values do not configure anything", () => {
    expect(isConnectorConfigured("discord", { token: "" })).toBe(false);
    expect(isConnectorConfigured("slack", { token: 0 })).toBe(false);
    expect(isConnectorConfigured("not-a-connector", { apiKey: false })).toBe(
      false,
    );
  });

  test("bluebubbles needs both serverUrl and password", () => {
    expect(
      isConnectorConfigured("bluebubbles", { serverUrl: "http://x" }),
    ).toBe(false);
    expect(isConnectorConfigured("bluebubbles", { password: "p" })).toBe(false);
    expect(
      isConnectorConfigured("bluebubbles", {
        serverUrl: "http://x",
        password: "p",
      }),
    ).toBe(true);
  });

  test("discordLocal needs both clientId and clientSecret", () => {
    expect(isConnectorConfigured("discordLocal", { clientId: "id" })).toBe(
      false,
    );
    expect(
      isConnectorConfigured("discordLocal", {
        clientId: "id",
        clientSecret: "s",
      }),
    ).toBe(true);
  });

  test("imessage accepts enabled:true alone and ignores stringly truthy flags", () => {
    expect(isConnectorConfigured("imessage", { enabled: true })).toBe(true);
    expect(isConnectorConfigured("imessage", { cliPath: "/usr/bin/im" })).toBe(
      true,
    );
    expect(isConnectorConfigured("imessage", { dbPath: "/tmp/chat.db" })).toBe(
      true,
    );
    expect(isConnectorConfigured("imessage", { enabled: "true" })).toBe(false);
    expect(isConnectorConfigured("imessage", {})).toBe(false);
  });

  test("whatsapp honors legacy fields and per-account auth directories", () => {
    expect(isConnectorConfigured("whatsapp", { authState: "state" })).toBe(
      true,
    );
    expect(isConnectorConfigured("whatsapp", { sessionPath: "/tmp/s" })).toBe(
      true,
    );
    expect(
      isConnectorConfigured("whatsapp", {
        accounts: { main: { authDir: "/a" } },
      }),
    ).toBe(true);
    expect(
      isConnectorConfigured("whatsapp", {
        accounts: { main: { authDir: "/a", enabled: false } },
      }),
    ).toBe(false);
    expect(
      isConnectorConfigured("whatsapp", { accounts: { broken: null } }),
    ).toBe(false);
    expect(isConnectorConfigured("whatsapp", {})).toBe(false);
  });

  test("wechat detects credentials only on accounts that are not disabled", () => {
    expect(
      isConnectorConfigured("wechat", { accounts: { main: { apiKey: "k" } } }),
    ).toBe(true);
    expect(
      isConnectorConfigured("wechat", {
        accounts: { main: { apiKey: "k", enabled: false } },
      }),
    ).toBe(false);
    expect(isConnectorConfigured("wechat", { accounts: {} })).toBe(false);
  });

  test("googlechat requires service-account material and rejects array blocks", () => {
    expect(
      isConnectorConfigured("googlechat", { serviceAccount: "sa.json" }),
    ).toBe(true);
    expect(
      isConnectorConfigured("googlechat", {
        serviceAccount: { clientEmail: "bot@project.iam" },
      }),
    ).toBe(true);
    expect(isConnectorConfigured("googlechat", { projectId: "p" })).toBe(false);
    expect(
      isConnectorConfigured("googlechat", [{ serviceAccount: "sa.json" }]),
    ).toBe(false);
  });

  test("unknown connector names without universal credentials stay unconfigured", () => {
    expect(isConnectorConfigured("not-a-connector", { clientId: "id" })).toBe(
      false,
    );
    expect(
      isConnectorConfigured("", { serverUrl: "http://x", password: "p" }),
    ).toBe(false);
  });
});
