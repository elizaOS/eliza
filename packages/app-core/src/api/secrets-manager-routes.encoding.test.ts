/** Exercises malformed saved-login paths without loading the real vault or OWNER gate. */
import * as http from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

const vaultMocks = vi.hoisted(() => ({
  getAutofillAllowed: vi.fn(async () => false),
  getSavedLogin: vi.fn(async () => null),
  deleteSavedLogin: vi.fn(async () => undefined),
  setSavedLogin: vi.fn(async () => undefined),
  createManager: vi.fn(),
}));

const secureStoreMocks = vi.hoisted(() => ({
  protection: {
    backend: "macos_keychain" as const,
    available: true,
    synchronized: false as const,
    scope: "device" as const,
    access: "app_only" as const,
  },
}));

vi.mock("@elizaos/vault", () => ({
  createManager: vaultMocks.createManager,
  deleteSavedLogin: vaultMocks.deleteSavedLogin,
  getAutofillAllowed: vaultMocks.getAutofillAllowed,
  getSavedLogin: vaultMocks.getSavedLogin,
  resolveRunnableMethods: vi.fn(() => []),
  setAutofillAllowed: vi.fn(),
  setSavedLogin: vaultMocks.setSavedLogin,
}));

vi.mock("../services/vault-mirror", () => ({
  sharedVault: () => ({}),
}));

vi.mock("../services/secrets-manager-installer", () => ({
  _resetSecretsManagerInstallerForTesting: vi.fn(),
  getSecretsManagerInstaller: vi.fn(),
}));

vi.mock("../security/platform-secure-store-node", () => ({
  createNodePlatformSecureStore: vi.fn(() => ({})),
  describeNodePlatformSecureStore: vi.fn(
    async () => secureStoreMocks.protection,
  ),
}));

vi.mock("./auth.ts", () => ({
  ensureRouteMinRole: vi.fn(async () => true),
  ensureCompatSensitiveRouteAuthorized: vi.fn(() => true),
}));

import {
  _setSecretsManagerForTesting,
  handleSecretsManagerRoute,
} from "./secrets-manager-routes";

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

describe("GET/DELETE /api/secrets/logins/:domain encoding", () => {
  beforeEach(() => {
    vaultMocks.getAutofillAllowed.mockClear();
    vaultMocks.getSavedLogin.mockClear();
    vaultMocks.deleteSavedLogin.mockClear();
    _setSecretsManagerForTesting({
      listAllSavedLogins: async () => ({ logins: [], failures: [] }),
    } as never);
  });

  it("GET /api/secrets/logins list is untouched", async () => {
    const res = fakeRes();
    const handled = await handleSecretsManagerRoute(
      req("GET", "/api/secrets/logins"),
      res.res,
      "/api/secrets/logins",
      "GET",
      STATE,
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    expect(res.body()).toEqual({ ok: true, logins: [], failures: [] });
    expect(vaultMocks.getAutofillAllowed).not.toHaveBeenCalled();
    expect(vaultMocks.getSavedLogin).not.toHaveBeenCalled();
  });

  it("canonical percent-encoded domain still reaches autofill lookup", async () => {
    vaultMocks.getAutofillAllowed.mockResolvedValueOnce(true);
    const res = fakeRes();
    await handleSecretsManagerRoute(
      req("GET", "/api/secrets/logins/example%2Ecom/autoallow"),
      res.res,
      "/api/secrets/logins/example%2Ecom/autoallow",
      "GET",
      STATE,
    );
    expect(vaultMocks.getAutofillAllowed).toHaveBeenCalledWith(
      {},
      "example.com",
    );
    expect(res.status()).toBe(200);
  });

  it.each([
    ["/api/secrets/logins/%/autoallow", "GET"],
    ["/api/secrets/logins/%2/autoallow", "GET"],
    ["/api/secrets/logins/%ZZ/autoallow", "GET"],
    ["/api/secrets/logins/%E0%A4/user", "DELETE"],
  ])("rejects malformed %s with 400", async (pathname, method) => {
    const res = fakeRes();
    const handled = await handleSecretsManagerRoute(
      req(method, pathname),
      res.res,
      pathname,
      method,
      STATE,
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(400);
    expect(res.body()).toEqual({
      error: expect.stringContaining("malformed URL encoding"),
    });
    expect(vaultMocks.getAutofillAllowed).not.toHaveBeenCalled();
    expect(vaultMocks.getSavedLogin).not.toHaveBeenCalled();
    expect(vaultMocks.deleteSavedLogin).not.toHaveBeenCalled();
  });
});

describe("GET /api/secrets/manager/protection", () => {
  beforeEach(() => {
    _setSecretsManagerForTesting({} as never);
  });

  it("reports the local, connector, Apple, and Cloud trust boundaries", async () => {
    const res = fakeRes();
    const handled = await handleSecretsManagerRoute(
      req("GET", "/api/secrets/manager/protection"),
      res.res,
      "/api/secrets/manager/protection",
      "GET",
      STATE,
    );

    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    expect(res.body()).toEqual({
      ok: true,
      protection: {
        localVault: {
          encryptedAtRest: true,
          cipher: "AES-256-GCM",
          masterKey: secureStoreMocks.protection,
        },
        nativeSessionState: {
          policy: "platform-protected-store",
          synchronized: false,
          plaintextFallback: false,
        },
        connectorSessions: {
          telegramPersonal: "vault-master-key-encrypted",
        },
        cloudTrustDomain: "separate-organization-kms",
      },
    });
  });
});
