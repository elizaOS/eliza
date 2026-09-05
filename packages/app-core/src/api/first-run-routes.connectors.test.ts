/**
 * Exercises both first-run HTTP handlers with real shared connector preparation
 * and config persistence in an isolated directory. Authentication, provider
 * credentials, voice/wallet initialization, and runtime boot are external ports.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ElizaConfig } from "@elizaos/shared/config/types.eliza";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirstRunRouteContext } from "../../../agent/src/api/first-run-routes.ts";
import {
  loadElizaConfig,
  saveElizaConfig,
} from "../../../agent/src/config/config.ts";

vi.mock("@elizaos/agent", () => ({
  loadElizaConfig,
  loadEffectiveElizaConfig: loadElizaConfig,
  saveElizaConfig,
  applyCanonicalFirstRunConfig: vi.fn(),
}));
vi.mock("./auth.ts", () => ({ ensureRouteAuthorized: async () => true }));
vi.mock("./compat-route-shared", () => ({
  hasCompatPersistedFirstRunState: () => false,
}));
vi.mock("./deferred-runtime-boot", () => ({
  isRuntimeBootDeferred: () => false,
  triggerDeferredRuntimeBoot: vi.fn(),
}));
const credentialPersistence = vi.fn();
vi.mock("./server-first-run-helpers", () => ({
  deriveFirstRunReplayBody: (body: Record<string, unknown>) => ({
    replayBody: body,
  }),
  extractAndPersistFirstRunApiKey: credentialPersistence,
  hasDeprecatedFirstRunRequestFields: () => false,
  persistFirstRunDefaults: vi.fn(),
}));

let directory: string;
let configPath: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  directory = mkdtempSync(join(tmpdir(), "first-run-connectors-"));
  configPath = join(directory, "eliza.json");
  process.env.ELIZA_STATE_DIR = directory;
  process.env.ELIZA_CONFIG_PATH = configPath;
  delete process.env.ELIZA_PERSIST_CONFIG_PATH;
  delete process.env.ELIZA_DEV_CLOUD_AUTHORITY;
  credentialPersistence.mockReset();
  saveElizaConfig({ connectors: { telegram: { enabled: false } } });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  rmSync(directory, { recursive: true, force: true });
});

function request(body: Record<string, unknown>): http.IncomingMessage {
  return Object.assign(
    Readable.from([Buffer.from(JSON.stringify(body), "utf8")]),
    {
      headers: { "content-type": "application/json" },
      method: "POST",
      url: "/api/first-run",
      socket: {},
    },
  ) as http.IncomingMessage;
}

function response() {
  let body = "";
  const sink = {
    statusCode: 200,
    headersSent: false,
    setHeader() {
      return sink;
    },
    end(value?: unknown) {
      body = String(value ?? "");
      sink.headersSent = true;
      return sink;
    },
  };
  return {
    res: sink as unknown as http.ServerResponse,
    json: () => JSON.parse(body) as Record<string, unknown>,
  };
}

async function post(host: "agent" | "app-core", body: Record<string, unknown>) {
  const req = request(body);
  const sink = response();
  if (host === "app-core") {
    const { handleFirstRunRoute } = await import("./first-run-routes.ts");
    await handleFirstRunRoute(req, sink.res, {
      current: null,
      pendingAgentName: null,
      pendingRestartReasons: [],
    });
  } else {
    const { handleFirstRunRoutes } = await import(
      "../../../agent/src/api/first-run-routes.ts"
    );
    const json: FirstRunRouteContext["json"] = (res, value, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    await handleFirstRunRoutes({
      req,
      res: sink.res,
      method: "POST",
      pathname: "/api/first-run",
      url: new URL("http://localhost/api/first-run"),
      state: {
        config: loadElizaConfig(),
        runtime: null,
        agentName: "Eliza",
        adminEntityId: null,
        chatUserId: null,
        chatConnectionReady: null,
        chatConnectionPromise: null,
      },
      json,
      error: (res, message, status) => json(res, { error: message }, status),
      readJsonBody: async <T extends object>() => body as T,
      isCloudProvisionedContainer: () => false,
      hasPersistedFirstRunState: () => false,
      ensureWalletKeysInEnvAndConfig: () => false,
      getWalletAddresses: () => ({}),
      pickRandomNames: () => [],
      getStylePresets: () => [],
      getProviderOptions: () => [],
      getCloudProviderOptions: () => [],
      getModelOptions: () => [],
      getInventoryProviderOptions: () => [],
      resolveConfiguredCharacterLanguage: () => "en",
      normalizeCharacterLanguage: () => "en",
      readUiLanguageHeader: () => "en",
      applyFirstRunVoicePreset: () => undefined,
      saveElizaConfig,
    });
  }
  return sink;
}

const connector = {
  apiKey: " test-blooio-key ",
  webhookSecret: " test-webhook-secret ",
  fromNumber: " +15551234567 ",
  channelId: " test-channel ",
};

describe.each(["agent", "app-core"] as const)(
  "%s first-run connector commit",
  (host) => {
    it("persists canonical connector credentials, merges explicit settings, and survives reload", async () => {
      const result = await post(host, {
        name: "Eliza",
        connectors: {
          blooio: connector,
          telegram: { botToken: "test-telegram" },
        },
        twilioAccountSid: " test-sid ",
        twilioAuthToken: " test-token ",
      });
      expect(result.res.statusCode).toBe(200);
      expect(result.json()).toEqual({ ok: true });
      const loaded = loadElizaConfig();
      expect(loaded.connectors).toMatchObject({
        blooio: {
          apiKey: "test-blooio-key",
          webhookSecret: "test-webhook-secret",
          fromNumber: "+15551234567",
          channelId: "test-channel",
        },
        telegram: { enabled: false, botToken: "test-telegram" },
      });
      expect(loaded.env).toMatchObject({
        IMESSAGE_TRANSPORT: "blooio",
        IMESSAGE_BLOOIO_API_KEY: "test-blooio-key",
        IMESSAGE_BLOOIO_CHANNEL_ID: "test-channel",
        TWILIO_ACCOUNT_SID: "test-sid",
        TWILIO_AUTH_TOKEN: "test-token",
      });
      expect(process.env.IMESSAGE_BLOOIO_CHANNEL_ID).toBe("test-channel");
      expect(loaded.meta?.firstRunComplete).toBe(true);
    });

    if (host === "app-core") {
      it("preserves connector edits made while provider credentials are being resolved", async () => {
        credentialPersistence.mockImplementationOnce(async () => {
          const concurrent = loadElizaConfig();
          concurrent.connectors = {
            ...concurrent.connectors,
            discord: { token: "concurrent-token" },
            telegram: { enabled: false, dmPolicy: "pairing" },
          };
          saveElizaConfig(concurrent);
        });
        const result = await post(host, {
          name: "Eliza",
          connectors: { telegram: { botToken: "submitted-token" } },
        });
        expect(result.res.statusCode).toBe(200);
        expect(loadElizaConfig().connectors).toMatchObject({
          discord: { token: "concurrent-token" },
          telegram: {
            enabled: false,
            dmPolicy: "pairing",
            botToken: "submitted-token",
          },
        });
      });
    }
    it("rejects incomplete Blooio input before any durable setup mutation", async () => {
      const before = readFileSync(configPath, "utf8");
      const result = await post(host, {
        name: "Eliza",
        connectors: { blooio: { apiKey: "incomplete" } },
      });
      expect(result.res.statusCode).toBe(400);
      expect(result.json()).toEqual({
        error:
          "Incomplete Blooio connector configuration; missing: webhookSecret, fromNumber, channelId",
      });
      expect(readFileSync(configPath, "utf8")).toBe(before);
      expect(credentialPersistence).not.toHaveBeenCalled();
    });

    it("completes stored credentials from legacy aliases without losing unrelated connectors", async () => {
      const current: ElizaConfig = loadElizaConfig();
      current.connectors ??= {};
      current.connectors.blooio = {
        webhookSecret: "saved-secret",
        channelId: "saved-channel",
      };
      saveElizaConfig(current);
      const result = await post(host, {
        name: "Eliza",
        blooioApiKey: "new-key",
        blooioPhoneNumber: "+15550001111",
      });
      expect(result.res.statusCode).toBe(200);
      expect(loadElizaConfig().connectors).toMatchObject({
        telegram: { enabled: false },
        blooio: {
          apiKey: "new-key",
          webhookSecret: "saved-secret",
          channelId: "saved-channel",
          fromNumber: "+15550001111",
        },
      });
    });
  },
);
