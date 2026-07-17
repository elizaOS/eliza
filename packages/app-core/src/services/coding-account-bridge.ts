/**
 * Coding-agent account-selector bridge.
 *
 * The orchestrator plugin (`@elizaos/plugin-agent-orchestrator`) spawns Claude
 * Code / Codex / OpenCode sub-agents but depends only on `@elizaos/core` — it
 * cannot import the `AccountPool` or the credential store. So, exactly like the
 * Anthropic and subscription-selector bridges in `account-pool.ts`, we publish a
 * narrow contract on a `globalThis` symbol that the plugin reads at spawn time.
 *
 * Responsibilities:
 *  - Map a coding-agent type ("claude" / "codex" / …) to its candidate provider
 *    ids and pick one account from the pool (default `least-used`).
 *  - Resolve that account's credential and return the env vars the spawned
 *    coding-agent subprocess needs to authenticate AS THAT ACCOUNT:
 *      claude  → `CLAUDE_CODE_OAUTH_TOKEN`
 *      codex   → a per-account `CODEX_HOME` dir holding an `auth.json`
 *      *-api   → the provider's direct API-key env var
 *  - Record usage + health back into the pool keyed by the serving account.
 *
 * Subscription tokens only ever leave this layer to flow into the first-party
 * coding subprocess (which IS Claude Code / Codex) — never into the runtime's
 * own `process.env`. That respects the providers' TOS the same way
 * `applySubscriptionCredentialsLocal` does.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAccount } from "@elizaos/auth/account-storage";
import {
  type AccessTokenOutcome,
  getAccessToken,
  saveCredentials,
} from "@elizaos/auth/credentials";
import { probeDirectApiKey } from "@elizaos/auth/direct-api-probe";
import { accountRefreshMutex } from "@elizaos/auth/refresh-mutex";
import type { DirectAccountProvider } from "@elizaos/auth/types";
import {
  DIRECT_ACCOUNT_PROVIDER_ENV,
  isDirectAccountProvider,
  isSubscriptionProvider,
} from "@elizaos/auth/types";
import {
  type CodingAgentSelectorBridge,
  type CodingProviderAvailability,
  ElizaError,
  logger,
  resolveStateDir,
  setCodingAgentSelectorBridge,
} from "@elizaos/core";
import type { LinkedAccountProviderId } from "@elizaos/shared/contracts/service-routing";
import {
  type AccountPool,
  isAccountSelectableNow,
  type Strategy,
  selectionForProvider,
} from "./account-pool.js";
import {
  claudeMinRemainingMs,
  resolveClaudeExpectedRunMs,
} from "./claude-token-refresh.js";

const VALID_CODING_STRATEGIES = new Set<Strategy>([
  "priority",
  "round-robin",
  "least-used",
  "quota-aware",
  "reset-soonest",
  "drain-soonest-reset",
]);

/** Last-resort strategy — the ELIZA_CODING_ACCOUNT_STRATEGY env var, else least-used. */
function getDefaultCodingStrategy(): Strategy {
  const env =
    typeof process !== "undefined"
      ? process.env.ELIZA_CODING_ACCOUNT_STRATEGY?.trim()
      : undefined;
  if (!env) return "least-used";
  if (VALID_CODING_STRATEGIES.has(env as Strategy)) return env as Strategy;
  logger.warn(
    `[coding-account-bridge] ignoring invalid ELIZA_CODING_ACCOUNT_STRATEGY=${JSON.stringify(
      env,
    )}; using least-used`,
  );
  return "least-used";
}

/**
 * Ordered provider candidates per coding-agent type. The first provider with an
 * eligible account wins; a subscription provider is preferred over its direct
 * API equivalent (subscriptions are the primary use case here).
 *
 * claude (claude-agent-acp) and codex (codex-acp) are first-party CLIs.
 * opencode authenticates through its configured backend; the only backend it
 * resolves from a pooled key is Cerebras (`CEREBRAS_API_KEY`, see
 * buildOpencodeSpawnConfig), so opencode pool-rotates across `cerebras-api`
 * accounts and no-ops otherwise. z.ai / Kimi / GLM have no first-party coding
 * CLI — their accounts serve the main runtime's API-key routing — so they are
 * deliberately absent (advertising them would offer an unspawnable path).
 */
const AGENT_PROVIDER_CANDIDATES: Readonly<
  Record<string, readonly LinkedAccountProviderId[]>
> = {
  claude: ["anthropic-subscription", "anthropic-api"],
  codex: ["openai-codex", "openai-api"],
  opencode: ["cerebras-api"],
};

function candidatesFor(agentType: string): readonly LinkedAccountProviderId[] {
  return AGENT_PROVIDER_CANDIDATES[agentType.toLowerCase()] ?? [];
}

/**
 * Whether a token-resolve failure is a genuine auth problem (→ needs-reauth)
 * vs a transient network/5xx blip. A transient failure must NOT sideline a
 * healthy account — that would exclude it from the pool until the next
 * keep-alive sweep (~5 min). `undefined` (getAccessToken returned null without
 * throwing) means no credential is present at all → genuine needs-reauth.
 */
const AUTH_FAILURE_PATTERN =
  /\b(40[13]|invalid[_ ]?grant|invalid[_ ]?token|unauthor|forbidden|re-?auth|revoked|expired)\b/i;
export function isAuthFailure(err: unknown): boolean {
  if (err === undefined) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return AUTH_FAILURE_PATTERN.test(msg);
}

function accessTokenFailureIsAuth(
  outcome: AccessTokenOutcome | undefined,
  err?: unknown,
): boolean {
  if (outcome && !outcome.ok) return outcome.kind === "auth";
  return isAuthFailure(err);
}

function codexHomeDir(accountId: string): string {
  return path.join(
    process.env.ELIZA_HOME || resolveStateDir(),
    "auth",
    "_codex-home",
    accountId,
  );
}

function codexGenerationDir(accountId: string, refreshToken: string): string {
  const generation = createHash("sha256")
    .update(refreshToken)
    .digest("hex")
    .slice(0, 24);
  return path.join(codexHomeDir(accountId), "generations", generation);
}

const CODEX_ACTIVE_HOME_FILE = "active-home";
const CODEX_GENERATION_NAME_PATTERN = /^[a-f0-9]{24}$/;

/** Decode the `exp` claim (epoch ms) from a JWT access token, or null. */
function jwtExpiryMs(accessToken: string): number | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8"),
    ) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : null;
  } catch {
    // error-policy:J3 untrusted JWT payload — an undecodable segment yields a
    // null expiry (caller treats as "unknown/expired"), not a fake timestamp.
    return null;
  }
}

/** Credential fields read from a ChatGPT-mode Codex `auth.json`. */
interface MaterializedCodexAuthJson {
  tokens: {
    access_token: string;
    refresh_token: string;
    id_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

interface MaterializedCodexAuthCandidate {
  authPath: string;
  homeDir: string;
  auth: MaterializedCodexAuthJson;
  lastRefreshMs: number | null;
}

type CodexAuthParseResult =
  | { ok: true; value: MaterializedCodexAuthJson }
  | { ok: false; error: Error };

const CODEX_AUTH_STABLE_READ_ATTEMPTS = 20;
const CODEX_AUTH_STABLE_READ_DELAY_MS = 10;

function parseMaterializedCodexAuth(
  raw: string,
  authPath: string,
): CodexAuthParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    // error-policy:J3 auth.json is maintained by an external process; malformed
    // JSON is an explicit invalid read so the stable-reader can retry or fail.
    return {
      ok: false,
      error: new ElizaError(`Codex auth file is malformed: ${authPath}`, {
        code: "CODEX_AUTH_FILE_INVALID",
        cause,
        context: { authPath },
        severity: "fatal",
      }),
    };
  }
  if (typeof value !== "object" || value === null) {
    return {
      ok: false,
      error: new ElizaError(
        `Codex auth file has the wrong shape: ${authPath}`,
        {
          code: "CODEX_AUTH_FILE_INVALID",
          context: { authPath },
          severity: "fatal",
        },
      ),
    };
  }
  const tokens = Reflect.get(value, "tokens");
  if (typeof tokens !== "object" || tokens === null) {
    return {
      ok: false,
      error: new ElizaError(
        `Codex auth file is missing its token pair: ${authPath}`,
        {
          code: "CODEX_AUTH_FILE_INVALID",
          context: { authPath },
          severity: "fatal",
        },
      ),
    };
  }
  const accessToken = Reflect.get(tokens, "access_token");
  const refreshToken = Reflect.get(tokens, "refresh_token");
  const idToken = Reflect.get(tokens, "id_token");
  const lastRefresh = Reflect.get(value, "last_refresh");
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof refreshToken !== "string" ||
    refreshToken.length === 0 ||
    (idToken !== undefined && typeof idToken !== "string") ||
    (lastRefresh !== undefined && typeof lastRefresh !== "string")
  ) {
    return {
      ok: false,
      error: new ElizaError(
        `Codex auth file contains an invalid token generation: ${authPath}`,
        {
          code: "CODEX_AUTH_FILE_INVALID",
          context: { authPath },
          severity: "fatal",
        },
      ),
    };
  }
  return {
    ok: true,
    value: {
      tokens: {
        access_token: accessToken,
        refresh_token: refreshToken,
        ...(idToken ? { id_token: idToken } : {}),
      },
      ...(lastRefresh ? { last_refresh: lastRefresh } : {}),
    },
  };
}

function sameFileGeneration(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function readStableCodexAuth(
  homeDir: string,
): Promise<MaterializedCodexAuthCandidate> {
  const authPath = path.join(homeDir, "auth.json");
  let lastInvalid: Error | undefined;
  for (let attempt = 0; attempt < CODEX_AUTH_STABLE_READ_ATTEMPTS; attempt++) {
    const before = statSync(authPath);
    const raw = readFileSync(authPath, "utf-8");
    const after = statSync(authPath);
    const parsed = parseMaterializedCodexAuth(raw, authPath);
    if (sameFileGeneration(before, after) && parsed.ok) {
      const rawLastRefresh = parsed.value.last_refresh;
      const parsedLastRefresh = rawLastRefresh
        ? Date.parse(rawLastRefresh)
        : Number.NaN;
      return {
        authPath,
        homeDir,
        auth: parsed.value,
        lastRefreshMs: Number.isFinite(parsedLastRefresh)
          ? parsedLastRefresh
          : null,
      };
    }
    if (!parsed.ok) lastInvalid = parsed.error;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, CODEX_AUTH_STABLE_READ_DELAY_MS),
    );
  }
  throw new ElizaError(
    `Codex auth file did not reach a valid stable generation: ${authPath}`,
    {
      code: "CODEX_AUTH_FILE_UNSTABLE",
      ...(lastInvalid ? { cause: lastInvalid } : {}),
      context: { authPath },
      severity: "fatal",
    },
  );
}

function listCodexHomeCandidates(accountId: string): string[] {
  const accountHome = codexHomeDir(accountId);
  const homes: string[] = [];
  if (existsSync(path.join(accountHome, "auth.json"))) homes.push(accountHome);
  const generationsDir = path.join(accountHome, "generations");
  if (!existsSync(generationsDir)) return homes;
  for (const entry of readdirSync(generationsDir, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      CODEX_GENERATION_NAME_PATTERN.test(entry.name) &&
      existsSync(path.join(generationsDir, entry.name, "auth.json"))
    ) {
      homes.push(path.join(generationsDir, entry.name));
    }
  }
  return homes;
}

function publishJsonExclusive(filePath: string, value: unknown): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(value, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    // A hard-link is an atomic no-replace publish. Unlike rename(), it cannot
    // overwrite a generation an external runtime has already handed to Codex.
    linkSync(tmpPath, filePath);
  } catch (cause) {
    // error-policy:J2 the credential-file boundary adds the target path while
    // preserving the filesystem failure; callers must fail the selection.
    throw new ElizaError(
      `Could not publish Codex auth generation: ${filePath}`,
      {
        code: "CODEX_AUTH_GENERATION_PUBLISH_FAILED",
        cause,
        context: { filePath },
        severity: "fatal",
      },
    );
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

function canonicalCodexAuth(
  accountId: string,
  record: NonNullable<ReturnType<typeof loadAccount>>,
): MaterializedCodexAuthJson & Record<string, unknown> {
  const { access, refresh, idToken } = record.credentials;
  if (!access || !refresh) {
    throw new ElizaError(
      `openai-codex account "${accountId}" is missing a complete token pair`,
      {
        code: "CODEX_CANONICAL_CREDENTIAL_MISSING",
        context: { accountId },
        severity: "fatal",
      },
    );
  }
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      ...(idToken ? { id_token: idToken } : {}),
      access_token: access,
      refresh_token: refresh,
      ...(record.organizationId ? { account_id: record.organizationId } : {}),
    },
    // This is the canonical record's observed write time, not materialization
    // time. Re-materialization therefore cannot masquerade as a newer OAuth
    // generation and eclipse a concurrent Codex rotation.
    last_refresh: new Date(record.updatedAt).toISOString(),
  };
}

async function createCanonicalCodexHome(
  accountId: string,
  record: NonNullable<ReturnType<typeof loadAccount>>,
): Promise<MaterializedCodexAuthCandidate> {
  const refreshToken = record.credentials.refresh;
  if (!refreshToken) {
    throw new ElizaError(
      `openai-codex account "${accountId}" is missing a refresh token`,
      {
        code: "CODEX_CANONICAL_CREDENTIAL_MISSING",
        context: { accountId },
        severity: "fatal",
      },
    );
  }
  const homeDir = codexGenerationDir(accountId, refreshToken);
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const authPath = path.join(homeDir, "auth.json");
  if (!existsSync(authPath)) {
    publishJsonExclusive(authPath, canonicalCodexAuth(accountId, record));
  }
  const candidate = await readStableCodexAuth(homeDir);
  if (candidate.auth.tokens.refresh_token !== refreshToken) {
    throw new ElizaError(
      `Codex auth generation does not match its canonical generation: ${authPath}`,
      {
        code: "CODEX_AUTH_GENERATION_MISMATCH",
        context: { accountId, authPath },
        severity: "fatal",
      },
    );
  }
  return candidate;
}

interface CodexReconciliation {
  adopted: boolean;
  candidate: MaterializedCodexAuthCandidate | null;
  record: NonNullable<ReturnType<typeof loadAccount>>;
}

async function reconcileCodexTokensLocked(
  accountId: string,
): Promise<CodexReconciliation> {
  const record = loadAccount("openai-codex", accountId);
  if (!record) {
    throw new ElizaError(`openai-codex account "${accountId}" is missing`, {
      code: "CODEX_CANONICAL_CREDENTIAL_MISSING",
      context: { accountId },
      severity: "fatal",
    });
  }
  const candidates: MaterializedCodexAuthCandidate[] = [];
  for (const homeDir of listCodexHomeCandidates(accountId)) {
    candidates.push(await readStableCodexAuth(homeDir));
  }
  const matching = candidates.filter(
    (candidate) =>
      candidate.auth.tokens.refresh_token === record.credentials.refresh,
  );
  const divergent = candidates.filter(
    (candidate) =>
      candidate.auth.tokens.refresh_token !== record.credentials.refresh,
  );
  for (const candidate of divergent) {
    if (candidate.lastRefreshMs === null) {
      throw new ElizaError(
        `Codex auth generation cannot be ordered safely: ${candidate.authPath}`,
        {
          code: "CODEX_AUTH_GENERATION_AMBIGUOUS",
          context: { accountId, authPath: candidate.authPath },
          severity: "fatal",
        },
      );
    }
  }
  const newer = divergent
    .filter(
      (candidate) =>
        candidate.lastRefreshMs !== null &&
        candidate.lastRefreshMs > record.updatedAt,
    )
    .sort(
      (left, right) =>
        (right.lastRefreshMs ?? Number.NEGATIVE_INFINITY) -
        (left.lastRefreshMs ?? Number.NEGATIVE_INFINITY),
    );
  const newest = newer[0];
  const equallyNew = newest
    ? newer.find(
        (candidate) =>
          candidate !== newest &&
          candidate.lastRefreshMs === newest.lastRefreshMs &&
          candidate.auth.tokens.refresh_token !==
            newest.auth.tokens.refresh_token,
      )
    : undefined;
  if (newest && equallyNew) {
    throw new ElizaError(
      `Codex auth generations have an ambiguous refresh order for account "${accountId}"`,
      {
        code: "CODEX_AUTH_GENERATION_AMBIGUOUS",
        context: {
          accountId,
          authPaths: [newest.authPath, equallyNew.authPath],
        },
        severity: "fatal",
      },
    );
  }
  if (newest) {
    const tokens = newest.auth.tokens;
    saveCredentials(
      "openai-codex",
      {
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires: jwtExpiryMs(tokens.access_token) ?? Date.now(),
        ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
      },
      accountId,
    );
    const adoptedRecord = loadAccount("openai-codex", accountId);
    if (!adoptedRecord) {
      throw new ElizaError(
        `Adopted Codex credentials could not be reloaded for account "${accountId}"`,
        {
          code: "CODEX_CANONICAL_CREDENTIAL_MISSING",
          context: { accountId },
          severity: "fatal",
        },
      );
    }
    logger.info(
      `[coding-account-bridge] adopted rotated Codex tokens from CODEX_HOME for account "${accountId}" (CLI self-refresh)`,
    );
    return { adopted: true, candidate: newest, record: adoptedRecord };
  }
  const candidate = matching.sort(
    (left, right) =>
      (right.lastRefreshMs ?? Number.NEGATIVE_INFINITY) -
      (left.lastRefreshMs ?? Number.NEGATIVE_INFINITY),
  )[0];
  return { adopted: false, candidate: candidate ?? null, record };
}

/**
 * Adopt tokens a spawned Codex CLI rotated inside its per-account CODEX_HOME
 * back into the canonical account record.
 *
 * OpenAI refresh tokens are ONE-TIME-USE: when a long-running Codex session
 * self-refreshes, it writes the rotated pair to `CODEX_HOME/auth.json` only —
 * the canonical record at `auth/openai-codex/{accountId}.json` is left holding
 * an already-consumed refresh token. Every later canonical refresh (next
 * spawn's `getAccessToken`, the keep-alive usage sweep) then fails with
 * `invalid_grant` and the account is marked needs-reauth — forcing a manual
 * re-login even though the CLI's copy holds perfectly good tokens. Calling
 * this before any canonical token resolution heals that drift.
 *
 * Serialized on the same per-account refresh mutex as `getAccessToken` so an
 * adoption can't interleave with an in-flight canonical refresh.
 */
export async function adoptRotatedCodexTokens(
  accountId: string,
): Promise<boolean> {
  return accountRefreshMutex.acquire(`openai-codex:${accountId}`, async () => {
    const reconciled = await reconcileCodexTokensLocked(accountId);
    return reconciled.adopted;
  });
}

/**
 * Reasoning-effort values the Codex model catalog knows. Codex itself silently
 * accepts an invalid `model_reasoning_effort`, so validation is on us: an
 * unknown operator value is warned about and dropped, never interpolated.
 */
const CODEX_EFFORT_VALUES: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

/**
 * Effort values guaranteed by the managed Codex ACP contract across linked
 * account spawns. The catalog recognizes newer variants for other consumers,
 * but this bridge withholds them until the managed adapter path supports them
 * end to end so a generated CODEX_HOME never advertises an unhonored setting.
 */
const MANAGED_CODEX_ACP_EFFORTS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
]);

function resolveCodexConfig(): string {
  // Codex reads its model from CODEX_HOME/config.toml; with none, codex-acp
  // falls back to a built-in default (e.g. gpt-5.3-codex) that ChatGPT-account
  // auth rejects ("model is not supported when using Codex with a ChatGPT
  // account"). Write a MINIMAL config.toml — the model plus an optional
  // validated reasoning effort — reusing the operator's working model
  // (extracted from ~/.codex/config.toml) but NOT the rest of their config,
  // which can carry unrelated interactive-only settings. Falls back to a
  // compatible default.
  // Resolution order: explicit env pin > app-configured model (what
  // POST /api/models/config writes for the codex coding target) > the
  // operator's machine config > the compatible default. Without the POWERFUL
  // read here, the app-configured model is a dead-end key.
  let model: string | undefined;
  for (const key of ["ELIZA_CODEX_MODEL", "ELIZA_CODEX_MODEL_POWERFUL"]) {
    const candidate = process.env[key]?.trim();
    if (!candidate) continue;
    // A model is interpolated into TOML, so reject characters that could break
    // out of the string rather than trying to escape a broader grammar here.
    if (!/^[\w.:/-]+$/.test(candidate)) {
      logger.warn(
        `[coding-account-bridge] ignoring malformed ${key}=${JSON.stringify(candidate)}`,
      );
      continue;
    }
    model = candidate;
    break;
  }
  if (!model) {
    const machineConfig = path.join(os.homedir(), ".codex", "config.toml");
    if (existsSync(machineConfig)) {
      // Accept both double- and single-quoted TOML strings. The captured value
      // cannot contain its delimiter, so re-emitting double-quoted is safe.
      const match = readFileSync(machineConfig, "utf-8").match(
        /^\s*model\s*=\s*["']([^"']+)["']/m,
      );
      if (match?.[1]) model = match[1];
    }
  }
  let effort = process.env.ELIZA_CODEX_EFFORT?.trim().toLowerCase();
  if (effort && !CODEX_EFFORT_VALUES.has(effort)) {
    // error-policy:J7 invalid operator input is omitted so the required model
    // and credential-store pins remain usable and the rejection is observable.
    logger.warn(
      `[coding-account-bridge] ignoring invalid ELIZA_CODEX_EFFORT=${JSON.stringify(effort)} (expected low|medium|high|xhigh|max|ultra)`,
    );
    effort = undefined;
  } else if (effort && !MANAGED_CODEX_ACP_EFFORTS.has(effort)) {
    // error-policy:J7 see MANAGED_CODEX_ACP_EFFORTS — writing max/ultra would
    // fail the adapter's whole config parse and discard both safety pins.
    logger.warn(
      `[coding-account-bridge] ELIZA_CODEX_EFFORT=${JSON.stringify(effort)} is not supported by the managed codex-acp contract (supported: low|medium|high|xhigh); omitting model_reasoning_effort so config.toml stays loadable`,
    );
    effort = undefined;
  }
  return `model = "${model || "gpt-5.6-sol"}"\ncli_auth_credentials_store = "file"\n${
    effort ? `model_reasoning_effort = "${effort}"\n` : ""
  }`;
}

function materializeRequiredTextFile(
  targetPath: string,
  contents: string,
  errorCode:
    | "CODEX_CONFIG_MATERIALIZATION_FAILED"
    | "CODEX_ACTIVE_HOME_MATERIALIZATION_FAILED",
  description: string,
): void {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    if (
      existsSync(targetPath) &&
      readFileSync(targetPath, "utf-8") === contents
    ) {
      return;
    }
    writeFileSync(tmpPath, contents, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(tmpPath, targetPath);
    if (readFileSync(targetPath, "utf-8") !== contents) {
      throw new ElizaError(
        `Codex ${description} verification failed after materialization: ${targetPath}`,
        {
          code: errorCode,
          context: { targetPath },
          severity: "fatal",
        },
      );
    }
  } catch (cause) {
    // error-policy:J2 both config and active-home publication are part of the
    // auth-safety boundary, so the spawn must not proceed on filesystem error.
    throw new ElizaError(
      `Could not materialize required Codex ${description}: ${targetPath}`,
      {
        code: errorCode,
        cause,
        context: { targetPath },
        severity: "fatal",
      },
    );
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

function materializeRequiredCodexConfig(homeDir: string): void {
  materializeRequiredTextFile(
    path.join(homeDir, "config.toml"),
    resolveCodexConfig(),
    "CODEX_CONFIG_MATERIALIZATION_FAILED",
    "config",
  );
}

function publishActiveCodexHome(accountId: string, homeDir: string): void {
  const accountHome = codexHomeDir(accountId);
  const relativeHome = path.relative(accountHome, homeDir);
  if (
    relativeHome.startsWith(`..${path.sep}`) ||
    relativeHome === ".." ||
    path.isAbsolute(relativeHome)
  ) {
    throw new ElizaError(`Codex home is outside its account root: ${homeDir}`, {
      code: "CODEX_ACTIVE_HOME_MATERIALIZATION_FAILED",
      context: { accountId, homeDir },
      severity: "fatal",
    });
  }
  // The benchmark harness cannot infer which historical token generation is
  // canonical without reading secrets, so publish a non-secret relative path.
  materializeRequiredTextFile(
    path.join(accountHome, CODEX_ACTIVE_HOME_FILE),
    `${relativeHome || "."}\n`,
    "CODEX_ACTIVE_HOME_MATERIALIZATION_FAILED",
    "active-home pointer",
  );
}

/**
 * Reconcile a Codex-owned token generation and return a safe `CODEX_HOME`.
 * Existing auth files are immutable from the bridge's perspective: Codex may
 * be refreshing one in another process, so only Codex writes an already-
 * published generation. A newer canonical login gets a new generation path.
 */
async function materializeCodexHome(accountId: string): Promise<string> {
  return accountRefreshMutex.acquire(`openai-codex:${accountId}`, async () => {
    const reconciled = await reconcileCodexTokensLocked(accountId);
    const candidate =
      reconciled.candidate ??
      (await createCanonicalCodexHome(accountId, reconciled.record));
    materializeRequiredCodexConfig(candidate.homeDir);
    publishActiveCodexHome(accountId, candidate.homeDir);
    return candidate.homeDir;
  });
}

async function buildEnvPatch(
  providerId: LinkedAccountProviderId,
  accessToken: string,
): Promise<Record<string, string>> {
  switch (providerId) {
    case "anthropic-subscription":
      return { CLAUDE_CODE_OAUTH_TOKEN: accessToken };
    default: {
      // Direct API providers (e.g. cerebras-api → CEREBRAS_API_KEY for opencode)
      // inject under their canonical env key; run-main.ts normalizes aliases
      // (Z_AI_API_KEY → ZAI_API_KEY, KIMI_API_KEY → MOONSHOT_API_KEY).
      const envKey =
        DIRECT_ACCOUNT_PROVIDER_ENV[providerId as DirectAccountProvider];
      return envKey ? { [envKey]: accessToken } : {};
    }
  }
}

function makeBridge(pool: AccountPool): CodingAgentSelectorBridge {
  return {
    describe() {
      const out: Record<string, CodingProviderAvailability[]> = {};
      const now = Date.now();
      for (const [agentType, providers] of Object.entries(
        AGENT_PROVIDER_CANDIDATES,
      )) {
        out[agentType] = providers.map((providerId) => {
          const accounts = pool.list(providerId);
          return {
            providerId,
            total: accounts.length,
            enabled: accounts.filter((a) => a.enabled).length,
            // `healthy` must match select()'s own eligibility gate — the
            // SubAgentRouter's failover gate and the readiness verdicts read
            // this count, so a rate-limited account whose reset has elapsed
            // (selectable again) must not be reported as unavailable.
            healthy: accounts.filter(
              (a) => a.enabled && isAccountSelectableNow(a, now),
            ).length,
          };
        });
      }
      return out;
    },

    async select(agentType, opts) {
      const candidates = candidatesFor(agentType);
      if (candidates.length === 0) return null;
      for (const providerId of candidates) {
        // Explicit caller override > the app's per-provider
        // config.accountStrategies (same live selectionForProvider read the
        // anthropic/subscription bridges use, so the rotation-strategy picker
        // steers coding spawns too) > ELIZA_CODING_ACCOUNT_STRATEGY env >
        // least-used. Strategy only — the llmText route's accountIds pin the
        // chat brain's account, not coding sub-agents.
        const strategy =
          opts?.strategy ??
          selectionForProvider(providerId).strategy ??
          getDefaultCodingStrategy();
        const account = await pool.select({
          providerId,
          strategy,
          ...(opts?.sessionKey ? { sessionKey: opts.sessionKey } : {}),
          ...(opts?.exclude ? { exclude: opts.exclude } : {}),
          ...(opts?.model ? { model: opts.model } : {}),
          // Follow-up pin: a continuing session restricts the pool to its
          // spawn-time account so an expired session-affinity can't strategy-
          // drift the subprocess onto a sibling (billing/health stay keyed to
          // the account actually serving). Null when the pin is unselectable.
          ...(opts?.accountIds ? { accountIds: opts.accountIds } : {}),
        });
        if (!account) continue;
        let envPatch: Record<string, string>;
        if (providerId === "openai-codex") {
          // CODEX_HOME is the refresh authority for a running Codex process.
          // Reconcile and select its immutable generation before any canonical
          // refresh can present an already-consumed one-time token.
          envPatch = { CODEX_HOME: await materializeCodexHome(account.id) };
        } else {
          // Claude coding spawns get a bare token the third-party adapter reads
          // once and cannot refresh, so widen the freshness window to the
          // expected run duration before injecting it.
          const resolveOpts =
            providerId === "anthropic-subscription"
              ? {
                  minRemainingMs: claudeMinRemainingMs(
                    resolveClaudeExpectedRunMs((key) => process.env[key]),
                  ),
                }
              : undefined;
          let accessToken: string | null = null;
          let resolveOutcome: AccessTokenOutcome | undefined;
          let resolveError: unknown;
          try {
            resolveOutcome = await getAccessToken(providerId, account.id, {
              ...resolveOpts,
              outcome: true,
            });
            accessToken = resolveOutcome.ok ? resolveOutcome.accessToken : null;
            // A widened Claude resolve is only a freshness preference. The
            // default-buffer retry preserves a still-valid shorter-lived token
            // when proactive refresh is transiently unavailable.
            if (
              accessToken === null &&
              resolveOpts &&
              resolveOutcome &&
              !resolveOutcome.ok &&
              resolveOutcome.kind !== "auth"
            ) {
              const stillValid = await getAccessToken(providerId, account.id, {
                outcome: true,
              });
              resolveOutcome = stillValid;
              if (stillValid.ok) {
                logger.info(
                  `[coding-account-bridge] proactive refresh for ${providerId}/${account.id} did not yield a fresh token; using the still-valid shorter-TTL token (a long run may hit the typed expiry signal)`,
                );
                accessToken = stillValid.accessToken;
              }
            }
          } catch (err) {
            resolveError = err;
            logger.warn(
              `[coding-account-bridge] token resolve failed for ${providerId}/${account.id}: ${String(err)}`,
            );
          }
          if (!accessToken) {
            // Only flag for re-auth on a genuine auth failure; a transient
            // network/5xx blip must not pull a healthy account out of rotation.
            if (accessTokenFailureIsAuth(resolveOutcome, resolveError)) {
              await pool.markNeedsReauth(
                account.id,
                "No valid credential / token refresh failed",
                { providerId },
              );
            }
            continue;
          }
          envPatch = await buildEnvPatch(providerId, accessToken);
          if (Object.keys(envPatch).length === 0) {
            continue;
          }
        }
        const source: "oauth" | "api-key" = isSubscriptionProvider(providerId)
          ? "oauth"
          : "api-key";
        logger.info(
          `[coding-account-bridge] ${agentType} → ${providerId} account "${account.label}" (${account.id}) via ${strategy}`,
        );
        return {
          providerId,
          accountId: account.id,
          label: account.label,
          source,
          strategy,
          ...(account.usage ? { usage: account.usage } : {}),
          envPatch,
        };
      }
      return null;
    },

    markRateLimited(
      providerId: LinkedAccountProviderId,
      accountId,
      untilMs,
      detail,
    ) {
      return pool.markRateLimited(accountId, untilMs, detail, { providerId });
    },
    async markNeedsReauth(
      providerId: LinkedAccountProviderId,
      accountId,
      detail,
    ) {
      // Session-level auth failures can come from an injected token aging out.
      // Verify the stored credential before evicting the account from rotation.
      if (providerId === "openai-codex") {
        await adoptRotatedCodexTokens(accountId);
      }
      try {
        const tokenOutcome = await getAccessToken(providerId, accountId, {
          outcome: true,
        });
        if (tokenOutcome.ok) {
          const token = tokenOutcome.accessToken;
          if (isSubscriptionProvider(providerId)) {
            const record = pool.get(accountId, providerId);
            await pool.refreshUsage(accountId, token, {
              providerId,
              ...(record?.organizationId
                ? { codexAccountId: record.organizationId }
                : {}),
            });
          } else if (isDirectAccountProvider(providerId)) {
            // #11033 regression fix: a direct-API key resolves offline from
            // local storage with a never-expires sentinel, so a successful
            // `getAccessToken` proves NOTHING — a cached-but-revoked key that
            // just 401'd a session would otherwise be logged "verified" and
            // kept in rotation forever (doomed failover respawns). Probe it
            // against the provider; only a real 2xx keeps it, a 401/403 falls
            // through to markNeedsReauth. A network/timeout blip (status 0)
            // is inconclusive → leave rotation state to the keep-alive sweep.
            const probe = await probeDirectApiKey(providerId, token);
            if (!probe.ok) {
              if (probe.status === 401 || probe.status === 403) {
                return pool.markNeedsReauth(accountId, detail, { providerId });
              }
              logger.info(
                `[coding-account-bridge] ${providerId}/${accountId} auth-failure verify was inconclusive (probe status ${probe.status}${probe.error ? `: ${probe.error}` : ""}) — leaving rotation state to the keep-alive sweep`,
              );
              return;
            }
          }
          logger.info(
            `[coding-account-bridge] ${providerId}/${accountId} reported an auth failure but its credential verifies — keeping it in rotation (injected token likely expired mid-session)${detail ? `: ${detail}` : ""}`,
          );
          return;
        }
        if (tokenOutcome.kind !== "auth") {
          logger.info(
            `[coding-account-bridge] ${providerId}/${accountId} auth-failure verify did not produce a reauth failure (${tokenOutcome.kind}) — leaving rotation state to the keep-alive sweep`,
          );
          return;
        }
      } catch (err) {
        if (!isAuthFailure(err)) {
          logger.info(
            `[coding-account-bridge] ${providerId}/${accountId} auth-failure verify hit a transient error (${String(err)}) — leaving rotation state to the keep-alive sweep`,
          );
          return;
        }
      }
      return pool.markNeedsReauth(accountId, detail, { providerId });
    },
    async recordUsage(providerId: LinkedAccountProviderId, accountId, result) {
      // Session end is the natural sync point for tokens a Codex CLI rotated
      // mid-run — heal the canonical record before the next sweep refreshes
      // against the consumed one.
      if (providerId === "openai-codex") {
        await adoptRotatedCodexTokens(accountId);
      }
      return pool.recordCall(accountId, result, { providerId });
    },
  };
}

/**
 * Install the coding-agent selector bridge. Idempotent — called from
 * `getDefaultAccountPool()` so it is present before the first spawn. The
 * symbol + accessors live in `@elizaos/core` so producer and plugin consumers
 * share one contract.
 */
export function installCodingAgentSelectorBridge(pool: AccountPool): void {
  setCodingAgentSelectorBridge(makeBridge(pool));
}

export { getCodingAgentSelectorBridge } from "@elizaos/core";
