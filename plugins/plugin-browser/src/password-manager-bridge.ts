/**
 * Provides password-manager metadata and confirmed clipboard delivery without
 * exposing secret fields to callers. 1Password fields use expiring clipboard
 * leases; classic pass owns its native first-line copy and expiry.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "@elizaos/core";
import { leaseCredentialClipboard } from "./credential-clipboard.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PasswordManagerBackend =
  | "1password"
  | "protonpass"
  | "fixture"
  | "none";

export interface PasswordManagerItem {
  id: string;
  title: string;
  url?: string;
  username?: string;
  /** Metadata flag only — the actual password is never returned. */
  hasPassword: boolean;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface PasswordManagerBridgeConfig {
  preferredBackend?: PasswordManagerBackend;
  /** Passed via `op --account`. Sourced from env `ELIZA_1PASSWORD_ACCOUNT`. */
  onePasswordAccount?: string;
  /** Binary override for 1Password CLI (default: "op"). */
  opPath?: string;
  /** Binary override for ProtonPass CLI (default: "protonpass" then "pass"). */
  protonPassPath?: string;
}

export class PasswordManagerError extends Error {
  readonly backend: PasswordManagerBackend;
  readonly cause?: unknown;

  constructor(
    message: string,
    backend: PasswordManagerBackend,
    cause?: unknown,
  ) {
    super(message);
    this.name = "PasswordManagerError";
    this.backend = backend;
    this.cause = cause;
  }
}

const CLIPBOARD_TTL_SECONDS = 30;

const PASSWORD_MANAGER_FIXTURE_ITEMS: ReadonlyArray<PasswordManagerItem> = [
  {
    id: "pm-github",
    title: "GitHub",
    url: "https://github.com/login",
    username: "benchmark-user",
    hasPassword: true,
    tags: ["dev", "github", "code"],
    metadata: { vault: "Mocked Benchmark" },
  },
  {
    id: "pm-google-workspace",
    title: "Google Workspace",
    url: "https://mail.google.com",
    username: "owner@example.com",
    hasPassword: true,
    tags: ["google", "email"],
    metadata: { vault: "Mocked Benchmark" },
  },
  {
    id: "pm-aws-prod",
    title: "AWS Console",
    url: "https://signin.aws.amazon.com",
    username: "infra@example.com",
    hasPassword: true,
    tags: ["aws", "cloud"],
    metadata: { vault: "Mocked Benchmark" },
  },
];

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on" ||
    normalized === "fixture"
  );
}

function isFalsyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off"
  );
}

function isFixturePasswordManagerEnabled(): boolean {
  const explicit = process.env.ELIZA_TEST_PASSWORD_MANAGER_BACKEND;
  if (isFalsyEnv(explicit)) return false;
  if (isTruthyEnv(explicit)) return true;
  return false;
}

function listItemsViaFixture(): PasswordManagerItem[] {
  return PASSWORD_MANAGER_FIXTURE_ITEMS.map((item) => ({
    ...item,
    tags: item.tags ? [...item.tags] : undefined,
    metadata: item.metadata ? { ...item.metadata } : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const detectionCache = new Map<string, PasswordManagerBackend>();

function cacheKey(config?: PasswordManagerBridgeConfig): string {
  const c = config ?? {};
  return [
    c.preferredBackend ?? "",
    c.onePasswordAccount ?? "",
    c.opPath ?? "",
    c.protonPassPath ?? "",
  ].join("|");
}

function resolveOpBinary(config?: PasswordManagerBridgeConfig): string {
  return config?.opPath?.trim() || "op";
}

function resolveProtonPassBinary(config?: PasswordManagerBridgeConfig): string {
  return config?.protonPassPath?.trim() || "protonpass";
}

async function probeBinary(binary: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(binary, args, { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

async function probeOp(config?: PasswordManagerBridgeConfig): Promise<boolean> {
  return probeBinary(resolveOpBinary(config), ["--version"]);
}

async function probeProtonPass(
  config?: PasswordManagerBridgeConfig,
): Promise<boolean> {
  if (await probeBinary(resolveProtonPassBinary(config), ["--version"])) {
    return true;
  }
  // `pass` — classic Unix password-store — also supported as a fallback.
  if (!config?.protonPassPath) {
    return probeBinary("pass", ["--version"]);
  }
  return false;
}

export async function detectPasswordManagerBackend(
  config?: PasswordManagerBridgeConfig,
): Promise<PasswordManagerBackend> {
  const key = cacheKey(config);
  const cached = detectionCache.get(key);
  if (cached !== undefined) return cached;

  const preferred = config?.preferredBackend;
  if (preferred === "none") {
    detectionCache.set(key, "none");
    return "none";
  }
  if (preferred === "fixture") {
    detectionCache.set(key, "fixture");
    return "fixture";
  }
  if (isFixturePasswordManagerEnabled()) {
    detectionCache.set(key, "fixture");
    return "fixture";
  }
  if (preferred === "1password") {
    const ok = await probeOp(config);
    const result: PasswordManagerBackend = ok ? "1password" : "none";
    detectionCache.set(key, result);
    return result;
  }
  if (preferred === "protonpass") {
    const ok = await probeProtonPass(config);
    const result: PasswordManagerBackend = ok ? "protonpass" : "none";
    detectionCache.set(key, result);
    return result;
  }

  if (await probeOp(config)) {
    detectionCache.set(key, "1password");
    return "1password";
  }
  if (await probeProtonPass(config)) {
    detectionCache.set(key, "protonpass");
    return "protonpass";
  }
  detectionCache.set(key, "none");
  return "none";
}

/** Clear the backend detection cache. Exposed for tests. */
export function clearPasswordManagerBackendCache(): void {
  detectionCache.clear();
}

// ---------------------------------------------------------------------------
// 1Password CLI backend
// ---------------------------------------------------------------------------

interface OpItemListEntry {
  id?: string;
  title?: string;
  tags?: string[];
  urls?: Array<{ href?: string; primary?: boolean }>;
  additional_information?: string;
  category?: string;
  vault?: { id?: string; name?: string };
}

function opBaseArgs(config?: PasswordManagerBridgeConfig): string[] {
  const args: string[] = [];
  const account = config?.onePasswordAccount?.trim();
  if (account) args.push("--account", account);
  return args;
}

async function runOp(
  args: string[],
  config?: PasswordManagerBridgeConfig,
): Promise<string> {
  const binary = resolveOpBinary(config);
  const fullArgs = [...opBaseArgs(config), ...args];
  try {
    const { stdout } = await execFileAsync(binary, fullArgs, {
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch {
    // error-policy:J2 Backend diagnostics can contain credentials and stay private.
    throw new PasswordManagerError(
      "1Password CLI failed. Open and unlock 1Password, then try again.",
      "1password",
    );
  }
}

function normalizeOpListEntry(raw: OpItemListEntry): PasswordManagerItem {
  const id = raw.id ?? "";
  if (!id) {
    throw new PasswordManagerError("1Password item missing id", "1password");
  }
  const primaryUrl =
    raw.urls?.find((u) => u.primary)?.href ?? raw.urls?.[0]?.href;
  return {
    id,
    title: raw.title ?? id,
    url: primaryUrl,
    username: raw.additional_information,
    hasPassword: (raw.category ?? "").toUpperCase() === "LOGIN",
    tags: raw.tags,
    metadata: {
      category: raw.category,
      vault: raw.vault?.name,
    },
  };
}

async function listItemsVia1Password(
  config?: PasswordManagerBridgeConfig,
): Promise<PasswordManagerItem[]> {
  const stdout = await runOp(["item", "list", "--format", "json"], config);
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new PasswordManagerError(
      "1Password returned invalid JSON from item list",
      "1password",
      error,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new PasswordManagerError(
      "1Password item list was not an array",
      "1password",
    );
  }
  return (parsed as OpItemListEntry[]).map(normalizeOpListEntry);
}

function matchesQuery(item: PasswordManagerItem, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (item.title.toLowerCase().includes(needle)) return true;
  if (item.url?.toLowerCase().includes(needle)) return true;
  if (item.username?.toLowerCase().includes(needle)) return true;
  if (item.tags?.some((t) => t.toLowerCase().includes(needle))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// ProtonPass / pass backend
// ---------------------------------------------------------------------------
//
// Both `protonpass` and classic `pass` support listing entries by name.
// Neither exposes rich metadata; we emit title-only items with the entry
// path used as the id. Per the contract, we never include plaintext
// secrets in returned objects.

async function listItemsViaProtonPass(
  config?: PasswordManagerBridgeConfig,
): Promise<PasswordManagerItem[]> {
  const binary = resolveProtonPassBinary(config);
  let stdout: string;
  try {
    const result = await execFileAsync(binary, ["list"], {
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    // Try classic `pass` if protonpass failed and user didn't pin a binary.
    if (!config?.protonPassPath) {
      try {
        const result = await execFileAsync("pass", ["ls"], {
          timeout: 10_000,
          maxBuffer: 8 * 1024 * 1024,
        });
        stdout = result.stdout;
      } catch (inner) {
        throw new PasswordManagerError(
          `ProtonPass/pass list failed: ${
            inner instanceof Error ? inner.message : String(inner)
          }`,
          "protonpass",
          inner,
        );
      }
    } else {
      throw new PasswordManagerError(
        `ProtonPass list failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "protonpass",
        error,
      );
    }
  }

  const items: PasswordManagerItem[] = [];
  for (const rawLine of stdout.split("\n")) {
    // Strip tree characters from `pass ls` output (├── └── │ etc.).
    const line = rawLine
      .replace(/[│├└─]+/g, "")
      .replace(/\u00a0/g, " ")
      .trim();
    if (!line) continue;
    if (line.toLowerCase().startsWith("password store")) continue;
    items.push({
      id: line,
      title: line,
      hasPassword: true,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Clipboard injection
// ---------------------------------------------------------------------------

/** Reads one successful provider field before making any clipboard change. */
async function pipeToClipboard(
  producer: { cmd: string; args: string[] },
  backend: PasswordManagerBackend,
): Promise<void> {
  let secret: Buffer;
  try {
    const result = await execFileAsync(producer.cmd, producer.args, {
      encoding: "buffer",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    secret = result.stdout;
  } catch {
    // error-policy:J2 CLI failures may embed plaintext stdout/stderr; never retain them.
    throw new PasswordManagerError(
      "Credential retrieval failed. Unlock your password manager and try again.",
      backend,
    );
  }
  // op emits a line terminator after the field, which is not part of the password.
  if (secret.at(-1) === 10) {
    const end = secret.at(-2) === 13 ? secret.length - 2 : secret.length - 1;
    secret = secret.subarray(0, end);
  }
  if (secret.length === 0) {
    throw new PasswordManagerError(
      "The saved credential field is empty.",
      backend,
    );
  }
  try {
    await leaseCredentialClipboard(secret, CLIPBOARD_TTL_SECONDS * 1000);
  } catch {
    // error-policy:J2 Keep native clipboard diagnostics outside model-facing results.
    throw new PasswordManagerError(
      "Credential clipboard is unavailable. Open your password manager to fill this login.",
      backend,
    );
  }
}

// ---------------------------------------------------------------------------
// Public dispatch
// ---------------------------------------------------------------------------

async function resolveActiveBackend(
  config?: PasswordManagerBridgeConfig,
): Promise<PasswordManagerBackend> {
  const backend = await detectPasswordManagerBackend(config);
  if (backend === "none") {
    throw new PasswordManagerError(
      "No password manager backend available (install 1Password CLI `op` or ProtonPass/`pass`)",
      "none",
    );
  }
  return backend;
}

export async function searchPasswordItems(
  query: string,
  config?: PasswordManagerBridgeConfig,
): Promise<PasswordManagerItem[]> {
  const backend = await resolveActiveBackend(config);
  const items =
    backend === "fixture"
      ? listItemsViaFixture()
      : backend === "1password"
        ? await listItemsVia1Password(config)
        : await listItemsViaProtonPass(config);
  return items.filter((item) => matchesQuery(item, query));
}

export async function listPasswordItems(
  opts: { limit?: number },
  config?: PasswordManagerBridgeConfig,
): Promise<PasswordManagerItem[]> {
  const backend = await resolveActiveBackend(config);
  const items =
    backend === "fixture"
      ? listItemsViaFixture()
      : backend === "1password"
        ? await listItemsVia1Password(config)
        : await listItemsViaProtonPass(config);
  const limit = opts.limit;
  if (typeof limit === "number" && limit >= 0) {
    return items.slice(0, limit);
  }
  return items;
}

export async function injectCredentialToClipboard(
  itemId: string,
  field: "username" | "password",
  config?: PasswordManagerBridgeConfig,
): Promise<{ ok: true; expiresInSeconds: number; fixtureMode?: boolean }> {
  if (!itemId || typeof itemId !== "string") {
    throw new PasswordManagerError(
      "itemId is required",
      config?.preferredBackend ?? "none",
    );
  }
  const backend = await resolveActiveBackend(config);

  if (backend === "fixture") {
    logger.warn(
      {
        itemId,
        field,
        boundary: "browser",
        component: "password-manager-bridge",
      },
      "[password-manager-bridge] fixture backend active: no clipboard write performed. Set ELIZA_TEST_PASSWORD_MANAGER_BACKEND=0 for real injection.",
    );
    return {
      ok: true,
      expiresInSeconds: CLIPBOARD_TTL_SECONDS,
      fixtureMode: true,
    };
  }

  if (backend === "1password") {
    const binary = resolveOpBinary(config);
    const args = [
      ...opBaseArgs(config),
      "item",
      "get",
      itemId,
      "--fields",
      field === "password" ? "password" : "username",
      "--reveal",
    ];
    await pipeToClipboard({ cmd: binary, args }, "1password");
    return { ok: true, expiresInSeconds: CLIPBOARD_TTL_SECONDS };
  }

  // protonpass / pass
  const binary = resolveProtonPassBinary(config);
  // Both `protonpass show <id>` and `pass show <id>` print the secret on the
  // first line. Username retrieval is not uniformly supported in classic
  // pass; callers must store username in the entry body to retrieve it.
  if (field === "username") {
    throw new PasswordManagerError(
      "Username injection is not supported by the ProtonPass/pass backend",
      "protonpass",
    );
  }
  let producerCmd = binary;
  // Fallback to classic `pass` when protonpass isn't pinned and missing.
  if (!config?.protonPassPath) {
    const hasProton = await probeBinary(binary, ["--version"]);
    if (!hasProton) producerCmd = "pass";
  }
  if (producerCmd !== "pass") {
    throw new PasswordManagerError(
      "Use the Proton Pass application to copy or fill credentials; its CLI field format is not supported.",
      "protonpass",
    );
  }
  try {
    await execFileAsync(producerCmd, ["show", "--clip=1", itemId], {
      timeout: 15_000,
      env: {
        ...process.env,
        PASSWORD_STORE_CLIP_TIME: String(CLIPBOARD_TTL_SECONDS),
      },
    });
  } catch {
    // error-policy:J2 pass owns the clipboard lifetime; never expose its subprocess output.
    throw new PasswordManagerError(
      "Password-store clipboard copy failed. Unlock the store and try again.",
      "protonpass",
    );
  }
  return { ok: true, expiresInSeconds: CLIPBOARD_TTL_SECONDS };
}
