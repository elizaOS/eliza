/** Exercises malformed secret-inventory key and profile paths with mocked vault/auth boundaries. */
import * as http from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

const vaultMocks = vi.hoisted(() => ({
  listVaultInventory: vi.fn(async () => []),
  readRoutingConfig: vi.fn(async () => ({})),
  readEntryMeta: vi.fn(async () => null),
  has: vi.fn(async () => false),
  reveal: vi.fn(),
  listConnectorSecretFindings: vi.fn(() => [
    {
      id: "config:telegram.botToken",
      connector: "telegram",
      label: "telegram botToken",
      source: "eliza-config",
      protection: "mode-0600",
      autoMigratesOnDesktop: true,
      detail: "Protected fallback; no value returned.",
    },
  ]),
}));

vi.mock("@elizaos/agent/config/config", () => ({
  loadElizaConfig: () => ({ connectors: { telegram: { botToken: "secret" } } }),
}));

vi.mock("@elizaos/agent/config/paths", () => ({
  resolveStateDir: () => "/tmp/example-state",
}));

vi.mock("@elizaos/vault", () => ({
  listVaultInventory: vaultMocks.listVaultInventory,
  profileStorageKey: (key: string, profileId: string) =>
    `${key}.profile.${profileId}`,
  ROUTING_KEY: "_routing",
  readEntryMeta: vaultMocks.readEntryMeta,
  readRoutingConfig: vaultMocks.readRoutingConfig,
  removeEntryMeta: vi.fn(),
  setEntryMeta: vi.fn(),
  writeRoutingConfig: vi.fn(),
}));

vi.mock("../services/vault-mirror", () => ({
  sharedVault: () => ({
    has: vaultMocks.has,
    reveal: vaultMocks.reveal,
  }),
}));

vi.mock("../services/connector-secret-inventory", () => ({
  listConnectorSecretFindings: vaultMocks.listConnectorSecretFindings,
}));

vi.mock("./auth.ts", () => ({
  ensureRouteMinRole: vi.fn(async () => true),
  ensureCompatSensitiveRouteAuthorized: vi.fn(() => true),
}));

import { handleSecretsInventoryRoute } from "./secrets-inventory-routes";

function fakeRes(): {
  res: http.ServerResponse;
  body: () => unknown;
  status: () => number;
} {
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
    res,
    body: () => (bodyText ? JSON.parse(bodyText) : null),
    status: () => res.statusCode,
  };
}

function req(method: string, pathname: string): http.IncomingMessage {
  const incoming = new http.IncomingMessage(new Socket());
  incoming.method = method;
  incoming.url = pathname;
  incoming.headers = { host: "127.0.0.1" };
  return incoming;
}

const STATE = { current: null };

describe("GET /api/secrets/inventory/:key encoding", () => {
  beforeEach(() => {
    vaultMocks.listVaultInventory.mockClear();
    vaultMocks.readRoutingConfig.mockClear();
    vaultMocks.readEntryMeta.mockClear();
    vaultMocks.has.mockClear();
  });

  it("GET /api/secrets/inventory list is untouched", async () => {
    const res = fakeRes();
    const handled = await handleSecretsInventoryRoute(
      req("GET", "/api/secrets/inventory"),
      res.res,
      "/api/secrets/inventory",
      "GET",
      STATE,
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    expect(res.body()).toEqual({
      ok: true,
      entries: [],
      securityFindings: [
        expect.objectContaining({
          id: "config:telegram.botToken",
          protection: "mode-0600",
        }),
      ],
    });
    expect(JSON.stringify(res.body())).not.toContain('secret"');
    expect(vaultMocks.listVaultInventory).toHaveBeenCalled();
    expect(vaultMocks.readEntryMeta).not.toHaveBeenCalled();
  });

  it("GET /api/secrets/routing is untouched", async () => {
    const res = fakeRes();
    const handled = await handleSecretsInventoryRoute(
      req("GET", "/api/secrets/routing"),
      res.res,
      "/api/secrets/routing",
      "GET",
      STATE,
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    expect(vaultMocks.readRoutingConfig).toHaveBeenCalled();
    expect(vaultMocks.readEntryMeta).not.toHaveBeenCalled();
  });

  it("canonical percent-encoded key still reaches vault lookup", async () => {
    vaultMocks.has.mockResolvedValueOnce(false);
    const res = fakeRes();
    await handleSecretsInventoryRoute(
      req("GET", "/api/secrets/inventory/OPENAI%5FAPI%5FKEY"),
      res.res,
      "/api/secrets/inventory/OPENAI%5FAPI%5FKEY",
      "GET",
      STATE,
    );
    expect(vaultMocks.readEntryMeta).toHaveBeenCalledWith(
      expect.anything(),
      "OPENAI_API_KEY",
    );
    expect(vaultMocks.has).toHaveBeenCalledWith("OPENAI_API_KEY");
  });

  it.each([
    "/api/secrets/inventory/%",
    "/api/secrets/inventory/%2",
    "/api/secrets/inventory/%ZZ",
    "/api/secrets/inventory/%E0%A4/profiles",
  ])("rejects malformed %s with 400", async (pathname) => {
    const res = fakeRes();
    const handled = await handleSecretsInventoryRoute(
      req("GET", pathname),
      res.res,
      pathname,
      "GET",
      STATE,
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(400);
    expect(res.body()).toEqual({
      error: expect.stringContaining("malformed URL encoding"),
    });
    expect(vaultMocks.readEntryMeta).not.toHaveBeenCalled();
    expect(vaultMocks.has).not.toHaveBeenCalled();
  });
});
