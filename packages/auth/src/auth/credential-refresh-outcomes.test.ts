/** Real HTTP token responses and encrypted files exercise public refresh outcomes. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  type AccountStoragePolicy,
  createIsolatedAccountStoragePolicy,
  deleteAccount,
  loadAccount,
  resetAccountCredentialStorage,
  saveAccount,
} from "./account-storage.ts";
import {
  getAccessToken,
  getAccessTokenCredentialReceipt,
} from "./credentials.ts";
import type {
  AccountCredentialProvider,
  OAuthSubscriptionProvider,
} from "./types.ts";

const originalFetch = globalThis.fetch;
let directory: string;
let policy: AccountStoragePolicy;
let status = 400;
let errorCode = "invalid_grant";
let closeConnection = false;
let requests = 0;
let endpoint: string;
let enforceOneTimeGrant = false;
let malformedSuccess = false;
let stallFirstErrorBody = false;
let stalledConnectionClosed = false;
let stalledClose = Promise.withResolvers<void>();
let cleanupController = new AbortController();
let seenGrants: string[] = [];
let consumedGrants = new Set<string>();
let holdResponses = false;
let heldResponses: ServerResponse[] = [];
let requestWaiters: Array<{ count: number; resolve: () => void }> = [];
const originalStateDir = process.env.ELIZA_STATE_DIR;
function waitForRequests(count: number): Promise<void> {
  if (requests >= count) return Promise.resolve();
  return new Promise((resolve) => requestWaiters.push({ count, resolve }));
}
function releaseResponse(body: unknown, statusCode = 200): void {
  const response = heldResponses.shift();
  assert(response, "Expected a held provider response");
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
function accessToken(
  provider: OAuthSubscriptionProvider,
  identity: string,
): string {
  if (provider !== "openai-codex") return `access-${identity}`;
  const payload = {
    jti: identity,
    "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
  };
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fixture`;
}
function successBody(
  provider: OAuthSubscriptionProvider,
  identity: string,
  seconds = 3600,
) {
  return {
    access_token: accessToken(provider, identity),
    refresh_token: `refresh-${identity}`,
    expires_in: seconds,
  };
}
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const grant: unknown = request.headers["content-type"]?.includes(
    "application/json",
  )
    ? JSON.parse(body).refresh_token
    : new URLSearchParams(body).get("refresh_token");
  assert(typeof grant === "string", "Refresh request omitted its grant");
  seenGrants.push(grant);
  requests++;
  if (stallFirstErrorBody && requests === 1) {
    response.writeHead(400, { "content-type": "application/json" });
    response.flushHeaders();
    response.write('{"error":');
    response.once("close", () => {
      stalledConnectionClosed = true;
      stalledClose.resolve();
    });
    for (const waiter of requestWaiters)
      if (requests >= waiter.count) waiter.resolve();
    requestWaiters = requestWaiters.filter((waiter) => requests < waiter.count);
    return;
  }
  const refused =
    enforceOneTimeGrant &&
    (grant !== "fixture-refresh" || consumedGrants.has(grant));
  if (enforceOneTimeGrant && !refused) consumedGrants.add(grant);
  if (holdResponses && !refused) heldResponses.push(response);
  for (const waiter of requestWaiters)
    if (requests >= waiter.count) waiter.resolve();
  requestWaiters = requestWaiters.filter((waiter) => requests < waiter.count);
  if (refused) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid_grant" }));
    return;
  }
  if (holdResponses) return;
  if (closeConnection) {
    request.socket.destroy();
    return;
  }
  if (malformedSuccess) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("invalid-json");
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: errorCode }));
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  endpoint = `http://127.0.0.1:${address.port}/token`;
  globalThis.fetch = ((input, init) => {
    assert(
      [
        "https://auth.openai.com/oauth/token",
        "https://console.anthropic.com/v1/oauth/token",
      ].includes(String(input)),
      "Unexpected outbound request in credential refresh conformance",
    );
    const signal = init?.signal
      ? AbortSignal.any([init.signal, cleanupController.signal])
      : cleanupController.signal;
    return originalFetch(endpoint, { ...init, signal });
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  directory = fs.mkdtempSync(
    path.join(tmpdir(), "credential-refresh-outcome-"),
  );
  policy = createIsolatedAccountStoragePolicy(directory);
  requests = 0;
  status = 400;
  errorCode = "invalid_grant";
  closeConnection = false;
  holdResponses = false;
  enforceOneTimeGrant = false;
  malformedSuccess = false;
  stallFirstErrorBody = false;
  stalledConnectionClosed = false;
  stalledClose = Promise.withResolvers<void>();
  cleanupController = new AbortController();
  seenGrants = [];
  consumedGrants = new Set();
  heldResponses = [];
  requestWaiters = [];
  process.env.ELIZA_STATE_DIR = directory;
});

afterEach(() => {
  cleanupController.abort();
  for (const response of heldResponses) response.destroy();
  if (originalStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = originalStateDir;
  fs.rmSync(directory, { recursive: true, force: true });
});

function storeExpired(provider: OAuthSubscriptionProvider) {
  return saveAccount(
    {
      id: "account",
      providerId: provider,
      label: "Fixture",
      source: "oauth",
      credentials: {
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: 1,
      },
      createdAt: 1,
      updatedAt: 1,
    },
    policy,
  );
}

const failures = [
  { status: 400, error: "invalid_grant", kind: "auth" },
  { status: 400, error: "invalid_request", kind: "transient" },
  { status: 400, error: "invalid_client", kind: "transient" },
  { status: 400, error: "invalid_token", kind: "auth" },
  { status: 401, error: "unauthorized", kind: "auth" },
  { status: 403, error: "forbidden", kind: "auth" },
  { status: 429, error: "rate_limit_exceeded", kind: "transient" },
  { status: 503, error: "server_error", kind: "transient" },
  { status: 429, error: "invalid_grant", kind: "transient" },
  { status: 503, error: "invalid_grant", kind: "transient" },
] as const;

for (const provider of ["openai-codex", "anthropic-subscription"] as const) {
  it.each(failures)(
    `${provider} preserves the $status/$error refresh outcome`,
    async (failure) => {
      const before = storeExpired(provider);
      status = failure.status;
      errorCode = failure.error;
      const outcome = await getAccessToken(provider, "account", {
        storagePolicy: policy,
        outcome: true,
      });
      expect(outcome).toMatchObject({ ok: false, kind: failure.kind });
      expect(getAccessTokenCredentialReceipt(outcome)).toEqual({
        provider,
        accountId: "account",
        credentialGeneration: before.credentialGeneration,
      });
      expect(requests).toBe(1);
      expect(
        await getAccessToken(provider, "account", { storagePolicy: policy }),
      ).toBeNull();
      expect(requests).toBe(2);
      expect(loadAccount(provider, "account", policy)).toEqual(before);
    },
  );

  it(`${provider} reports transport failure without replacing the stored grant`, async () => {
    const before = storeExpired(provider);
    closeConnection = true;
    const outcome = await getAccessToken(provider, "account", {
      storagePolicy: policy,
      outcome: true,
    });
    expect(outcome).toMatchObject({ ok: false, kind: "transient" });
    expect(requests).toBeGreaterThanOrEqual(1);
    expect(loadAccount(provider, "account", policy)).toEqual(before);
  });
}

it("requires a storage policy before spending an expired OAuth grant", async () => {
  storeExpired("openai-codex");
  await expect(
    getAccessToken("openai-codex", "account", { outcome: true }),
  ).rejects.toMatchObject({
    code: "AUTH_CREDENTIAL_MUTATION_POLICY_REQUIRED",
  });
  expect(requests).toBe(0);
});

it("normalizes invalid lifetime requests without spending a fresh OAuth grant", async () => {
  const provider = "openai-codex";
  const stored = storeExpired(provider);
  saveAccount(
    {
      ...stored,
      credentials: { ...stored.credentials, expires: Date.now() + 350_000 },
    },
    policy,
  );
  for (const minRemainingMs of [
    undefined,
    -1,
    0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    expect(
      await getAccessToken(provider, "account", {
        storagePolicy: policy,
        minRemainingMs,
        outcome: true,
      }),
    ).toMatchObject({
      ok: true,
      accessToken: stored.credentials.access,
      refreshed: false,
    });
  }
  expect(requests).toBe(0);
});

it.each(["openai-api", "zai-coding", "gemini-cli", "deepseek-coding"] as const)(
  "%s preserves its non-refreshable admission contract",
  async (provider: AccountCredentialProvider) => {
    const stored = saveAccount(
      {
        id: "account",
        providerId: provider,
        label: "Fixture",
        source: "api-key",
        credentials: {
          access: "fixture-access",
          refresh: "",
          expires: Date.now() + 60_000,
        },
        createdAt: 1,
        updatedAt: 1,
      },
      policy,
    );
    const defaultOutcome = await getAccessToken(provider, "account", {
      storagePolicy: policy,
      outcome: true,
    });
    const widened = await getAccessToken(provider, "account", {
      storagePolicy: policy,
      minRemainingMs: 600_000,
      outcome: true,
    });
    if (provider === "openai-api") {
      expect(defaultOutcome).toMatchObject({ ok: true, refreshed: false });
      expect(widened).toMatchObject({
        ok: true,
        accessToken: stored.credentials.access,
      });
    } else if (provider === "zai-coding") {
      expect(defaultOutcome).toMatchObject({ ok: true, refreshed: false });
      expect(widened).toMatchObject({
        ok: false,
        kind: "insufficient-lifetime",
        minRemainingMs: 600_000,
      });
    } else {
      expect(defaultOutcome).toMatchObject({ ok: false, kind: "auth" });
      expect(widened).toMatchObject({ ok: false, kind: "auth" });
    }
    expect(requests).toBe(0);
  },
);

for (const provider of ["openai-codex", "anthropic-subscription"] as const) {
  it(`${provider} queues a caller behind the stored refresh result`, async () => {
    storeExpired(provider);
    holdResponses = true;
    const first = getAccessToken(provider, "account", {
      storagePolicy: policy,
      outcome: true,
    });
    const second = getAccessToken(provider, "account", {
      storagePolicy: policy,
      outcome: true,
    });
    await waitForRequests(1);
    releaseResponse(successBody(provider, "new"));
    const firstOutcome = await first;
    const secondOutcome = await second;
    expect(firstOutcome).toMatchObject({
      ok: true,
      accessToken: accessToken(provider, "new"),
      refreshed: true,
    });
    expect(secondOutcome).toMatchObject({
      ok: true,
      accessToken: accessToken(provider, "new"),
      refreshed: false,
    });
    const stored = loadAccount(provider, "account", policy);
    expect(
      getAccessTokenCredentialReceipt(firstOutcome)?.credentialGeneration,
    ).toBe(stored?.credentialGeneration);
    expect(
      getAccessTokenCredentialReceipt(secondOutcome)?.credentialGeneration,
    ).toBe(stored?.credentialGeneration);
    expect(requests).toBe(1);
  });

  it(`${provider} stores a rotated short-lived grant before returning insufficient lifetime`, async () => {
    storeExpired(provider);
    holdResponses = true;
    const first = getAccessToken(provider, "account", {
      storagePolicy: policy,
      minRemainingMs: 600_000,
      outcome: true,
    });
    await waitForRequests(1);
    releaseResponse(successBody(provider, "short", 450));
    expect(await first).toMatchObject({
      ok: false,
      kind: "insufficient-lifetime",
      minRemainingMs: 600_000,
    });
    expect(loadAccount(provider, "account", policy)?.credentials.refresh).toBe(
      "refresh-short",
    );
    expect(
      await getAccessToken(provider, "account", {
        storagePolicy: policy,
        outcome: true,
      }),
    ).toMatchObject({
      ok: true,
      accessToken: accessToken(provider, "short"),
      refreshed: false,
    });
    expect(requests).toBe(1);
  });

  it(`${provider} lets deletion win over a provider response`, async () => {
    storeExpired(provider);
    holdResponses = true;
    const pending = getAccessToken(provider, "account", {
      storagePolicy: policy,
      outcome: true,
    });
    await waitForRequests(1);
    deleteAccount(provider, "account", policy);
    releaseResponse(successBody(provider, "discarded"));
    expect(await pending).toMatchObject({ ok: false, kind: "auth" });
    expect(loadAccount(provider, "account", policy)).toBeNull();
  });

  it(`${provider} returns a fresh replacement without overwriting its generation`, async () => {
    const original = storeExpired(provider);
    holdResponses = true;
    const pending = getAccessToken(provider, "account", {
      storagePolicy: policy,
      outcome: true,
    });
    await waitForRequests(1);
    const replacement = saveAccount(
      {
        ...original,
        label: "Replacement",
        credentials: {
          access: "replacement-access",
          refresh: "replacement-refresh",
          expires: Date.now() + 3_600_000,
        },
      },
      policy,
    );
    releaseResponse(successBody(provider, "discarded"));
    expect(await pending).toMatchObject({
      ok: true,
      accessToken: "replacement-access",
      refreshed: false,
    });
    expect(loadAccount(provider, "account", policy)).toEqual(replacement);
  });

  it(`${provider} rejects a response whose explicit policy predates reset`, async () => {
    storeExpired(provider);
    holdResponses = true;
    const pending = getAccessToken(provider, "account", {
      storagePolicy: policy,
      outcome: true,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      code: "AUTH_CREDENTIAL_STORAGE_GENERATION_CHANGED",
    });
    await waitForRequests(1);
    resetAccountCredentialStorage(policy, () => {});
    releaseResponse(successBody(provider, "discarded"));
    await rejected;
    const restarted = createIsolatedAccountStoragePolicy(directory);
    expect(loadAccount(provider, "account", restarted)).toBeNull();
  });
}

it("releases the refresh queue after an uncertain published write failure", async () => {
  const provider = "openai-codex";
  storeExpired(provider);
  holdResponses = true;
  const originalRename = fs.renameSync;
  let injected = false;
  const target = path.join(policy.authRoot, provider, "account.json");
  const first = getAccessToken(provider, "account", {
    storagePolicy: policy,
    outcome: true,
  });
  const failure = expect(first).rejects.toThrow(
    "injected credential publication failure",
  );
  const second = getAccessToken(provider, "account", {
    storagePolicy: policy,
    outcome: true,
  });
  await waitForRequests(1);
  try {
    fs.renameSync = (from, to) => {
      originalRename(from, to);
      if (String(to) === target && !injected) {
        injected = true;
        throw Object.assign(
          new Error("injected credential publication failure"),
          { code: "EIO" },
        );
      }
    };
    releaseResponse(successBody(provider, "durable"));
    await failure;
    expect(await second).toMatchObject({
      ok: true,
      accessToken: accessToken(provider, "durable"),
      refreshed: false,
    });
  } finally {
    fs.renameSync = originalRename;
  }
  expect(injected).toBe(true);
  expect(requests).toBe(1);
  expect(loadAccount(provider, "account", policy)?.credentials.refresh).toBe(
    "refresh-durable",
  );
});

it("keeps identical account keys isolated across explicit policy roots", async () => {
  const provider = "openai-codex";
  const firstPolicy = policy;
  const firstRecord = storeExpired(provider);
  const secondPolicy = createIsolatedAccountStoragePolicy(
    path.join(directory, "second-root"),
  );
  saveAccount(
    {
      ...firstRecord,
      credentials: {
        ...firstRecord.credentials,
        refresh: "other-root-refresh",
      },
    },
    secondPolicy,
  );
  holdResponses = true;
  const first = getAccessToken(provider, "account", {
    storagePolicy: firstPolicy,
    outcome: true,
  });
  const second = getAccessToken(provider, "account", {
    storagePolicy: secondPolicy,
    outcome: true,
  });
  await waitForRequests(1);
  releaseResponse(successBody(provider, "root-one"));
  expect(await first).toMatchObject({
    ok: true,
    accessToken: accessToken(provider, "root-one"),
  });
  await waitForRequests(2);
  releaseResponse(successBody(provider, "root-two"));
  expect(await second).toMatchObject({
    ok: true,
    accessToken: accessToken(provider, "root-two"),
  });
  expect(
    loadAccount(provider, "account", firstPolicy)?.credentials.refresh,
  ).toBe("refresh-root-one");
  expect(
    loadAccount(provider, "account", secondPolicy)?.credentials.refresh,
  ).toBe("refresh-root-two");
});

it("preserves the winning stored rotation when separate processes race one remote grant", async () => {
  const fixture = fileURLToPath(
    new URL("../../test/fixtures/refresh-process-probe.ts", import.meta.url),
  );
  const root = path.join(directory, "cross-process");
  const children: Array<ReturnType<typeof spawn>> = [];
  const completions: Array<Promise<unknown>> = [];
  function run(mode: string, tag: string): Promise<unknown> {
    const resultFile = path.join(directory, `${tag}.json`);
    const child = spawn("bun", ["--conditions=eliza-source", fixture], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        BUN_ENV: "production",
        VITEST: "false",
        ELIZA_VAULT_DISABLE_KEYCHAIN: "1",
        ELIZA_VAULT_PASSPHRASE: "isolated-refresh-conformance-passphrase",
        REFRESH_PROBE_ROOT: root,
        REFRESH_PROBE_RESULT: resultFile,
        REFRESH_PROBE_ENDPOINT: endpoint,
        REFRESH_PROBE_MODE: mode,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    child.stdout?.resume();
    let stderr = "";
    child.stderr?.on("data", (part) => {
      stderr += part;
    });
    const completion = new Promise<unknown>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code !== 0)
          reject(new Error(`Refresh probe ended ${code}/${signal}: ${stderr}`));
        else resolve(JSON.parse(fs.readFileSync(resultFile, "utf8")));
      });
    });
    completions.push(completion);
    return completion;
  }
  try {
    expect(await run("seed", "seed")).toEqual({ seeded: true });
    holdResponses = true;
    enforceOneTimeGrant = true;
    const first = run("refresh", "first");
    const second = run("refresh", "second");
    await waitForRequests(2);
    releaseResponse(successBody("openai-codex", "winner"));
    const outcomes = await Promise.all([first, second]);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: true,
          accessToken: accessToken("openai-codex", "winner"),
          refreshed: true,
        }),
        expect.objectContaining({ ok: false, kind: "auth" }),
      ]),
    );
    expect(await run("read", "read")).toMatchObject({
      credentials: {
        access: accessToken("openai-codex", "winner"),
        refresh: "refresh-winner",
        idToken: "fixture-id-token",
      },
    });
    expect(requests).toBe(2);
    expect(seenGrants).toEqual(["fixture-refresh", "fixture-refresh"]);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
    await Promise.allSettled(completions);
  }
});

for (const provider of ["openai-codex", "anthropic-subscription"] as const) {
  it(`${provider} keeps a current refresh token when a valid response omits rotation`, async () => {
    const original = storeExpired(provider);
    holdResponses = true;
    const pending = getAccessToken(provider, "account", {
      storagePolicy: policy,
      outcome: true,
    });
    await waitForRequests(1);
    const response = successBody(provider, "no-rotation");
    const { refresh_token: _unused, ...withoutRotation } = response;
    releaseResponse(withoutRotation);
    expect(await pending).toMatchObject({ ok: true, refreshed: true });
    expect(loadAccount(provider, "account", policy)?.credentials.refresh).toBe(
      original.credentials.refresh,
    );
  });

  it(`${provider} exposes an uncertain malformed response without claiming the spent grant persisted`, async () => {
    const original = storeExpired(provider);
    malformedSuccess = true;
    enforceOneTimeGrant = true;
    expect(
      await getAccessToken(provider, "account", {
        storagePolicy: policy,
        outcome: true,
      }),
    ).toMatchObject({
      ok: false,
      kind: "transient",
    });
    expect(loadAccount(provider, "account", policy)).toEqual(original);
    expect(
      await getAccessToken(provider, "account", {
        storagePolicy: policy,
        outcome: true,
      }),
    ).toMatchObject({
      ok: false,
      kind: "auth",
    });
    expect(loadAccount(provider, "account", policy)).toEqual(original);
    expect(requests).toBe(2);
  });
}

it("does not fabricate persistence when a rotated grant fails before file publication", async () => {
  const provider = "openai-codex";
  const original = storeExpired(provider);
  const originalRename = fs.renameSync;
  const target = path.join(policy.authRoot, provider, "account.json");
  let injected = false;
  holdResponses = true;
  enforceOneTimeGrant = true;
  const first = getAccessToken(provider, "account", {
    storagePolicy: policy,
    outcome: true,
  });
  const rejected = expect(first).rejects.toThrow(
    "injected before credential publication",
  );
  const second = getAccessToken(provider, "account", {
    storagePolicy: policy,
    outcome: true,
  });
  await waitForRequests(1);
  try {
    fs.renameSync = (from, to) => {
      if (String(to) === target && !injected) {
        injected = true;
        throw Object.assign(
          new Error("injected before credential publication"),
          { code: "EIO" },
        );
      }
      originalRename(from, to);
    };
    releaseResponse(successBody(provider, "lost-rotation"));
    await rejected;
    expect(await second).toMatchObject({ ok: false, kind: "auth" });
  } finally {
    fs.renameSync = originalRename;
  }
  expect(injected).toBe(true);
  expect(loadAccount(provider, "account", policy)).toEqual(original);
  expect(requests).toBe(2);
});

it("returns a fresh legacy token without requiring mutation authority", async () => {
  const original = storeExpired("openai-codex");
  saveAccount(
    {
      ...original,
      credentials: { ...original.credentials, expires: Date.now() + 3_600_000 },
    },
    policy,
  );
  expect(await getAccessToken("openai-codex", "account")).toBe(
    original.credentials.access,
  );
  expect(requests).toBe(0);
});

it("preserves typed and legacy absence without attempting a provider request", async () => {
  expect(
    await getAccessToken("openai-codex", "missing", {
      storagePolicy: policy,
      outcome: true,
    }),
  ).toMatchObject({
    ok: false,
    kind: "auth",
  });
  expect(
    await getAccessToken("openai-codex", "missing", { storagePolicy: policy }),
  ).toBeNull();
  expect(requests).toBe(0);
});

it("aborts a stalled Codex HTTP400 body and releases the next account refresh", async () => {
  const original = storeExpired("openai-codex");
  stallFirstErrorBody = true;
  const first = getAccessToken("openai-codex", "account", {
    storagePolicy: policy,
    outcome: true,
  });
  const second = getAccessToken("openai-codex", "account", {
    storagePolicy: policy,
    outcome: true,
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new Error(
              "HTTP400 body did not release its refresh owner within eight seconds",
            ),
          ),
        8_000,
      );
    });
    expect(await Promise.race([first, deadline])).toMatchObject({
      ok: false,
      kind: "transient",
    });
    expect(await Promise.race([second, deadline])).toMatchObject({
      ok: false,
      kind: "auth",
    });
    await Promise.race([stalledClose.promise, deadline]);
    expect(stalledConnectionClosed).toBe(true);
    expect(requests).toBe(2);
    expect(loadAccount("openai-codex", "account", policy)).toEqual(original);
  } finally {
    if (timeout) clearTimeout(timeout);
    cleanupController.abort();
    await Promise.allSettled([first, second]);
  }
});
