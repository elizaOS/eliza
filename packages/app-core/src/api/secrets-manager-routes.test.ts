/**
 * Unit tests for `handleSecretsManagerRoute` and its exported test hooks.
 * Drives the real handler with synthetic Node `IncomingMessage` /
 * `ServerResponse` objects against an isolated `createTestVault` so prefix
 * gating, OWNER short-circuit, preference read/write, install-method
 * matching, SSE job lookup, vendor sign-in/out mapping, and saved-login
 * list/reveal/CRUD plus autofill toggles run as written. Host package-manager
 * detection is stubbed only for POST `/install` matching; GET `/install/methods`
 * uses the live resolver.
 */
import * as http from "node:http";
import { Socket } from "node:net";
import {
  createManager,
  createTestVault,
  DEFAULT_PREFERENCES,
  type InstallMethod,
  type SecretsManager,
  type TestVault,
} from "@elizaos/vault";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InstallJobEvent,
  SecretsManagerInstaller,
  SigninRequest,
  SigninResult,
} from "../services/secrets-manager-installer";
import { _setSecretsManagerInstallerForTesting } from "../services/secrets-manager-installer";
import { _resetSharedVaultForTesting } from "../services/vault-mirror";
import type { CompatStateLike } from "./auth.ts";
import {
  _resetSecretsManagerForTesting,
  _setSecretsManagerForTesting,
  handleSecretsManagerRoute,
} from "./secrets-manager-routes";

const vaultMocks = vi.hoisted(() => ({
  resolveRunnableMethods: vi.fn(),
}));

vi.mock("@elizaos/vault", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/vault")>();
  vaultMocks.resolveRunnableMethods.mockImplementation(
    actual.resolveRunnableMethods,
  );
  return {
    ...actual,
    resolveRunnableMethods: vaultMocks.resolveRunnableMethods,
  };
});

const authMocks = vi.hoisted(() => ({
  ensureRouteMinRole: vi.fn(async () => true),
}));

vi.mock("./auth.ts", () => ({
  ensureRouteMinRole: authMocks.ensureRouteMinRole,
}));

const STATE: CompatStateLike = { current: null };
const JOB_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const BREW_METHOD: InstallMethod = {
  kind: "brew",
  package: "1password-cli",
  cask: true,
};
const NPM_METHOD: InstallMethod = {
  kind: "npm",
  package: "@bitwarden/cli",
};

interface FakeRes {
  body(): unknown;
  header(name: string): string | number | readonly string[] | undefined;
  raw(): string;
  res: http.ServerResponse;
  status(): number;
}

interface RecordedInstall {
  backendId: string;
  method: InstallMethod;
}

function fakeRes(): FakeRes {
  let bodyText = "";
  let writeHeadStatus: number | undefined;
  const headers = new Map<string, string | number | readonly string[]>();
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  const originalSetHeader = res.setHeader.bind(res);
  res.setHeader = ((
    name: string,
    value: string | number | readonly string[],
  ) => {
    headers.set(name.toLowerCase(), Array.isArray(value) ? [...value] : value);
    return originalSetHeader(name, value);
  }) as typeof res.setHeader;
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = ((
    status: number,
    hdrs?: http.OutgoingHttpHeaders | http.OutgoingHttpHeader[],
  ) => {
    writeHeadStatus = status;
    if (hdrs && !Array.isArray(hdrs)) {
      for (const [name, value] of Object.entries(hdrs)) {
        if (value !== undefined) {
          headers.set(
            name.toLowerCase(),
            Array.isArray(value) ? [...value] : value,
          );
        }
      }
    }
    return originalWriteHead(status, hdrs as http.OutgoingHttpHeaders);
  }) as typeof res.writeHead;
  const originalWrite = res.write.bind(res);
  res.write = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
    if (typeof chunk === "string") bodyText += chunk;
    else if (chunk)
      bodyText += Buffer.from(chunk as Uint8Array).toString("utf8");
    return originalWrite(
      chunk as string,
      encoding as BufferEncoding,
      cb as () => void,
    );
  }) as typeof res.write;
  const originalEnd = res.end.bind(res);
  res.end = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
    if (typeof chunk === "string") bodyText += chunk;
    else if (chunk && typeof chunk !== "function") {
      bodyText += Buffer.from(chunk as Uint8Array).toString("utf8");
    }
    return originalEnd(
      chunk as string,
      encoding as BufferEncoding,
      cb as () => void,
    );
  }) as typeof res.end;
  return {
    body() {
      return bodyText.length > 0 ? JSON.parse(bodyText) : null;
    },
    header(name: string) {
      return headers.get(name.toLowerCase());
    },
    raw() {
      return bodyText;
    },
    res,
    status() {
      return writeHeadStatus ?? res.statusCode;
    },
  };
}

function fakeReq(
  method: string,
  pathname: string,
  options: { body?: string; url?: string } = {},
): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = method;
  req.url = options.url ?? pathname;
  req.headers = { host: "127.0.0.1" };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  req.push(options.body ?? "");
  req.push(null);
  return req;
}

async function invoke(
  method: string,
  pathname: string,
  options: { body?: unknown; url?: string } = {},
): Promise<{
  handled: boolean;
  req: http.IncomingMessage;
  res: FakeRes;
}> {
  const rawBody =
    options.body === undefined
      ? ""
      : typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);
  const res = fakeRes();
  const req = fakeReq(method, pathname, {
    body: rawBody,
    ...(options.url !== undefined ? { url: options.url } : {}),
  });
  const handled = await handleSecretsManagerRoute(
    req,
    res.res,
    pathname,
    method,
    STATE,
  );
  return { handled, req, res };
}

function inHouseLogins(body: unknown): unknown[] {
  const parsed = body as { logins?: Array<{ source: string }> };
  return (parsed.logins ?? []).filter((entry) => entry.source === "in-house");
}

function createFakeInstaller(): SecretsManagerInstaller & {
  lastSignIn: SigninRequest | null;
  lastSignOut: string | null;
  lastStart: RecordedInstall | null;
  signInImpl: (request: SigninRequest) => Promise<SigninResult>;
  sseEvents: InstallJobEvent[];
} {
  const jobs = new Set<string>([JOB_ID]);
  const fake = {
    lastSignIn: null as SigninRequest | null,
    lastSignOut: null as string | null,
    lastStart: null as RecordedInstall | null,
    sseEvents: [] as InstallJobEvent[],
    signInImpl: async (request: SigninRequest): Promise<SigninResult> => ({
      backendId: request.backendId,
      sessionStored: true,
      message: `signed-in:${request.backendId}`,
    }),
    startInstall(backendId: string, method: InstallMethod) {
      fake.lastStart = { backendId, method };
      jobs.add(JOB_ID);
      return { id: JOB_ID };
    },
    getJob(jobId: string) {
      if (!jobs.has(jobId)) return null;
      return { id: jobId };
    },
    subscribeJob(jobId: string, listener: (event: InstallJobEvent) => void) {
      if (!jobs.has(jobId)) throw new Error(`unknown install job: ${jobId}`);
      for (const event of fake.sseEvents) listener(event);
      return () => undefined;
    },
    async signIn(request: SigninRequest) {
      fake.lastSignIn = request;
      return fake.signInImpl(request);
    },
    async signOut(backendId: string) {
      fake.lastSignOut = backendId;
    },
  };
  return fake as SecretsManagerInstaller & typeof fake;
}

describe("handleSecretsManagerRoute", () => {
  const vaults: TestVault[] = [];
  let installer: ReturnType<typeof createFakeInstaller>;
  let manager: SecretsManager;

  async function bindIsolatedManager(): Promise<void> {
    const test = await createTestVault();
    vaults.push(test);
    _resetSharedVaultForTesting(test.vault);
    manager = createManager({
      vault: test.vault,
      exec: async () => ({ stdout: "[]", stderr: "" }),
    });
    _setSecretsManagerForTesting(manager);
    installer = createFakeInstaller();
    _setSecretsManagerInstallerForTesting(installer);
  }

  beforeEach(async () => {
    authMocks.ensureRouteMinRole.mockReset();
    authMocks.ensureRouteMinRole.mockResolvedValue(true);
    const actual =
      await vi.importActual<typeof import("@elizaos/vault")>("@elizaos/vault");
    vaultMocks.resolveRunnableMethods.mockReset();
    vaultMocks.resolveRunnableMethods.mockImplementation(
      actual.resolveRunnableMethods,
    );
    await bindIsolatedManager();
  });

  afterEach(async () => {
    _resetSecretsManagerForTesting();
    _resetSharedVaultForTesting();
    _setSecretsManagerInstallerForTesting(null);
    await Promise.all(vaults.splice(0).map((test) => test.dispose()));
  });

  describe("dispatch", () => {
    it("returns false for paths outside the secrets prefixes without consulting auth", async () => {
      const { handled, res } = await invoke("GET", "/api/other");
      expect(handled).toBe(false);
      expect(authMocks.ensureRouteMinRole).not.toHaveBeenCalled();
      expect(res.status()).toBe(200);
      expect(res.body()).toBeNull();
    });

    it("returns true without running secrets logic when the OWNER gate fails", async () => {
      authMocks.ensureRouteMinRole.mockResolvedValueOnce(false);
      const { handled, res } = await invoke(
        "GET",
        "/api/secrets/manager/backends",
      );
      expect(handled).toBe(true);
      expect(res.body()).toBeNull();
    });

    it("returns false for an unmatched manager path after the OWNER gate", async () => {
      const { handled, res } = await invoke(
        "GET",
        "/api/secrets/manager/not-a-route",
      );
      expect(handled).toBe(false);
      expect(authMocks.ensureRouteMinRole).toHaveBeenCalledOnce();
      expect(res.body()).toBeNull();
    });

    it("returns false for an unmatched saved-logins path after the OWNER gate", async () => {
      const { handled } = await invoke(
        "PATCH",
        "/api/secrets/logins/example.com/unused",
      );
      expect(handled).toBe(false);
    });
  });

  describe("exported test hooks", () => {
    it("swaps the cached manager and recreates one from the shared vault on reset", async () => {
      _setSecretsManagerForTesting({
        detectBackends: async () => [
          {
            id: "in-house",
            label: "sentinel-manager",
            available: true,
            signedIn: true,
          },
        ],
      } as never);
      installer = createFakeInstaller();
      _setSecretsManagerInstallerForTesting(installer);

      const sentinel = await invoke("GET", "/api/secrets/manager/backends");
      expect(sentinel.res.body()).toEqual({
        ok: true,
        backends: [
          {
            id: "in-house",
            label: "sentinel-manager",
            available: true,
            signedIn: true,
          },
        ],
      });

      _resetSecretsManagerForTesting();
      const afterReset = await invoke("GET", "/api/secrets/manager/backends");
      const body = afterReset.res.body() as {
        backends: Array<{ id: string; label: string }>;
      };
      expect(afterReset.handled).toBe(true);
      expect(body.backends.map((entry) => entry.id)).toEqual([
        "in-house",
        "1password",
        "protonpass",
        "bitwarden",
      ]);
      expect(body.backends[0]?.label).toBe("Eliza (local, encrypted)");
    });
  });

  describe("GET /api/secrets/manager/backends", () => {
    it("returns the four backends with in-house always available", async () => {
      const { handled, res } = await invoke(
        "GET",
        "/api/secrets/manager/backends",
      );
      expect(handled).toBe(true);
      expect(res.status()).toBe(200);
      const body = res.body() as {
        ok: boolean;
        backends: Array<{
          id: string;
          available: boolean;
          signedIn?: boolean;
        }>;
      };
      expect(body.ok).toBe(true);
      expect(body.backends.map((entry) => entry.id)).toEqual([
        "in-house",
        "1password",
        "protonpass",
        "bitwarden",
      ]);
      expect(body.backends[0]).toEqual({
        id: "in-house",
        label: "Eliza (local, encrypted)",
        available: true,
        signedIn: true,
      });
    });
  });

  describe("GET /api/secrets/manager/protection", () => {
    it("reports the local, connector, native, and Cloud trust boundaries", async () => {
      const { handled, res } = await invoke(
        "GET",
        "/api/secrets/manager/protection",
      );
      expect(handled).toBe(true);
      expect(res.status()).toBe(200);
      const body = res.body() as {
        ok: boolean;
        protection: {
          localVault: {
            encryptedAtRest: boolean;
            cipher: string;
            masterKey: { backend: string; available: boolean };
          };
          nativeSessionState: unknown;
          connectorSessions: unknown;
          cloudTrustDomain: string;
        };
      };
      expect(body.ok).toBe(true);
      expect(body.protection.localVault.encryptedAtRest).toBe(true);
      expect(body.protection.localVault.cipher).toBe("AES-256-GCM");
      expect(body.protection.localVault.masterKey.backend).toEqual(
        expect.any(String),
      );
      expect(body.protection.nativeSessionState).toEqual({
        policy: "platform-protected-store",
        synchronized: false,
        plaintextFallback: false,
      });
      expect(body.protection.connectorSessions).toEqual({
        telegramPersonal: "vault-master-key-encrypted",
      });
      expect(body.protection.cloudTrustDomain).toBe(
        "separate-organization-kms",
      );
    });
  });

  describe("preferences", () => {
    it("GET returns DEFAULT_PREFERENCES on an empty vault", async () => {
      const { res } = await invoke("GET", "/api/secrets/manager/preferences");
      expect(res.status()).toBe(200);
      expect(res.body()).toEqual({
        ok: true,
        preferences: DEFAULT_PREFERENCES,
      });
    });

    it("PUT rejects invalid JSON", async () => {
      const { handled, res } = await invoke(
        "PUT",
        "/api/secrets/manager/preferences",
        { body: "{" },
      );
      expect(handled).toBe(true);
      expect(res.status()).toBe(400);
      expect(res.body()).toEqual({ error: "invalid JSON body" });
    });

    it.each([{}, { preferences: null }, { preferences: "in-house" }])(
      "PUT rejects a missing preferences object (%j)",
      async (body) => {
        const { res } = await invoke(
          "PUT",
          "/api/secrets/manager/preferences",
          {
            body,
          },
        );
        expect(res.status()).toBe(400);
        expect(res.body()).toEqual({ error: "missing `preferences` field" });
      },
    );

    it("PUT persists preferences and GET reads the saved value", async () => {
      const put = await invoke("PUT", "/api/secrets/manager/preferences", {
        body: {
          preferences: {
            enabled: ["1password", "in-house"],
            routing: { "openrouter.apiKey": "1password" },
          },
        },
      });
      expect(put.res.status()).toBe(200);
      expect(put.res.body()).toEqual({
        ok: true,
        preferences: {
          enabled: ["1password", "in-house"],
          routing: { "openrouter.apiKey": "1password" },
        },
      });

      const get = await invoke("GET", "/api/secrets/manager/preferences");
      expect(get.res.body()).toEqual(put.res.body());
    });

    it("PUT normalizes an empty enabled list to in-house", async () => {
      const { res } = await invoke("PUT", "/api/secrets/manager/preferences", {
        body: { preferences: { enabled: [] } },
      });
      expect(res.status()).toBe(200);
      expect(res.body()).toEqual({
        ok: true,
        preferences: { enabled: ["in-house"] },
      });
    });
  });

  describe("install methods", () => {
    it("GET returns a per-backend array for every installable backend", async () => {
      const { handled, res } = await invoke(
        "GET",
        "/api/secrets/manager/install/methods",
      );
      expect(handled).toBe(true);
      expect(res.status()).toBe(200);
      const body = res.body() as {
        ok: boolean;
        methods: Record<string, InstallMethod[]>;
      };
      expect(body.ok).toBe(true);
      expect(Object.keys(body.methods).sort()).toEqual([
        "1password",
        "bitwarden",
        "protonpass",
      ]);
      for (const methods of Object.values(body.methods)) {
        expect(Array.isArray(methods)).toBe(true);
        for (const method of methods) {
          expect(["brew", "npm", "manual"]).toContain(method.kind);
        }
      }
    });
  });

  describe("POST /api/secrets/manager/install", () => {
    it("rejects invalid JSON", async () => {
      const { res } = await invoke("POST", "/api/secrets/manager/install", {
        body: "not-json",
      });
      expect(res.status()).toBe(400);
      expect(res.body()).toEqual({ error: "invalid JSON body" });
    });

    it("rejects a backend that is not installable", async () => {
      const { res } = await invoke("POST", "/api/secrets/manager/install", {
        body: {
          backendId: "in-house",
          method: BREW_METHOD,
        },
      });
      expect(res.status()).toBe(400);
      expect(res.body()).toEqual({
        error:
          "invalid `backendId`; expected one of 1password, bitwarden, protonpass",
      });
    });

    it.each([
      null,
      1,
      { kind: "unknown", package: "x" },
      { kind: "brew", package: "1password-cli" },
      { kind: "brew", package: "1password-cli", cask: "yes" },
      { kind: "npm" },
      { kind: "manual", url: "https://example.test" },
      { kind: "manual", instructions: "read the docs" },
    ])("rejects an invalid method payload (%j)", async (method) => {
      const { res } = await invoke("POST", "/api/secrets/manager/install", {
        body: { backendId: "1password", method },
      });
      expect(res.status()).toBe(400);
      expect(res.body()).toEqual({ error: "invalid `method` payload" });
    });

    it("rejects manual methods before looking up host availability", async () => {
      const { res } = await invoke("POST", "/api/secrets/manager/install", {
        body: {
          backendId: "1password",
          method: {
            kind: "manual",
            url: "https://developer.1password.com/docs/cli/get-started",
            instructions: "download the installer",
          },
        },
      });
      expect(res.status()).toBe(400);
      expect(res.body()).toEqual({
        error:
          "manual install methods cannot be automated; open the docs URL instead",
      });
      expect(installer.lastStart).toBeNull();
    });

    it("rejects a brew method whose cask flag does not match the host list", async () => {
      vaultMocks.resolveRunnableMethods.mockResolvedValue([BREW_METHOD]);
      const { res } = await invoke("POST", "/api/secrets/manager/install", {
        body: {
          backendId: "1password",
          method: { kind: "brew", package: "1password-cli", cask: false },
        },
      });
      expect(res.status()).toBe(400);
      expect(res.body()).toEqual({
        error:
          "install method brew:1password-cli is not available on this host",
      });
    });

    it("rejects an npm package that is not in the host list", async () => {
      vaultMocks.resolveRunnableMethods.mockResolvedValue([NPM_METHOD]);
      const { res } = await invoke("POST", "/api/secrets/manager/install", {
        body: {
          backendId: "bitwarden",
          method: { kind: "npm", package: "not-the-bitwarden-cli" },
        },
      });
      expect(res.status()).toBe(400);
      expect(res.body()).toEqual({
        error:
          "install method npm:not-the-bitwarden-cli is not available on this host",
      });
    });

    it("starts an install job when the method matches a host-runnable brew entry", async () => {
      vaultMocks.resolveRunnableMethods.mockResolvedValue([BREW_METHOD]);
      const { handled, res } = await invoke(
        "POST",
        "/api/secrets/manager/install",
        {
          body: { backendId: "1password", method: BREW_METHOD },
        },
      );
      expect(handled).toBe(true);
      expect(res.status()).toBe(202);
      expect(res.body()).toEqual({ ok: true, jobId: JOB_ID });
      expect(installer.lastStart).toEqual({
        backendId: "1password",
        method: BREW_METHOD,
      });
    });

    it("matches npm methods by package name only", async () => {
      vaultMocks.resolveRunnableMethods.mockResolvedValue([NPM_METHOD]);
      const { res } = await invoke("POST", "/api/secrets/manager/install", {
        body: { backendId: "bitwarden", method: NPM_METHOD },
      });
      expect(res.status()).toBe(202);
      expect(installer.lastStart?.method).toEqual(NPM_METHOD);
    });
  });

  describe("GET /api/secrets/manager/install/:jobId SSE", () => {
    it("returns 404 for an unknown job id that still matches the UUID shape", async () => {
      const unknown = "ffffffff-ffff-ffff-ffff-ffffffffffff";
      const { handled, res } = await invoke(
        "GET",
        `/api/secrets/manager/install/${unknown}`,
      );
      expect(handled).toBe(true);
      expect(res.status()).toBe(404);
      expect(res.body()).toEqual({ error: "unknown job id" });
    });

    it("returns false when the job-id segment is not 36 hex/dash characters", async () => {
      const { handled } = await invoke(
        "GET",
        "/api/secrets/manager/install/not-a-uuid",
      );
      expect(handled).toBe(false);
    });

    it("streams a terminal done event and closes the response", async () => {
      installer.sseEvents = [{ type: "done", exitCode: 0 }];
      const { handled, res } = await invoke(
        "GET",
        `/api/secrets/manager/install/${JOB_ID}`,
      );
      expect(handled).toBe(true);
      expect(res.status()).toBe(200);
      expect(res.header("content-type")).toBe("text/event-stream");
      expect(res.header("cache-control")).toBe("no-cache, no-transform");
      expect(res.header("connection")).toBe("keep-alive");
      expect(res.header("x-accel-buffering")).toBe("no");
      expect(res.raw()).toContain(
        `data: ${JSON.stringify({ type: "done", exitCode: 0 })}`,
      );
      expect(res.res.writableEnded).toBe(true);
    });

    it("streams a terminal error event and ignores a second write after close", async () => {
      installer.sseEvents = [
        { type: "error", message: "spawn failed" },
        { type: "error", message: "should-not-appear" },
      ];
      const { res } = await invoke(
        "GET",
        `/api/secrets/manager/install/${JOB_ID}`,
      );
      expect(res.raw()).toContain("spawn failed");
      expect(res.raw()).not.toContain("should-not-appear");
      expect(res.res.writableEnded).toBe(true);
    });

    it("unsubscribes when the client disconnects from a live stream", async () => {
      let unsubscribed = false;
      installer.sseEvents = [{ type: "log", stream: "stdout", line: "hello" }];
      installer.subscribeJob = ((_jobId, listener) => {
        listener({ type: "log", stream: "stdout", line: "hello" });
        return () => {
          unsubscribed = true;
        };
      }) as typeof installer.subscribeJob;
      const { req, res } = await invoke(
        "GET",
        `/api/secrets/manager/install/${JOB_ID}`,
      );
      expect(res.res.writableEnded).toBe(false);
      expect(res.raw()).toContain("hello");
      req.emit("close");
      expect(unsubscribed).toBe(true);
    });
  });

  describe("POST /api/secrets/manager/signin", () => {
    it("rejects invalid JSON", async () => {
      const { res } = await invoke("POST", "/api/secrets/manager/signin", {
        body: "{",
      });
      expect(res.status()).toBe(400);
      expect(res.body()).toEqual({ error: "invalid JSON body" });
    });

    it("rejects a non-installable backendId", async () => {
      const { res } = await invoke("POST", "/api/secrets/manager/signin", {
        body: { backendId: "in-house", masterPassword: "secret" },
      });
      expect(res.status()).toBe(400);
      expect(res.body()).toEqual({ error: "invalid `backendId`" });
    });

    it("rejects a missing masterPassword", async () => {
      const { res } = await invoke("POST", "/api/secrets/manager/signin", {
        body: { backendId: "1password" },
      });
      expect(res.status()).toBe(400);
      expect(res.body()).toEqual({ error: "missing `masterPassword`" });
    });

    it("rejects an empty masterPassword", async () => {
      const { res } = await invoke("POST", "/api/secrets/manager/signin", {
        body: { backendId: "bitwarden", masterPassword: "" },
      });
      expect(res.status()).toBe(400);
      expect(res.body()).toEqual({ error: "missing `masterPassword`" });
    });

    it("forwards only truthy optional fields and returns the installer result", async () => {
      const { res } = await invoke("POST", "/api/secrets/manager/signin", {
        body: {
          backendId: "1password",
          masterPassword: "hunter2",
          email: "owner@example.test",
          secretKey: "A3-XXXX",
          signInAddress: "my.1password.com",
          bitwardenClientId: "",
          bitwardenClientSecret: "   ",
        },
      });
      expect(res.status()).toBe(200);
      expect(res.body()).toEqual({
        ok: true,
        result: {
          backendId: "1password",
          sessionStored: true,
          message: "signed-in:1password",
        },
      });
      expect(installer.lastSignIn).toEqual({
        backendId: "1password",
        masterPassword: "hunter2",
        email: "owner@example.test",
        secretKey: "A3-XXXX",
        signInAddress: "my.1password.com",
        bitwardenClientSecret: "   ",
      });
    });

    it("maps an Error from the installer to HTTP 400", async () => {
      installer.signInImpl = async () => {
        throw new Error("bad creds");
      };
      const { res } = await invoke("POST", "/api/secrets/manager/signin", {
        body: { backendId: "bitwarden", masterPassword: "x" },
      });
      expect(res.status()).toBe(400);
      expect(res.body()).toEqual({ error: "bad creds" });
    });

    it("maps a non-Error installer rejection to a generic sign-in failure", async () => {
      installer.signInImpl = async () => {
        throw "nope";
      };
      const { res } = await invoke("POST", "/api/secrets/manager/signin", {
        body: { backendId: "protonpass", masterPassword: "x" },
      });
      expect(res.status()).toBe(400);
      expect(res.body()).toEqual({ error: "sign-in failed" });
    });
  });

  describe("POST /api/secrets/manager/signout", () => {
    it("rejects invalid JSON", async () => {
      const { res } = await invoke("POST", "/api/secrets/manager/signout", {
        body: "}",
      });
      expect(res.status()).toBe(400);
      expect(res.body()).toEqual({ error: "invalid JSON body" });
    });

    it("rejects an invalid backendId", async () => {
      const { res } = await invoke("POST", "/api/secrets/manager/signout", {
        body: { backendId: "lastpass" },
      });
      expect(res.status()).toBe(400);
      expect(res.body()).toEqual({ error: "invalid `backendId`" });
    });

    it("signs out an installable backend", async () => {
      const { handled, res } = await invoke(
        "POST",
        "/api/secrets/manager/signout",
        { body: { backendId: "bitwarden" } },
      );
      expect(handled).toBe(true);
      expect(res.status()).toBe(200);
      expect(res.body()).toEqual({ ok: true });
      expect(installer.lastSignOut).toBe("bitwarden");
    });
  });

  describe("saved logins", () => {
    it("lists an empty in-house queue", async () => {
      const { res } = await invoke("GET", "/api/secrets/logins");
      expect(res.status()).toBe(200);
      expect(inHouseLogins(res.body())).toEqual([]);
      expect((res.body() as { ok: boolean }).ok).toBe(true);
      expect(
        Array.isArray((res.body() as { failures: unknown }).failures),
      ).toBe(true);
    });

    it("lists a single saved login after POST", async () => {
      const created = await invoke("POST", "/api/secrets/logins", {
        body: {
          domain: "GitHub.com",
          username: "octocat",
          password: "pw-1",
        },
      });
      expect(created.res.status()).toBe(200);
      expect(created.res.body()).toEqual({ ok: true });

      const listed = await invoke("GET", "/api/secrets/logins");
      expect(inHouseLogins(listed.res.body())).toEqual([
        expect.objectContaining({
          source: "in-house",
          identifier: "github.com:octocat",
          domain: "github.com",
          username: "octocat",
          title: "octocat",
        }),
      ]);
    });

    it("orders multiple in-house logins by domain then username", async () => {
      for (const login of [
        { domain: "zebra.test", username: "amy", password: "a" },
        { domain: "apple.test", username: "bob", password: "b" },
        { domain: "apple.test", username: "amy", password: "c" },
      ]) {
        const { res } = await invoke("POST", "/api/secrets/logins", {
          body: login,
        });
        expect(res.status()).toBe(200);
      }

      const { res } = await invoke("GET", "/api/secrets/logins");
      expect(
        inHouseLogins(res.body()).map((entry) => {
          const row = entry as { identifier: string };
          return row.identifier;
        }),
      ).toEqual(["apple.test:amy", "apple.test:bob", "zebra.test:amy"]);
    });

    it("filters the list to one domain and returns empty when that domain has no logins", async () => {
      await invoke("POST", "/api/secrets/logins", {
        body: {
          domain: "apple.test",
          username: "amy",
          password: "a",
        },
      });
      await invoke("POST", "/api/secrets/logins", {
        body: {
          domain: "zebra.test",
          username: "amy",
          password: "z",
        },
      });

      const filtered = await invoke("GET", "/api/secrets/logins", {
        url: "/api/secrets/logins?domain=apple.test",
      });
      expect(
        inHouseLogins(filtered.res.body()).map(
          (entry) => (entry as { identifier: string }).identifier,
        ),
      ).toEqual(["apple.test:amy"]);

      const missing = await invoke("GET", "/api/secrets/logins", {
        url: "/api/secrets/logins?domain=missing.test",
      });
      expect(inHouseLogins(missing.res.body())).toEqual([]);
    });

    it("rejects reveal without a supported source", async () => {
      const { res } = await invoke("GET", "/api/secrets/logins/reveal", {
        url: "/api/secrets/logins/reveal?source=protonpass&identifier=x",
      });
      expect(res.status()).toBe(400);
      expect(res.body()).toEqual({
        error: "`source` must be one of: in-house, 1password, bitwarden",
      });
    });

    it("rejects reveal without an identifier", async () => {
      const { res } = await invoke("GET", "/api/secrets/logins/reveal", {
        url: "/api/secrets/logins/reveal?source=in-house",
      });
      expect(res.status()).toBe(400);
      expect(res.body()).toEqual({ error: "`identifier` is required" });
    });

    it("reveals an in-house login including otpSeed as totp", async () => {
      await invoke("POST", "/api/secrets/logins", {
        body: {
          domain: "mail.test",
          username: "user@mail.test",
          password: "s3cret",
          otpSeed: "JBSWY3DPEHPK3PXP",
          notes: "work inbox",
        },
      });
      const { res } = await invoke("GET", "/api/secrets/logins/reveal", {
        url: "/api/secrets/logins/reveal?source=in-house&identifier=mail.test:user%40mail.test",
      });
      expect(res.status()).toBe(200);
      expect(res.body()).toEqual({
        ok: true,
        login: {
          source: "in-house",
          identifier: "mail.test:user@mail.test",
          username: "user@mail.test",
          password: "s3cret",
          totp: "JBSWY3DPEHPK3PXP",
          domain: "mail.test",
        },
      });
    });

    it("maps a missing reveal target to HTTP 404", async () => {
      const { res } = await invoke("GET", "/api/secrets/logins/reveal", {
        url: "/api/secrets/logins/reveal?source=in-house&identifier=none.test:missing",
      });
      expect(res.status()).toBe(404);
      expect(res.body()).toEqual({
        error: "revealSavedLogin: no in-house login for none.test:missing",
      });
    });

    it("maps a non-Error reveal failure to a generic 404", async () => {
      _setSecretsManagerForTesting({
        listAllSavedLogins: async () => ({ logins: [], failures: [] }),
        revealSavedLogin: async () => {
          throw "boom";
        },
      } as never);
      installer = createFakeInstaller();
      _setSecretsManagerInstallerForTesting(installer);
      const { res } = await invoke("GET", "/api/secrets/logins/reveal", {
        url: "/api/secrets/logins/reveal?source=bitwarden&identifier=item-1",
      });
      expect(res.status()).toBe(404);
      expect(res.body()).toEqual({ error: "reveal failed" });
    });

    it("POST rejects invalid JSON", async () => {
      const { res } = await invoke("POST", "/api/secrets/logins", {
        body: "{",
      });
      expect(res.status()).toBe(400);
      expect(res.body()).toEqual({ error: "invalid JSON body" });
    });

    it.each([
      [{ username: "a", password: "b" }, "`domain` is required"],
      [{ domain: "   ", username: "a", password: "b" }, "`domain` is required"],
      [{ domain: "x.test", password: "b" }, "`username` is required"],
      [
        { domain: "x.test", username: "", password: "b" },
        "`username` is required",
      ],
      [{ domain: "x.test", username: "a" }, "`password` is required"],
      [
        { domain: "x.test", username: "a", password: "" },
        "`password` is required",
      ],
      [
        { domain: "x.test", username: "a", password: "b", otpSeed: 1 },
        "`otpSeed` must be a string when provided",
      ],
      [
        { domain: "x.test", username: "a", password: "b", notes: true },
        "`notes` must be a string when provided",
      ],
    ])("POST rejects invalid fields %j", async (body, error) => {
      const { res } = await invoke("POST", "/api/secrets/logins", { body });
      expect(res.status()).toBe(400);
      expect(res.body()).toEqual({ error });
    });

    it("GET of a missing domain/user pair is 404", async () => {
      const { res } = await invoke(
        "GET",
        "/api/secrets/logins/missing.test/nobody",
      );
      expect(res.status()).toBe(404);
      expect(res.body()).toEqual({
        error: "no saved login for domain/username",
      });
    });

    it("GET returns a saved login and DELETE of a missing item is still 200", async () => {
      await invoke("POST", "/api/secrets/logins", {
        body: {
          domain: "shop.test",
          username: "buyer",
          password: "pw",
        },
      });
      const got = await invoke("GET", "/api/secrets/logins/shop.test/buyer");
      expect(got.res.status()).toBe(200);
      const login = (got.res.body() as { login: { password: string } }).login;
      expect(login.password).toBe("pw");

      const deleted = await invoke(
        "DELETE",
        "/api/secrets/logins/shop.test/buyer",
      );
      expect(deleted.res.body()).toEqual({ ok: true });

      const missing = await invoke(
        "GET",
        "/api/secrets/logins/shop.test/buyer",
      );
      expect(missing.res.status()).toBe(404);

      const deletedAgain = await invoke(
        "DELETE",
        "/api/secrets/logins/shop.test/buyer",
      );
      expect(deletedAgain.res.status()).toBe(200);
      expect(deletedAgain.res.body()).toEqual({ ok: true });
    });

    it("decodes a percent-encoded username on GET", async () => {
      await invoke("POST", "/api/secrets/logins", {
        body: {
          domain: "mail.test",
          username: "user@mail.test",
          password: "pw",
        },
      });
      const { res } = await invoke(
        "GET",
        "/api/secrets/logins/mail.test/user%40mail.test",
      );
      expect(res.status()).toBe(200);
      expect(
        (res.body() as { login: { username: string } }).login.username,
      ).toBe("user@mail.test");
    });

    it("GET autoallow is false by default and PUT persists the boolean", async () => {
      const unset = await invoke(
        "GET",
        "/api/secrets/logins/shop.test/autoallow",
      );
      expect(unset.res.body()).toEqual({ ok: true, allowed: false });

      const invalidJson = await invoke(
        "PUT",
        "/api/secrets/logins/shop.test/autoallow",
        { body: "{" },
      );
      expect(invalidJson.res.status()).toBe(400);
      expect(invalidJson.res.body()).toEqual({ error: "invalid JSON body" });

      const notBool = await invoke(
        "PUT",
        "/api/secrets/logins/shop.test/autoallow",
        { body: { allowed: "yes" } },
      );
      expect(notBool.res.status()).toBe(400);
      expect(notBool.res.body()).toEqual({
        error: "`allowed` must be boolean",
      });

      const enabled = await invoke(
        "PUT",
        "/api/secrets/logins/shop.test/autoallow",
        { body: { allowed: true } },
      );
      expect(enabled.res.body()).toEqual({ ok: true, allowed: true });

      const readBack = await invoke(
        "GET",
        "/api/secrets/logins/shop.test/autoallow",
      );
      expect(readBack.res.body()).toEqual({ ok: true, allowed: true });
    });

    it("falls through when autoallow is neither GET nor PUT", async () => {
      const { handled } = await invoke(
        "POST",
        "/api/secrets/logins/shop.test/autoallow",
        { body: { allowed: true } },
      );
      expect(handled).toBe(false);
    });
  });
});
