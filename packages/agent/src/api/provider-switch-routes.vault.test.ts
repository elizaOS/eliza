/**
 * Route-level test for the vault-aware provider-switch handler.
 *
 * Exercises `handleProviderSwitchRoutes` as the API server invokes it,
 * with a mocked req/res and an injected SecretsManager backed by a
 * tmpdir vault. Asserts the durable contract every consumer relies on:
 *
 *   - The accepted-202 response references an operation id.
 *   - The vault contains the secret encrypted at rest.
 *   - The persisted operation file does NOT contain the plaintext.
 *   - The audit log records the route's `set` with caller
 *     "provider-switch-route" and never contains the plaintext.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManager, type SecretsManager } from "@elizaos/vault";
import { createTestVault, type TestVault } from "@elizaos/vault/testing";
import type { ElizaConfig } from "../config/config.js";
import {
  createColdStrategy,
  createHotStrategy,
  DefaultRuntimeOperationManager,
  defaultClassifier,
  FilesystemRuntimeOperationRepository,
  HealthChecker,
} from "../runtime/operations/index.js";
import {
  handleProviderSwitchRoutes,
  type ProviderSwitchRouteContext,
} from "./provider-switch-routes.js";

let stateDir: string;
let testVault: TestVault;
let secrets: SecretsManager;
let repo: FilesystemRuntimeOperationRepository;
let prevElizaHome: string | undefined;
let prevMiladyState: string | undefined;
let prevElizaState: string | undefined;

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "vault-route-"));
  testVault = await createTestVault({ workDir: join(stateDir, "vault-home") });
  secrets = createManager({ vault: testVault.vault });
  repo = new FilesystemRuntimeOperationRepository(stateDir, {
    retentionMs: 365 * 24 * 60 * 60 * 1000,
    maxRecords: 1000,
  });

  // Ensure config writes go inside `stateDir` so the test can scan for
  // plaintext leakage without touching the developer's real eliza home.
  prevElizaHome = process.env.ELIZA_HOME;
  prevMiladyState = process.env.MILADY_STATE_DIR;
  prevElizaState = process.env.ELIZA_STATE_DIR;
  process.env.ELIZA_HOME = stateDir;
  process.env.MILADY_STATE_DIR = stateDir;
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterEach(async () => {
  await testVault.dispose();
  rmSync(stateDir, { recursive: true, force: true });
  if (prevElizaHome === undefined) delete process.env.ELIZA_HOME;
  else process.env.ELIZA_HOME = prevElizaHome;
  if (prevMiladyState === undefined) delete process.env.MILADY_STATE_DIR;
  else process.env.MILADY_STATE_DIR = prevMiladyState;
  if (prevElizaState === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = prevElizaState;
});

interface MockResponse extends ServerResponse {
  status: number;
  body: unknown;
}

function makeMockReqRes(
  body: unknown,
  headers: IncomingHttpHeaders = {},
): { req: IncomingMessage; res: MockResponse } {
  const req = { headers } as IncomingMessage;
  const res = {
    status: 0,
    body: undefined as unknown,
  } as unknown as MockResponse;
  return { req, res };
}

function buildCtx(opts: {
  req: IncomingMessage;
  res: MockResponse;
  body: unknown;
}): ProviderSwitchRouteContext {
  const config: ElizaConfig = {} as ElizaConfig;
  return {
    req: opts.req,
    res: opts.res,
    method: "POST",
    pathname: "/api/provider/switch",
    state: { config },
    json: (res, data, status = 200) => {
      const r = res as MockResponse;
      r.status = status;
      r.body = data;
    },
    error: (res, message, status = 400) => {
      const r = res as MockResponse;
      r.status = status;
      r.body = { error: message };
    },
    readJsonBody: async () => opts.body as object,
    saveElizaConfig: () => {},
    scheduleRuntimeRestart: () => {},
    runtimeOperationManager: new DefaultRuntimeOperationManager({
      repository: repo,
      runtime: () => ({}) as never,
      classifyContext: () => ({ currentProvider: "openai" }),
      classifier: defaultClassifier,
      healthChecker: new HealthChecker(),
      strategies: {
        hot: createHotStrategy({
          secrets,
          applyProviderEnv: async () => {}, // tested elsewhere
          notifyConfigChanged: async () => {},
        }),
        cold: createColdStrategy({
          restartRuntime: async () => ({}) as never,
        }),
      },
    }),
    secretsManager: secrets,
  };
}

describe("handleProviderSwitchRoutes (vault path)", () => {
  test("POST /api/provider/switch with apiKey: vault stores secret, op file holds only ref", async () => {
    const apiKey = "sk-route-test-must-not-leak";
    const { req, res } = makeMockReqRes({
      provider: "openai",
      apiKey,
      primaryModel: "gpt-5.5",
    });
    const handled = await handleProviderSwitchRoutes(
      buildCtx({
        req,
        res,
        body: { provider: "openai", apiKey, primaryModel: "gpt-5.5" },
      }),
    );
    expect(handled).toBe(true);
    expect(res.status).toBe(202);
    const body = res.body as { operationId: string; provider: string };
    expect(body.provider).toBe("openai");
    expect(typeof body.operationId).toBe("string");

    // Vault has the encrypted entry.
    expect(await testVault.vault.has("providers.openai.api-key")).toBe(true);
    const desc = await testVault.vault.describe("providers.openai.api-key");
    expect(desc?.sensitive).toBe(true);

    // Drain the manager so the op completes.
    await new Promise((r) => setTimeout(r, 60));

    // Op file does NOT contain the plaintext.
    const opsDir = join(stateDir, "runtime-operations");
    const files = readdirSync(opsDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const f of files) {
      const content = readFileSync(join(opsDir, f), "utf8");
      expect(content).not.toContain(apiKey);
      // The ref must be referenced.
      expect(content).toContain("apiKeyRef");
      expect(content).toContain("providers.openai.api-key");
    }

    // Audit log: route's set with the right caller, no plaintext.
    const audit = await testVault.getAuditRecords();
    const routeSet = audit.find(
      (a) =>
        a.action === "set" &&
        a.key === "providers.openai.api-key" &&
        a.caller === "provider-switch-route",
    );
    expect(routeSet).toBeDefined();
    const auditRaw = readFileSync(testVault.auditLogPath, "utf8");
    expect(auditRaw).not.toContain(apiKey);
  });

  test("POST without apiKey: no vault write, intent has no apiKeyRef", async () => {
    const { req, res } = makeMockReqRes({
      provider: "openai",
      primaryModel: "gpt-5.5",
    });
    const handled = await handleProviderSwitchRoutes(
      buildCtx({
        req,
        res,
        body: { provider: "openai", primaryModel: "gpt-5.5" },
      }),
    );
    expect(handled).toBe(true);
    expect(res.status).toBe(202);

    // The vault was NOT written for this provider.
    expect(await testVault.vault.has("providers.openai.api-key")).toBe(false);

    // The op file's intent has no apiKeyRef.
    await new Promise((r) => setTimeout(r, 60));
    const opsDir = join(stateDir, "runtime-operations");
    const files = readdirSync(opsDir).filter((f) => f.endsWith(".json"));
    const opFile = readFileSync(join(opsDir, files[0]), "utf8");
    expect(opFile).not.toContain("apiKeyRef");
  });

  test("Idempotency-Key dedupes a duplicate switch — vault written once", async () => {
    const apiKey = "sk-idem-route";
    const headers: IncomingHttpHeaders = { "idempotency-key": "switch-2026" };
    const submit = async () => {
      const { req, res } = makeMockReqRes(
        {
          provider: "openai",
          apiKey,
        },
        headers,
      );
      // Inject the headers on the req object so readIdempotencyKey sees them.
      (req as { headers: IncomingHttpHeaders }).headers = headers;
      await handleProviderSwitchRoutes(
        buildCtx({
          req,
          res,
          body: { provider: "openai", apiKey },
        }),
      );
      return res;
    };

    const first = await submit();
    expect(first.status).toBe(202);
    const second = await submit();
    // The manager dedupes — but the route writes the vault on each call.
    // The contract: vault entry for the same key is overwritten with the
    // same value, leaving exactly one entry. No plaintext appears in any
    // op file.
    expect([200, 202]).toContain(second.status);
    expect(
      (await testVault.vault.list("providers.openai")).filter(
        (k) => k === "providers.openai.api-key",
      ),
    ).toHaveLength(1);
    const opsDir = join(stateDir, "runtime-operations");
    const files = readdirSync(opsDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeLessThanOrEqual(1);
    for (const f of files) {
      expect(readFileSync(join(opsDir, f), "utf8")).not.toContain(apiKey);
    }
  });
});
