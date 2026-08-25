/**
 * Behavioral coverage for `handleSecretsInventoryRoute`. Drives the real
 * dispatcher against a `createTestVault` injected through
 * `_resetSharedVaultForTesting`, covering inventory listing and category
 * filtering, key/profile/routing CRUD, reserved-key rejection, migrate-to-
 * profiles outcomes, and method/path pass-through. Auth is stubbed open so
 * this suite records inventory behaviour rather than the OWNER gate already
 * covered by `secrets-routes-auth.test.ts`.
 */
import * as http from "node:http";
import { Socket } from "node:net";
import { Readable } from "node:stream";
import {
  createTestVault,
  profileStorageKey,
  ROUTING_KEY,
  type TestVault,
} from "@elizaos/vault";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { _resetSharedVaultForTesting } from "../services/vault-mirror";

const configMocks = vi.hoisted(() => ({
  loadElizaConfig: vi.fn(() => ({}) as Record<string, unknown>),
  resolveStateDir: vi.fn(() => "/tmp/eliza-secrets-inventory-routes-test"),
  ensureRouteMinRole: vi.fn(async () => true),
  ensureCompatSensitiveRouteAuthorized: vi.fn(() => true),
}));

vi.mock("@elizaos/agent/config/config", () => ({
  loadElizaConfig: configMocks.loadElizaConfig,
}));

vi.mock("@elizaos/agent/config/paths", () => ({
  resolveStateDir: configMocks.resolveStateDir,
}));

vi.mock("./auth.ts", () => ({
  ensureRouteMinRole: configMocks.ensureRouteMinRole,
  ensureCompatSensitiveRouteAuthorized:
    configMocks.ensureCompatSensitiveRouteAuthorized,
}));

import { handleSecretsInventoryRoute } from "./secrets-inventory-routes";

const STATE = { current: null };

interface FakeRes {
  body(): unknown;
  res: http.ServerResponse;
  status(): number;
}

function fakeRes(): FakeRes {
  let bodyText = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.setHeader = () => res;
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") bodyText += chunk;
    else if (chunk) bodyText += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    body() {
      return bodyText.length > 0 ? JSON.parse(bodyText) : null;
    },
    res,
    status() {
      return res.statusCode;
    },
  };
}

function fakeReq(
  method: string,
  url: string,
  body?: string | Record<string, unknown>,
): http.IncomingMessage {
  const raw =
    body === undefined
      ? ""
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  const stream = Readable.from(
    raw.length === 0 ? [] : [Buffer.from(raw, "utf8")],
  );
  return Object.assign(stream, {
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    method,
    socket: { remoteAddress: "127.0.0.1" },
    url,
  }) as unknown as http.IncomingMessage;
}

async function call(
  method: string,
  pathname: string,
  options: {
    body?: string | Record<string, unknown>;
    url?: string;
  } = {},
): Promise<{ body: unknown; handled: boolean; status: number }> {
  const res = fakeRes();
  const handled = await handleSecretsInventoryRoute(
    fakeReq(method, options.url ?? pathname, options.body),
    res.res,
    pathname,
    method,
    STATE,
  );
  return { body: res.body(), handled, status: res.status() };
}

async function clearVault(vault: TestVault["vault"]): Promise<void> {
  const keys = await vault.list();
  for (const key of keys) {
    await vault.remove(key);
  }
}

describe("handleSecretsInventoryRoute", () => {
  let testVault: TestVault;

  beforeAll(async () => {
    testVault = await createTestVault();
    _resetSharedVaultForTesting(testVault.vault);
  });

  afterAll(async () => {
    _resetSharedVaultForTesting();
    await testVault.dispose();
  });

  beforeEach(async () => {
    configMocks.ensureRouteMinRole.mockReset();
    configMocks.ensureRouteMinRole.mockResolvedValue(true);
    configMocks.ensureCompatSensitiveRouteAuthorized.mockReset();
    configMocks.ensureCompatSensitiveRouteAuthorized.mockReturnValue(true);
    configMocks.loadElizaConfig.mockReset();
    configMocks.loadElizaConfig.mockReturnValue({});
    configMocks.resolveStateDir.mockReset();
    configMocks.resolveStateDir.mockReturnValue(
      "/tmp/eliza-secrets-inventory-routes-test",
    );
    await clearVault(testVault.vault);
  });

  describe("path and method dispatch", () => {
    it("returns false for paths outside inventory and routing prefixes", async () => {
      const result = await call("GET", "/api/other");
      expect(result.handled).toBe(false);
      expect(result.body).toBeNull();
    });

    it("returns false for an inventory tail that is not a known sub-route", async () => {
      const result = await call(
        "GET",
        "/api/secrets/inventory/OPENAI_API_KEY/extra",
      );
      expect(result.handled).toBe(false);
      expect(result.body).toBeNull();
    });

    it("returns false for a trailing slash with no key", async () => {
      const result = await call("GET", "/api/secrets/inventory/");
      expect(result.handled).toBe(false);
    });

    it("stops at the OWNER gate before touching the vault", async () => {
      configMocks.ensureRouteMinRole.mockResolvedValueOnce(false);
      const result = await call("GET", "/api/secrets/inventory");
      expect(result.handled).toBe(true);
      expect(configMocks.loadElizaConfig).not.toHaveBeenCalled();
      expect(await testVault.vault.list()).toEqual([]);
    });
  });

  describe("GET/PUT /api/secrets/routing", () => {
    it("GET returns the empty routing config when nothing is stored", async () => {
      const result = await call("GET", "/api/secrets/routing");
      expect(result).toEqual({
        handled: true,
        status: 200,
        body: { ok: true, config: { rules: [] } },
      });
    });

    it("PUT rejects invalid JSON, a missing config object, and non-PUT methods", async () => {
      const invalidJson = await call("PUT", "/api/secrets/routing", {
        body: "{",
      });
      expect(invalidJson.status).toBe(400);
      expect(invalidJson.body).toEqual({ error: "invalid JSON body" });

      const missing = await call("PUT", "/api/secrets/routing", { body: {} });
      expect(missing.status).toBe(400);
      expect(missing.body).toEqual({ error: "missing `config` field" });

      const notObject = await call("PUT", "/api/secrets/routing", {
        body: { config: "nope" },
      });
      expect(notObject.status).toBe(400);
      expect(notObject.body).toEqual({ error: "missing `config` field" });

      const method = await call("PATCH", "/api/secrets/routing");
      expect(method.status).toBe(405);
      expect(method.body).toEqual({ error: "method not allowed" });
    });

    it("PUT persists normalized rules, drops reserved keyPatterns, and keeps order", async () => {
      const result = await call("PUT", "/api/secrets/routing", {
        body: {
          config: {
            defaultProfile: "work",
            extra: "stripped",
            rules: [
              {
                keyPattern: "OPENAI_API_KEY",
                profileId: "work",
                scope: { agentId: "agent-a", kind: "agent" },
              },
              {
                keyPattern: "_meta.OPENAI_API_KEY",
                profileId: "work",
                scope: { agentId: "agent-a", kind: "agent" },
              },
              {
                keyPattern: ROUTING_KEY,
                profileId: "work",
                scope: { agentId: "agent-a", kind: "agent" },
              },
              {
                keyPattern: "OPENAI_API_KEY",
                profileId: "personal",
                scope: { agentId: "agent-b", kind: "agent" },
              },
            ],
          },
        },
      });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        ok: true,
        config: {
          defaultProfile: "work",
          rules: [
            {
              keyPattern: "OPENAI_API_KEY",
              profileId: "work",
              scope: { agentId: "agent-a", kind: "agent" },
            },
            {
              keyPattern: "OPENAI_API_KEY",
              profileId: "personal",
              scope: { agentId: "agent-b", kind: "agent" },
            },
          ],
        },
      });
    });

    it("PUT with an array config normalizes to empty rules", async () => {
      const result = await call("PUT", "/api/secrets/routing", {
        body: { config: [] },
      });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true, config: { rules: [] } });
    });

    it("PUT does not write when the sensitive gate refuses", async () => {
      configMocks.ensureCompatSensitiveRouteAuthorized.mockReturnValueOnce(
        false,
      );
      const result = await call("PUT", "/api/secrets/routing", {
        body: { config: { rules: [] } },
      });
      expect(result.handled).toBe(true);
      expect(await testVault.vault.has(ROUTING_KEY)).toBe(false);
    });
  });

  describe("GET /api/secrets/inventory", () => {
    it("returns an empty queue, empty findings, and available=true", async () => {
      const result = await call("GET", "/api/secrets/inventory");
      expect(result).toEqual({
        handled: true,
        status: 200,
        body: {
          ok: true,
          entries: [],
          securityFindings: [],
          securityFindingsAvailable: true,
        },
      });
    });

    it("lists a single entry and connector findings without revealing values", async () => {
      await testVault.vault.set("OPENAI_API_KEY", "sk-live-secret", {
        sensitive: true,
      });
      configMocks.loadElizaConfig.mockReturnValue({
        connectors: { telegram: { botToken: "tg-bot-secret" } },
      });

      const result = await call("GET", "/api/secrets/inventory");
      expect(result.status).toBe(200);
      const body = result.body as {
        entries: Array<{ category: string; key: string }>;
        ok: boolean;
        securityFindings: Array<{ id: string }>;
        securityFindingsAvailable: boolean;
      };
      expect(body.ok).toBe(true);
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]?.key).toBe("OPENAI_API_KEY");
      expect(body.entries[0]?.category).toBe("provider");
      expect(body.securityFindingsAvailable).toBe(true);
      expect(body.securityFindings.map((finding) => finding.id)).toContain(
        "config:telegram.botToken",
      );
      expect(JSON.stringify(result.body)).not.toContain("sk-live-secret");
      expect(JSON.stringify(result.body)).not.toContain("tg-bot-secret");
    });

    it("filters by category and skips the connector scan", async () => {
      await testVault.vault.set("OPENAI_API_KEY", "sk-live", {
        sensitive: true,
      });
      await testVault.vault.set("GITHUB_TOKEN", "ghp-live", {
        sensitive: true,
      });
      configMocks.loadElizaConfig.mockReturnValue({
        connectors: { telegram: { botToken: "tg-bot-secret" } },
      });

      const provider = await call("GET", "/api/secrets/inventory", {
        url: "/api/secrets/inventory?category=provider",
      });
      expect(provider.status).toBe(200);
      const providerBody = provider.body as {
        entries: Array<{ key: string }>;
        securityFindings: unknown[];
        securityFindingsAvailable: boolean;
      };
      expect(providerBody.entries.map((entry) => entry.key)).toEqual([
        "OPENAI_API_KEY",
      ]);
      expect(providerBody.securityFindings).toEqual([]);
      expect(providerBody.securityFindingsAvailable).toBe(true);
      expect(configMocks.loadElizaConfig).not.toHaveBeenCalled();

      const plugin = await call("GET", "/api/secrets/inventory", {
        url: "/api/secrets/inventory?category=plugin",
      });
      const pluginBody = plugin.body as { entries: Array<{ key: string }> };
      expect(pluginBody.entries.map((entry) => entry.key)).toEqual([
        "GITHUB_TOKEN",
      ]);
    });

    it("rejects an unknown category and non-GET methods", async () => {
      const unknown = await call("GET", "/api/secrets/inventory", {
        url: "/api/secrets/inventory?category=nope",
      });
      expect(unknown.status).toBe(400);
      expect(unknown.body).toEqual({
        error: "`category` must be a known VaultEntryCategory",
      });

      const empty = await call("GET", "/api/secrets/inventory", {
        url: "/api/secrets/inventory?category=",
      });
      expect(empty.status).toBe(400);

      const method = await call("POST", "/api/secrets/inventory");
      expect(method.status).toBe(405);
      expect(method.body).toEqual({ error: "method not allowed" });
    });

    it("marks connector findings unavailable when the config load throws", async () => {
      configMocks.loadElizaConfig.mockImplementation(() => {
        throw new Error("config missing");
      });
      const result = await call("GET", "/api/secrets/inventory");
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        ok: true,
        entries: [],
        securityFindings: [],
        securityFindingsAvailable: false,
      });
      expect(JSON.stringify(result.body)).not.toContain("config missing");
    });
  });

  describe("POST /api/secrets/inventory/migrate-to-profiles", () => {
    it("rejects non-POST methods and invalid keys, including reserved names", async () => {
      const method = await call(
        "GET",
        "/api/secrets/inventory/migrate-to-profiles",
      );
      expect(method.status).toBe(405);

      const missing = await call(
        "POST",
        "/api/secrets/inventory/migrate-to-profiles",
        { body: {} },
      );
      expect(missing.status).toBe(400);
      expect(missing.body).toEqual({ error: "invalid `key`" });

      const malformedJson = await call(
        "POST",
        "/api/secrets/inventory/migrate-to-profiles",
        { body: "{" },
      );
      expect(malformedJson.status).toBe(400);
      expect(malformedJson.body).toEqual({ error: "invalid `key`" });

      const reserved = await call(
        "POST",
        "/api/secrets/inventory/migrate-to-profiles",
        { body: { key: ROUTING_KEY } },
      );
      expect(reserved.status).toBe(400);
      expect(reserved.body).toEqual({ error: "invalid `key`" });

      const meta = await call(
        "POST",
        "/api/secrets/inventory/migrate-to-profiles",
        { body: { key: "_meta.OPENAI_API_KEY" } },
      );
      expect(meta.status).toBe(400);

      const manager = await call(
        "POST",
        "/api/secrets/inventory/migrate-to-profiles",
        { body: { key: "_manager.preferences" } },
      );
      expect(manager.status).toBe(400);

      const badChars = await call(
        "POST",
        "/api/secrets/inventory/migrate-to-profiles",
        { body: { key: "OPENAI API KEY" } },
      );
      expect(badChars.status).toBe(400);
    });

    it("reports key-not-found when the bare key is absent", async () => {
      const result = await call(
        "POST",
        "/api/secrets/inventory/migrate-to-profiles",
        { body: { key: "OPENAI_API_KEY" } },
      );
      expect(result).toEqual({
        handled: true,
        status: 200,
        body: { ok: true, migrated: false, reason: "key-not-found" },
      });
    });

    it("copies a bare value into the default profile and is idempotent", async () => {
      await testVault.vault.set("OPENAI_API_KEY", "sk-to-migrate", {
        sensitive: true,
      });

      const first = await call(
        "POST",
        "/api/secrets/inventory/migrate-to-profiles",
        { body: { key: "OPENAI_API_KEY" } },
      );
      expect(first.body).toEqual({
        ok: true,
        migrated: true,
        profileId: "default",
      });

      const revealed = await call(
        "GET",
        "/api/secrets/inventory/OPENAI_API_KEY",
      );
      expect(revealed.body).toEqual({
        ok: true,
        value: "sk-to-migrate",
        source: "profile",
        profileId: "default",
      });

      const second = await call(
        "POST",
        "/api/secrets/inventory/migrate-to-profiles",
        { body: { key: "OPENAI_API_KEY" } },
      );
      expect(second.body).toEqual({
        ok: true,
        migrated: false,
        reason: "already-has-profiles",
      });
    });
  });

  describe("GET/PUT/DELETE /api/secrets/inventory/:key", () => {
    it("rejects reserved and invalid keys", async () => {
      const routing = await call(
        "GET",
        `/api/secrets/inventory/${ROUTING_KEY}`,
      );
      expect(routing.status).toBe(400);
      expect(routing.body).toEqual({ error: "invalid `key`" });

      const meta = await call(
        "GET",
        "/api/secrets/inventory/_meta.OPENAI_API_KEY",
      );
      expect(meta.status).toBe(400);

      const manager = await call(
        "GET",
        "/api/secrets/inventory/_manager.preferences",
      );
      expect(manager.status).toBe(400);

      const bad = await call("GET", "/api/secrets/inventory/bad@key");
      expect(bad.status).toBe(400);
    });

    it("GET returns 404 for a missing key", async () => {
      const result = await call("GET", "/api/secrets/inventory/OPENAI_API_KEY");
      expect(result.status).toBe(404);
      expect(result.body).toEqual({ error: "no entry for key" });
    });

    it("GET reveals a bare value, then the active profile when that row exists", async () => {
      await testVault.vault.set("OPENAI_API_KEY", "sk-bare", {
        sensitive: true,
      });
      const bare = await call("GET", "/api/secrets/inventory/OPENAI_API_KEY");
      expect(bare.body).toEqual({
        ok: true,
        value: "sk-bare",
        source: "bare",
      });

      const created = await call(
        "POST",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles",
        { body: { id: "work", label: "Work", value: "sk-work" } },
      );
      expect(created.status).toBe(200);

      const fromProfile = await call(
        "GET",
        "/api/secrets/inventory/OPENAI_API_KEY",
      );
      expect(fromProfile.body).toEqual({
        ok: true,
        value: "sk-work",
        source: "profile",
        profileId: "work",
      });
    });

    it("GET falls through to the bare value when the active profile row is missing", async () => {
      await testVault.vault.set("OPENAI_API_KEY", "sk-bare", {
        sensitive: true,
      });
      await call("POST", "/api/secrets/inventory/OPENAI_API_KEY/profiles", {
        body: { id: "work", value: "sk-work" },
      });
      await testVault.vault.remove(profileStorageKey("OPENAI_API_KEY", "work"));

      const result = await call("GET", "/api/secrets/inventory/OPENAI_API_KEY");
      expect(result.body).toEqual({
        ok: true,
        value: "sk-bare",
        source: "bare",
      });
    });

    it("PUT rejects invalid bodies and writes value plus optional meta", async () => {
      const invalidJson = await call(
        "PUT",
        "/api/secrets/inventory/OPENAI_API_KEY",
        {
          body: "{",
        },
      );
      expect(invalidJson.body).toEqual({ error: "invalid JSON body" });

      const missingValue = await call(
        "PUT",
        "/api/secrets/inventory/OPENAI_API_KEY",
        { body: {} },
      );
      expect(missingValue.body).toEqual({ error: "`value` is required" });

      const emptyValue = await call(
        "PUT",
        "/api/secrets/inventory/OPENAI_API_KEY",
        { body: { value: "" } },
      );
      expect(emptyValue.body).toEqual({ error: "`value` is required" });

      const badLabel = await call(
        "PUT",
        "/api/secrets/inventory/OPENAI_API_KEY",
        {
          body: { value: "sk", label: 1 },
        },
      );
      expect(badLabel.body).toEqual({
        error: "`label` must be string when set",
      });

      const badProvider = await call(
        "PUT",
        "/api/secrets/inventory/OPENAI_API_KEY",
        { body: { value: "sk", providerId: 1 } },
      );
      expect(badProvider.body).toEqual({
        error: "`providerId` must be string when set",
      });

      const badCategory = await call(
        "PUT",
        "/api/secrets/inventory/OPENAI_API_KEY",
        { body: { value: "sk", category: "nope" } },
      );
      expect(badCategory.body).toEqual({
        error: "`category` must be a known VaultEntryCategory",
      });

      const written = await call(
        "PUT",
        "/api/secrets/inventory/OPENAI_API_KEY",
        {
          body: {
            value: "sk-put",
            label: "OpenAI",
            providerId: "openai",
            category: "provider",
          },
        },
      );
      expect(written.body).toEqual({ ok: true });

      const revealed = await call(
        "GET",
        "/api/secrets/inventory/OPENAI_API_KEY",
      );
      expect(revealed.body).toEqual({
        ok: true,
        value: "sk-put",
        source: "bare",
      });

      const listed = await call("GET", "/api/secrets/inventory", {
        url: "/api/secrets/inventory?category=provider",
      });
      const listedBody = listed.body as {
        entries: Array<{ label: string; providerId?: string }>;
      };
      expect(listedBody.entries[0]?.label).toBe("OpenAI");
      expect(listedBody.entries[0]?.providerId).toBe("openai");
    });

    it("PUT with only a value does not require meta fields", async () => {
      const written = await call("PUT", "/api/secrets/inventory/CUSTOM_TOKEN", {
        body: { value: "tok" },
      });
      expect(written.body).toEqual({ ok: true });
      const revealed = await call("GET", "/api/secrets/inventory/CUSTOM_TOKEN");
      expect(revealed.body).toEqual({
        ok: true,
        value: "tok",
        source: "bare",
      });
    });

    it("DELETE removes a missing key, a present key, and every profile child", async () => {
      const missing = await call(
        "DELETE",
        "/api/secrets/inventory/OPENAI_API_KEY",
      );
      expect(missing).toEqual({
        handled: true,
        status: 200,
        body: { ok: true },
      });

      await call("PUT", "/api/secrets/inventory/OPENAI_API_KEY", {
        body: { value: "sk-bare" },
      });
      await call("POST", "/api/secrets/inventory/OPENAI_API_KEY/profiles", {
        body: { id: "work", value: "sk-work" },
      });
      await call("POST", "/api/secrets/inventory/OPENAI_API_KEY/profiles", {
        body: { id: "home", value: "sk-home" },
      });

      const deleted = await call(
        "DELETE",
        "/api/secrets/inventory/OPENAI_API_KEY",
      );
      expect(deleted.body).toEqual({ ok: true });
      expect(await testVault.vault.has("OPENAI_API_KEY")).toBe(false);
      expect(
        await testVault.vault.has(profileStorageKey("OPENAI_API_KEY", "work")),
      ).toBe(false);
      expect(
        await testVault.vault.has(profileStorageKey("OPENAI_API_KEY", "home")),
      ).toBe(false);

      const listed = await call("GET", "/api/secrets/inventory");
      const listedBody = listed.body as { entries: unknown[] };
      expect(listedBody.entries).toEqual([]);
    });

    it("rejects unsupported methods on a key", async () => {
      const result = await call(
        "PATCH",
        "/api/secrets/inventory/OPENAI_API_KEY",
      );
      expect(result.status).toBe(405);
      expect(result.body).toEqual({ error: "method not allowed" });
    });
  });

  describe("GET/POST /api/secrets/inventory/:key/profiles", () => {
    it("GET returns an empty profile list when no meta exists", async () => {
      const result = await call(
        "GET",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles",
      );
      expect(result.body).toEqual({
        ok: true,
        profiles: [],
        activeProfile: null,
      });
    });

    it("POST rejects invalid id/value and duplicate ids, and defaults an empty label to the id", async () => {
      const badId = await call(
        "POST",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles",
        { body: { id: "bad.id", value: "sk" } },
      );
      expect(badId.body).toEqual({ error: "`id` must match [A-Za-z0-9_-]+" });

      const missingValue = await call(
        "POST",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles",
        { body: { id: "work" } },
      );
      expect(missingValue.body).toEqual({ error: "`value` is required" });

      const emptyValue = await call(
        "POST",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles",
        { body: { id: "work", value: "" } },
      );
      expect(emptyValue.body).toEqual({ error: "`value` is required" });

      const invalidJson = await call(
        "POST",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles",
        { body: "{" },
      );
      expect(invalidJson.body).toEqual({ error: "invalid JSON body" });

      const created = await call(
        "POST",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles",
        { body: { id: "work", label: "", value: "sk-work" } },
      );
      expect(created.body).toEqual({ ok: true });

      const listed = await call(
        "GET",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles",
      );
      const listedBody = listed.body as {
        activeProfile: string | null;
        profiles: Array<{ id: string; label: string; createdAt?: number }>;
      };
      expect(listedBody.activeProfile).toBe("work");
      expect(listedBody.profiles).toHaveLength(1);
      expect(listedBody.profiles[0]?.id).toBe("work");
      expect(listedBody.profiles[0]?.label).toBe("work");
      expect(listedBody.profiles[0]?.createdAt).toEqual(expect.any(Number));

      const duplicate = await call(
        "POST",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles",
        { body: { id: "work", value: "sk-other" } },
      );
      expect(duplicate.status).toBe(409);
      expect(duplicate.body).toEqual({ error: "profile id already exists" });
    });

    it("POST preserves an existing active profile when adding a second one", async () => {
      await call("POST", "/api/secrets/inventory/OPENAI_API_KEY/profiles", {
        body: { id: "work", label: "Work", value: "sk-work" },
      });
      await call("POST", "/api/secrets/inventory/OPENAI_API_KEY/profiles", {
        body: { id: "home", label: "Home", value: "sk-home" },
      });

      const listed = await call(
        "GET",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles",
      );
      const listedBody = listed.body as {
        activeProfile: string | null;
        profiles: Array<{ id: string }>;
      };
      expect(listedBody.activeProfile).toBe("work");
      expect(listedBody.profiles.map((profile) => profile.id)).toEqual([
        "work",
        "home",
      ]);
    });

    it("rejects unsupported methods on the profiles collection", async () => {
      const result = await call(
        "PUT",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles",
      );
      expect(result.status).toBe(405);
    });
  });

  describe("PATCH/DELETE /api/secrets/inventory/:key/profiles/:id", () => {
    it("rejects an invalid profileId and a malformed encoded profileId", async () => {
      const dotted = await call(
        "PATCH",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles/bad.id",
      );
      expect(dotted.status).toBe(400);
      expect(dotted.body).toEqual({ error: "invalid `profileId`" });

      const malformed = await call(
        "PATCH",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles/%ZZ",
      );
      expect(malformed.status).toBe(400);
      expect(malformed.body).toEqual({
        error: "invalid profileId: malformed URL encoding",
      });
    });

    it("PATCH validates the body and 404s a missing profile", async () => {
      const invalidJson = await call(
        "PATCH",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles/work",
        { body: "{" },
      );
      expect(invalidJson.body).toEqual({ error: "invalid JSON body" });

      const badLabel = await call(
        "PATCH",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles/work",
        { body: { label: 1 } },
      );
      expect(badLabel.body).toEqual({
        error: "`label` must be string when set",
      });

      const emptyValue = await call(
        "PATCH",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles/work",
        { body: { value: "" } },
      );
      expect(emptyValue.body).toEqual({
        error: "`value` must be a non-empty string when set",
      });

      const missing = await call(
        "PATCH",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles/work",
        { body: { label: "Work" } },
      );
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ error: "no such profile" });
    });

    it("PATCH updates label, value, or neither, and GET reflects the new value", async () => {
      await call("POST", "/api/secrets/inventory/OPENAI_API_KEY/profiles", {
        body: { id: "work", label: "Work", value: "sk-work" },
      });

      const noop = await call(
        "PATCH",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles/work",
        { body: {} },
      );
      expect(noop.body).toEqual({ ok: true });

      const relabel = await call(
        "PATCH",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles/work",
        { body: { label: "Office" } },
      );
      expect(relabel.body).toEqual({ ok: true });

      const revalue = await call(
        "PATCH",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles/work",
        { body: { value: "sk-office" } },
      );
      expect(revalue.body).toEqual({ ok: true });

      const listed = await call(
        "GET",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles",
      );
      const listedBody = listed.body as { profiles: Array<{ label: string }> };
      expect(listedBody.profiles[0]?.label).toBe("Office");

      const revealed = await call(
        "GET",
        "/api/secrets/inventory/OPENAI_API_KEY",
      );
      expect(revealed.body).toEqual({
        ok: true,
        value: "sk-office",
        source: "profile",
        profileId: "work",
      });
    });

    it("DELETE 404s a missing profile and rejects unsupported methods", async () => {
      const missing = await call(
        "DELETE",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles/work",
      );
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ error: "no such profile" });

      const method = await call(
        "GET",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles/work",
      );
      expect(method.status).toBe(405);
    });

    it("DELETE of the active profile promotes the first remaining one", async () => {
      await call("POST", "/api/secrets/inventory/OPENAI_API_KEY/profiles", {
        body: { id: "work", value: "sk-work" },
      });
      await call("POST", "/api/secrets/inventory/OPENAI_API_KEY/profiles", {
        body: { id: "home", value: "sk-home" },
      });
      await call("POST", "/api/secrets/inventory/OPENAI_API_KEY/profiles", {
        body: { id: "lab", value: "sk-lab" },
      });

      const deleted = await call(
        "DELETE",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles/work",
      );
      expect(deleted.body).toEqual({ ok: true });
      expect(
        await testVault.vault.has(profileStorageKey("OPENAI_API_KEY", "work")),
      ).toBe(false);

      const listed = await call(
        "GET",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles",
      );
      expect(listed.body).toEqual({
        ok: true,
        activeProfile: "home",
        profiles: [
          expect.objectContaining({ id: "home" }),
          expect.objectContaining({ id: "lab" }),
        ],
      });
    });

    it("DELETE of a non-active profile preserves the active pointer", async () => {
      await call("POST", "/api/secrets/inventory/OPENAI_API_KEY/profiles", {
        body: { id: "work", value: "sk-work" },
      });
      await call("POST", "/api/secrets/inventory/OPENAI_API_KEY/profiles", {
        body: { id: "home", value: "sk-home" },
      });

      await call(
        "DELETE",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles/home",
      );
      const listed = await call(
        "GET",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles",
      );
      const listedBody = listed.body as { activeProfile: string | null };
      expect(listedBody.activeProfile).toBe("work");
    });

    it("DELETE of the last profile clears profiles and the active pointer", async () => {
      await call("POST", "/api/secrets/inventory/OPENAI_API_KEY/profiles", {
        body: { id: "work", value: "sk-work" },
      });
      await call(
        "DELETE",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles/work",
      );

      const listed = await call(
        "GET",
        "/api/secrets/inventory/OPENAI_API_KEY/profiles",
      );
      expect(listed.body).toEqual({
        ok: true,
        profiles: [],
        activeProfile: null,
      });
    });
  });

  describe("PUT /api/secrets/inventory/:key/active-profile", () => {
    it("rejects non-PUT methods, invalid JSON, and a missing/invalid profileId", async () => {
      const method = await call(
        "GET",
        "/api/secrets/inventory/OPENAI_API_KEY/active-profile",
      );
      expect(method.status).toBe(405);

      const invalidJson = await call(
        "PUT",
        "/api/secrets/inventory/OPENAI_API_KEY/active-profile",
        { body: "{" },
      );
      expect(invalidJson.body).toEqual({ error: "invalid JSON body" });

      const missing = await call(
        "PUT",
        "/api/secrets/inventory/OPENAI_API_KEY/active-profile",
        { body: {} },
      );
      expect(missing.body).toEqual({ error: "`profileId` is required" });

      const badId = await call(
        "PUT",
        "/api/secrets/inventory/OPENAI_API_KEY/active-profile",
        { body: { profileId: "bad.id" } },
      );
      expect(badId.body).toEqual({ error: "`profileId` is required" });
    });

    it("404s a profile id that is not on the key, then switches the active profile", async () => {
      await call("POST", "/api/secrets/inventory/OPENAI_API_KEY/profiles", {
        body: { id: "work", value: "sk-work" },
      });
      await call("POST", "/api/secrets/inventory/OPENAI_API_KEY/profiles", {
        body: { id: "home", value: "sk-home" },
      });

      const missing = await call(
        "PUT",
        "/api/secrets/inventory/OPENAI_API_KEY/active-profile",
        { body: { profileId: "lab" } },
      );
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ error: "profile id not found for key" });

      const switched = await call(
        "PUT",
        "/api/secrets/inventory/OPENAI_API_KEY/active-profile",
        { body: { profileId: "home" } },
      );
      expect(switched.body).toEqual({ ok: true });

      const revealed = await call(
        "GET",
        "/api/secrets/inventory/OPENAI_API_KEY",
      );
      expect(revealed.body).toEqual({
        ok: true,
        value: "sk-home",
        source: "profile",
        profileId: "home",
      });
    });
  });
});
