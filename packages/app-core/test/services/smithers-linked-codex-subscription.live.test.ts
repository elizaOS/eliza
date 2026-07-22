/**
 * Live acceptance proof for a linked Codex subscription across AccountPool, ACP, Smithers, durable task metering, and restart rematerialization.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { loadAccount, saveAccount } from "@elizaos/auth/account-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../../../../plugins/plugin-agent-orchestrator/src/services/acp-service.js";
import { OrchestratorTaskService } from "../../../../plugins/plugin-agent-orchestrator/src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../../../plugins/plugin-agent-orchestrator/src/services/orchestrator-task-store.js";
import { runDurableTask } from "../../../../plugins/plugin-agent-orchestrator/src/services/smithers-task-integration.js";
import {
  __resetDefaultAccountPoolForTests,
  getDefaultAccountPool,
} from "../../src/services/account-pool.js";
import { readTodayCounters } from "../../src/services/account-usage.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const LINKED_ACCOUNT_ID = "live-linked-codex";
const LIVE_TIMEOUT_MS = Number(
  process.env.LIVE_SMITHERS_SUBSCRIPTION_TIMEOUT_MS ?? 180_000,
);
const describeLive =
  process.env.RUN_LIVE_SMITHERS_SUBSCRIPTION === "1" ? describe : describe.skip;

interface CodexAuthJson {
  last_refresh?: string;
  tokens: {
    access_token: string;
    refresh_token: string;
    id_token: string;
    account_id: string;
  };
}

interface LiveRunResult {
  accountMetadata: Record<string, unknown>;
  materializedHome: string;
  materializedDigestBeforePrompt: string;
  materializedDigestAfterPrompt: string;
  nonce: string;
  counterCalls: number;
  counterTokens: number;
  taskUsageTokens: number;
  reportedErrors: unknown[][];
  logs: unknown[][];
}

const ORIGINAL_ENV = new Map<string, string | undefined>();
let originalCwd: string | undefined;
let liveRoot: string | undefined;

function rememberEnv(key: string): void {
  if (!ORIGINAL_ENV.has(key)) ORIGINAL_ENV.set(key, process.env[key]);
}

function setEnv(key: string, value: string | undefined): void {
  rememberEnv(key);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function restoreEnvironment(): void {
  for (const [key, value] of ORIGINAL_ENV) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  ORIGINAL_ENV.clear();
  if (originalCwd) process.chdir(originalCwd);
  originalCwd = undefined;
}

function parseHostCodexAuth(raw: string): CodexAuthJson {
  const value = JSON.parse(raw) as Partial<CodexAuthJson>;
  const tokens = value.tokens;
  if (
    !tokens ||
    typeof tokens.access_token !== "string" ||
    tokens.access_token.length === 0 ||
    typeof tokens.refresh_token !== "string" ||
    tokens.refresh_token.length === 0 ||
    typeof tokens.id_token !== "string" ||
    tokens.id_token.length === 0 ||
    typeof tokens.account_id !== "string" ||
    tokens.account_id.length === 0
  ) {
    throw new Error(
      "RUN_LIVE_SMITHERS_SUBSCRIPTION=1 requires a complete ChatGPT-mode ~/.codex/auth.json",
    );
  }
  return {
    tokens,
    ...(typeof value.last_refresh === "string"
      ? { last_refresh: value.last_refresh }
      : {}),
  };
}

function jwtExpiryMs(token: string): number {
  const encoded = token.split(".")[1];
  if (!encoded) return Date.now() + 60 * 60_000;
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf-8"),
    ) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : Date.now() + 60 * 60_000;
  } catch {
    // error-policy:J3 a non-JWT access token has no trustworthy expiry claim;
    // the live Codex process remains the auth boundary and can refresh it.
    return Date.now() + 60 * 60_000;
  }
}

function authDigest(auth: {
  access: string;
  refresh: string;
  idToken?: string;
  accountId?: string;
}): string {
  return createHash("sha256")
    .update(auth.access)
    .update("\0")
    .update(auth.refresh)
    .update("\0")
    .update(auth.idToken ?? "")
    .update("\0")
    .update(auth.accountId ?? "")
    .digest("hex");
}

function authJsonDigest(authPath: string): string {
  const parsed = parseHostCodexAuth(readFileSync(authPath, "utf-8"));
  return authDigest({
    access: parsed.tokens.access_token,
    refresh: parsed.tokens.refresh_token,
    idToken: parsed.tokens.id_token,
    accountId: parsed.tokens.account_id,
  });
}

function canonicalAccountDigest(): string {
  const record = loadAccount("openai-codex", LINKED_ACCOUNT_ID);
  if (
    !record?.credentials.access ||
    !record.credentials.refresh ||
    !record.credentials.idToken ||
    !record.organizationId
  ) {
    throw new Error("linked Codex account lost its canonical credential pair");
  }
  return authDigest({
    access: record.credentials.access,
    refresh: record.credentials.refresh,
    idToken: record.credentials.idToken,
    accountId: record.organizationId,
  });
}

function resolveActiveCodexHome(root: string): string {
  const accountRoot = path.join(root, "auth", "_codex-home", LINKED_ACCOUNT_ID);
  const relativeHome = readFileSync(
    path.join(accountRoot, "active-home"),
    "utf-8",
  ).trim();
  const activeHome = path.resolve(accountRoot, relativeHome);
  const relativeToRoot = path.relative(accountRoot, activeHome);
  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new Error(
      "linked Codex active-home pointer escaped its account root",
    );
  }
  return activeHome;
}

function makeRuntime() {
  const settings: Record<string, string> = {
    ELIZA_ACP_TRANSPORT: "native",
    ELIZA_ACP_SESSION_STORE_BACKEND: "memory",
    ELIZA_CODEX_ACP_SANDBOX_MODE: "read-only",
    ELIZA_CODEX_ACP_APPROVAL_POLICY: "on-request",
    ELIZA_ORCHESTRATOR_ADMISSION_QUEUE: "0",
  };
  if (process.env.ELIZA_CODEX_ACP_COMMAND) {
    settings.ELIZA_CODEX_ACP_COMMAND = process.env.ELIZA_CODEX_ACP_COMMAND;
  }
  let acp: AcpService | undefined;
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const reportError = vi.fn();
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Linked subscription acceptance" },
    logger,
    getSetting: vi.fn((key: string) => settings[key]),
    getService: vi.fn((type: string) =>
      type === AcpService.serviceType ? acp : undefined,
    ),
    getServiceLoadPromise: vi.fn(async (type: string) =>
      type === AcpService.serviceType ? acp : undefined,
    ),
    reportError,
    useModel: vi.fn(async () => "{}"),
    services: new Map<string, unknown[]>(),
  };
  return {
    runtime: runtime as never,
    logger,
    reportError,
    setAcp(service: AcpService): void {
      acp = service;
    },
  };
}

async function runLinkedSubscriptionTurn(
  root: string,
  runNumber: number,
): Promise<LiveRunResult> {
  const holder = makeRuntime();
  const acp = new AcpService(holder.runtime);
  holder.setAcp(acp);
  const store = new OrchestratorTaskStore({ backend: "memory" });
  const tasks = new OrchestratorTaskService(holder.runtime, { store });
  const workdir = path.join(root, "work", `run-${runNumber}`);
  const childHome = path.join(root, "child-home");
  mkdirSync(workdir, { recursive: true });
  mkdirSync(childHome, { recursive: true });
  let sessionId: string | undefined;
  try {
    await acp.start();
    await tasks.start();
    const taskDoc = await store.createTask({
      title: `linked subscription run ${runNumber}`,
      goal: "prove the selected linked Codex account reaches Smithers",
      acceptanceCriteria: [],
    });
    const session = await acp.spawnSession({
      agentType: "codex",
      workdir,
      approvalPreset: "readonly",
      name: `linked-codex-smithers-${runNumber}`,
      // Hide the operator's ~/.codex from the child completely. The turn can
      // authenticate only if AccountPool's selected CODEX_HOME reaches ACP.
      env: {
        HOME: childHome,
        NPM_CONFIG_CACHE: path.join(homedir(), ".npm"),
      },
    });
    sessionId = session.sessionId;
    const accountMetadata = session.metadata?.account;
    if (!accountMetadata || typeof accountMetadata !== "object") {
      throw new Error("AcpService did not stamp selected-account metadata");
    }
    const serializedMetadata = JSON.stringify(session.metadata ?? {});
    const canonical = loadAccount("openai-codex", LINKED_ACCOUNT_ID);
    const metadataContainsCredential = [
      canonical?.credentials.access,
      canonical?.credentials.refresh,
      canonical?.credentials.idToken,
    ].some(
      (secret) =>
        typeof secret === "string" && serializedMetadata.includes(secret),
    );
    expect(metadataContainsCredential).toBe(false);

    const materializedHome = resolveActiveCodexHome(root);
    const authPath = path.join(materializedHome, "auth.json");
    const configPath = path.join(materializedHome, "config.toml");
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(configPath, "utf-8")).toContain(
      'cli_auth_credentials_store = "file"',
    );
    expect(existsSync(path.join(childHome, ".codex", "auth.json"))).toBe(false);
    const materializedDigestBeforePrompt = authJsonDigest(authPath);

    await tasks.attachSession(taskDoc.task.id, {
      sessionId: session.sessionId,
      agentType: session.agentType,
      workdir: session.workdir,
      status: session.status,
      metadata: session.metadata,
      label: session.name,
      originalTask: taskDoc.task.goal,
    });
    const beforeCounters = readTodayCounters("openai-codex", LINKED_ACCOUNT_ID);
    const nonce = `LINKED_SMITHERS_${randomUUID().replaceAll("-", "")}`;
    const result = await runDurableTask(
      acp,
      session,
      `Reply with exactly this nonce and no other text: ${nonce}`,
      {
        tenantId: AGENT_ID,
        taskId: taskDoc.task.id,
        runId: randomUUID(),
        timeoutMs: LIVE_TIMEOUT_MS,
      },
    );
    expect(result).toMatchObject({
      status: "completed",
      lastResponse: nonce,
      turns: 1,
    });

    await vi.waitFor(
      async () => {
        const recorded = await store.getTask(taskDoc.task.id);
        expect(recorded?.usage.length).toBeGreaterThan(0);
        expect(readTodayCounters("openai-codex", LINKED_ACCOUNT_ID).calls).toBe(
          beforeCounters.calls + 1,
        );
      },
      { timeout: 20_000, interval: 100 },
    );
    const recorded = await store.getTask(taskDoc.task.id);
    if (!recorded) {
      throw new Error("durable task disappeared after its usage event");
    }
    const taskUsageTokens = recorded.usage.reduce(
      (sum, usage) =>
        sum +
        usage.inputTokens +
        usage.outputTokens +
        usage.reasoningTokens +
        usage.cacheTokens,
      0,
    );
    const durableSession = recorded.sessions.find(
      (candidate) => candidate.sessionId === session.sessionId,
    );
    expect(durableSession).toMatchObject({
      accountProviderId: "openai-codex",
      accountId: LINKED_ACCOUNT_ID,
      usageState: "measured",
    });
    expect(taskUsageTokens).toBeGreaterThan(0);
    const counters = readTodayCounters("openai-codex", LINKED_ACCOUNT_ID);
    expect(counters.tokens - beforeCounters.tokens).toBe(taskUsageTokens);
    expect(
      getDefaultAccountPool().get(LINKED_ACCOUNT_ID, "openai-codex"),
    ).toMatchObject({
      id: LINKED_ACCOUNT_ID,
      providerId: "openai-codex",
      health: "ok",
    });

    return {
      accountMetadata: accountMetadata as Record<string, unknown>,
      materializedHome,
      materializedDigestBeforePrompt,
      materializedDigestAfterPrompt: authJsonDigest(authPath),
      nonce,
      counterCalls: counters.calls,
      counterTokens: counters.tokens,
      taskUsageTokens,
      reportedErrors: holder.reportError.mock.calls,
      logs: holder.logger.info.mock.calls,
    };
  } finally {
    if (sessionId) {
      try {
        await acp.stopSession(sessionId);
      } catch (error) {
        // error-policy:J6 the live proof must still stop its owning services if
        // the child session already exited or rejects its best-effort close.
        holder.logger.warn(
          {
            src: "smithers-linked-codex-subscription-live-test",
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          },
          "ACP session teardown failed; continuing service cleanup",
        );
      }
    }
    await tasks.stop();
    await acp.stop();
  }
}

afterEach(() => {
  __resetDefaultAccountPoolForTests();
  restoreEnvironment();
  if (liveRoot) rmSync(liveRoot, { recursive: true, force: true });
  liveRoot = undefined;
});

describeLive(
  "linked AccountPool → AcpService → Smithers Codex subscription (live)",
  () => {
    it(
      "authenticates from the selected per-account CODEX_HOME, attributes usage, and rematerializes after restart",
      async () => {
        const hostAuthPath = path.join(homedir(), ".codex", "auth.json");
        expect(
          existsSync(hostAuthPath),
          "RUN_LIVE_SMITHERS_SUBSCRIPTION=1 requires an authenticated ~/.codex/auth.json",
        ).toBe(true);
        const hostAuthRaw = readFileSync(hostAuthPath, "utf-8");
        const hostAuth = parseHostCodexAuth(hostAuthRaw);
        const hostAuthFileDigest = createHash("sha256")
          .update(hostAuthRaw)
          .digest("hex");
        const hostCredentialDigest = authDigest({
          access: hostAuth.tokens.access_token,
          refresh: hostAuth.tokens.refresh_token,
          idToken: hostAuth.tokens.id_token,
          accountId: hostAuth.tokens.account_id,
        });

        originalCwd = process.cwd();
        liveRoot = mkdtempSync(
          path.join(tmpdir(), "linked-codex-smithers-live-"),
        );
        process.chdir(liveRoot);
        setEnv("ELIZA_HOME", liveRoot);
        setEnv("ELIZA_STATE_DIR", liveRoot);
        setEnv("ELIZA_ORCHESTRATOR_SMITHERS", "1");
        setEnv("ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY", "0");
        setEnv("ELIZA_ORCHESTRATOR_RESIDUALS_GATE", "0");
        setEnv("SMITHERS_DB_PROVIDER", "sqlite");
        setEnv("SMITHERS_DB_URL", undefined);
        setEnv("SMITHERS_DB_DATA_DIR", undefined);
        // A deliberately invalid API key proves the linked ChatGPT-mode
        // CODEX_HOME wins at AcpService's final child-env boundary.
        setEnv("OPENAI_API_KEY", "test-api-key-must-not-authenticate");

        const now = Date.now();
        saveAccount({
          id: LINKED_ACCOUNT_ID,
          providerId: "openai-codex",
          label: "Live linked Codex",
          source: "oauth",
          credentials: {
            access: hostAuth.tokens.access_token,
            refresh: hostAuth.tokens.refresh_token,
            idToken: hostAuth.tokens.id_token,
            expires: jwtExpiryMs(hostAuth.tokens.access_token),
          },
          organizationId: hostAuth.tokens.account_id,
          createdAt: now,
          updatedAt: hostAuth.last_refresh
            ? Date.parse(hostAuth.last_refresh)
            : now,
        });

        __resetDefaultAccountPoolForTests();
        const firstPool = getDefaultAccountPool();
        expect(firstPool.list("openai-codex")).toHaveLength(1);
        const first = await runLinkedSubscriptionTurn(liveRoot, 1);
        expect(first.accountMetadata).toMatchObject({
          providerId: "openai-codex",
          accountId: LINKED_ACCOUNT_ID,
          label: "Live linked Codex",
          source: "oauth",
          strategy: "least-used",
        });
        expect(first.materializedHome).not.toBe(path.dirname(hostAuthPath));
        expect(first.materializedDigestBeforePrompt).toBe(hostCredentialDigest);
        expect(first.reportedErrors).toHaveLength(0);
        expect(
          first.logs.some((args) =>
            JSON.stringify(args).includes(LINKED_ACCOUNT_ID),
          ),
        ).toBe(true);

        // recordUsage is also the Codex token-reconciliation boundary. The
        // canonical linked record must therefore match the materialized copy
        // even if the CLI rotated its one-time refresh token during the turn.
        const canonicalAfterFirst = canonicalAccountDigest();
        expect(first.materializedDigestAfterPrompt).toBe(canonicalAfterFirst);

        const accountHome = path.join(
          liveRoot,
          "auth",
          "_codex-home",
          LINKED_ACCOUNT_ID,
        );
        expect(accountHome.startsWith(path.join(liveRoot, "auth"))).toBe(true);
        rmSync(accountHome, { recursive: true, force: true });
        expect(existsSync(accountHome)).toBe(false);

        __resetDefaultAccountPoolForTests();
        const restartedPool = getDefaultAccountPool();
        const reloaded = restartedPool.get(LINKED_ACCOUNT_ID, "openai-codex");
        expect(reloaded).toMatchObject({
          id: LINKED_ACCOUNT_ID,
          enabled: true,
          health: "ok",
        });
        expect(reloaded?.lastUsedAt).toEqual(expect.any(Number));

        const second = await runLinkedSubscriptionTurn(liveRoot, 2);
        expect(second.accountMetadata).toMatchObject({
          providerId: "openai-codex",
          accountId: LINKED_ACCOUNT_ID,
        });
        expect(second.materializedDigestBeforePrompt).toBe(canonicalAfterFirst);
        expect(second.counterCalls).toBe(first.counterCalls + 1);
        expect(second.counterTokens).toBe(
          first.counterTokens + second.taskUsageTokens,
        );
        expect(second.reportedErrors).toHaveLength(0);
        expect(
          createHash("sha256").update(readFileSync(hostAuthPath)).digest("hex"),
        ).toBe(hostAuthFileDigest);
      },
      LIVE_TIMEOUT_MS * 2 + 90_000,
    );
  },
);
