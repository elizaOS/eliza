import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Effect } from "effect/Effect";

export type StageTarget =
  | { readonly kind: "dev"; readonly stage: `dev_${string}`; readonly user: string; readonly worktree: string }
  | { readonly kind: "test"; readonly stage: `test_${string}`; readonly user: string; readonly worktree: string }
  | { readonly kind: "preview"; readonly stage: `pr-${number}`; readonly pr: number }
  | { readonly kind: "staging"; readonly stage: "staging" }
  | { readonly kind: "production"; readonly stage: "production" };

export interface ResolveStageOptions {
  readonly stage?: string;
  readonly mode?: "dev" | "test";
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface StageGuardInput {
  readonly resourceIds?: Readonly<Record<string, string | undefined>>;
  readonly domains?: readonly string[];
  readonly productionIds?: readonly string[];
  readonly productionDomains?: readonly string[];
  readonly allowProduction?: boolean;
}

export class StageGuardError extends Error {
  readonly stage: string;
  readonly violations: readonly string[];

  constructor(stage: string, violations: readonly string[]) {
    super(`Stage guard rejected deploy to "${stage}": ${violations.join("; ")}`);
    this.name = "StageGuardError";
    this.stage = stage;
    this.violations = violations;
  }
}

export interface HashedAssetDirectory {
  readonly directory: string;
  readonly path: string;
  readonly hash: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface EndpointCheck {
  readonly path: string;
  readonly method?: "GET" | "HEAD" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly expectedStatus?: number | readonly number[];
  readonly expectedHeaders?: Readonly<Record<string, string | RegExp>>;
  readonly bodyIncludes?: readonly string[];
  readonly expectJson?: (parsed: unknown) => boolean | string;
  readonly expectedCommitSha?: string;
}

export interface VerifyDeploymentOptions {
  readonly maxAttempts?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly timeoutMs?: number;
  readonly commitSha?: string;
  readonly assetHash?: string;
  readonly throwOnFailure?: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface EndpointProbeResult {
  readonly url: string;
  readonly method: string;
  readonly ok: boolean;
  readonly status: number;
  readonly attempts: number;
  readonly durationMs: number;
  readonly error?: string;
}

export interface DeploymentReceipt {
  readonly ok: boolean;
  readonly baseUrl: string;
  readonly verifiedAt: string;
  readonly commitSha?: string;
  readonly assetHash?: string;
  readonly probes: readonly EndpointProbeResult[];
}

export class DeploymentVerificationError extends Error {
  readonly receipt: DeploymentReceipt;

  constructor(receipt: DeploymentReceipt) {
    const failed = receipt.probes
      .filter((probe) => !probe.ok)
      .map((probe) => `${probe.method} ${probe.url}: ${probe.error ?? `HTTP ${String(probe.status)}`}`);
    super(`Deployment verification failed for ${receipt.baseUrl}: ${failed.join("; ")}`);
    this.name = "DeploymentVerificationError";
    this.receipt = receipt;
  }
}

export type BucketWriteCondition =
  | { readonly ifAbsent: true }
  | { readonly ifVersion: string };

export interface BucketReadResult {
  readonly text: string;
  readonly version: string;
}

export interface R2BucketClient {
  readonly listKeys: (prefix: string) => Promise<readonly string[]>;
  readonly listChildren: (prefix: string) => Promise<readonly string[]>;
  readonly read: (key: string) => Promise<BucketReadResult | undefined>;
  readonly write: (key: string, body: string, condition?: BucketWriteCondition) => Promise<string | undefined>;
  readonly delete: (key: string, ifVersion?: string) => Promise<void>;
  readonly deleteMany: (keys: readonly string[]) => Promise<void>;
}

export type R2BucketConfig =
  | {
      readonly kind: "s3";
      readonly accountId: string;
      readonly bucket: string;
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly endpoint?: string;
      readonly timeoutMs?: number;
      readonly fetch?: typeof globalThis.fetch;
    }
  | {
      readonly kind: "api";
      readonly accountId: string;
      readonly bucket: string;
      readonly apiToken: string;
      readonly baseUrl?: string;
      readonly timeoutMs?: number;
      readonly fetch?: typeof globalThis.fetch;
    };

export class R2RequestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "R2RequestError";
    this.status = status;
  }
}

export interface BucketErrorInput {
  readonly message: string;
  readonly cause?: Error;
  readonly status?: number;
}

export interface BucketEffectAdapter<E> {
  readonly tryPromise: <A>(options: {
    readonly try: () => Promise<A>;
    readonly catch: (cause: unknown) => E;
  }) => Effect<A, E>;
  readonly makeError: (input: BucketErrorInput) => E;
}

export interface AlchemyBucketObjects<E> {
  readonly listKeys: (prefix: string) => Effect<readonly string[], E>;
  readonly listChildren: (prefix: string) => Effect<readonly string[], E>;
  readonly read: (key: string) => Effect<BucketReadResult | undefined, E>;
  readonly write: (key: string, body: string, condition?: BucketWriteCondition) => Effect<string | undefined, E>;
  readonly delete: (key: string, ifVersion?: string) => Effect<void, E>;
  readonly deleteMany: (keys: readonly string[]) => Effect<void, E>;
}

const ASSET_SKIP_DIRS = new Set([".git", ".alchemy", ".wrangler", "node_modules"]);
const RETRYABLE_STATUSES = new Set([404, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);

function sanitizeSlug(raw: string, fallback: string, maxLen = 24): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return cleaned.length > 0 ? cleaned : fallback;
}

function resolveUserSlug(env: Readonly<Record<string, string | undefined>>): string {
  const raw = env.USER ?? env.USERNAME ?? (() => {
    try {
      return os.userInfo().username;
    } catch {
      return "dev";
    }
  })();
  return sanitizeSlug(raw, "dev", 20);
}

function resolveWorktreeSlug(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return sanitizeSlug(path.basename(dir), "repo", 24);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return sanitizeSlug(path.basename(path.resolve(cwd)), "repo", 24);
}

function parseExplicitStage(raw: string, defaultUser: string, defaultWorktree: string): StageTarget {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "prod" || trimmed === "production") {
    return { kind: "production", stage: "production" };
  }
  if (trimmed === "staging") {
    return { kind: "staging", stage: "staging" };
  }
  const prMatch = /^pr-(\d+)$/.exec(trimmed);
  if (prMatch) {
    const pr = Number(prMatch[1]);
    if (Number.isSafeInteger(pr) && pr > 0) {
      return { kind: "preview", stage: `pr-${pr}`, pr };
    }
  }
  if (trimmed.startsWith("test_")) {
    const rest = trimmed.slice("test_".length);
    const [userPart = defaultUser, ...wtParts] = rest.split("_");
    const user = sanitizeSlug(userPart, defaultUser, 20);
    const worktree = sanitizeSlug(wtParts.join("_"), defaultWorktree, 24);
    return { kind: "test", stage: `test_${user}_${worktree}`, user, worktree };
  }
  if (trimmed.startsWith("dev_")) {
    const rest = trimmed.slice("dev_".length);
    const [userPart = defaultUser, ...wtParts] = rest.split("_");
    const user = sanitizeSlug(userPart, defaultUser, 20);
    const worktree = sanitizeSlug(wtParts.join("_"), defaultWorktree, 24);
    return { kind: "dev", stage: `dev_${user}_${worktree}`, user, worktree };
  }
  const slug = sanitizeSlug(trimmed, defaultWorktree, 32);
  return { kind: "dev", stage: `dev_${defaultUser}_${slug}`, user: defaultUser, worktree: slug };
}

export function resolveStage(options: ResolveStageOptions = {}): StageTarget {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const user = resolveUserSlug(env);
  const worktree = resolveWorktreeSlug(cwd);
  const explicit = options.stage ?? (options.mode === "test" ? env.ALCHEMY_TEST_STAGE : env.ALCHEMY_STAGE);
  if (explicit && explicit.trim().length > 0) {
    return parseExplicitStage(explicit, user, worktree);
  }
  if (options.mode === "test") {
    return { kind: "test", stage: `test_${user}_${worktree}`, user, worktree };
  }
  if (env.GITHUB_EVENT_NAME === "pull_request") {
    const prRaw = env.PR_NUMBER ?? env.GITHUB_REF?.match(/^refs\/pull\/(\d+)\//)?.[1];
    const pr = prRaw ? Number(prRaw) : NaN;
    if (Number.isSafeInteger(pr) && pr > 0) {
      return { kind: "preview", stage: `pr-${pr}`, pr };
    }
  }
  return { kind: "dev", stage: `dev_${user}_${worktree}`, user, worktree };
}

function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

export function assertStageGuard(target: StageTarget, input: StageGuardInput): void {
  const violations: string[] = [];
  if (target.kind === "production") {
    if (input.allowProduction === false) {
      violations.push("production deploy requires explicit allowProduction opt-in");
    }
  } else {
    const forbiddenIds = new Set((input.productionIds ?? []).map((id) => id.trim()).filter(Boolean));
    for (const [name, value] of Object.entries(input.resourceIds ?? {})) {
      if (value && forbiddenIds.has(value.trim())) {
        violations.push(`non-production stage "${target.stage}" references production resource id "${name}" (${value})`);
      }
    }
    const forbiddenDomains = new Set((input.productionDomains ?? []).map(normalizeHost).filter(Boolean));
    for (const domain of input.domains ?? []) {
      const normalized = normalizeHost(domain);
      if (normalized && forbiddenDomains.has(normalized)) {
        violations.push(`non-production stage "${target.stage}" binds production domain "${domain}"`);
      }
    }
  }
  if (violations.length > 0) {
    throw new StageGuardError(target.stage, violations);
  }
}

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function collectAssetFiles(rootDir: string, relDir = "", out: string[] = []): string[] {
  const current = relDir ? path.join(rootDir, relDir) : rootDir;
  const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => compareCodePoints(a.name, b.name));
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (ASSET_SKIP_DIRS.has(entry.name)) continue;
      collectAssetFiles(rootDir, rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

export function hashAssetDirectory(dir: string): HashedAssetDirectory {
  const absDir = path.resolve(dir);
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    throw new Error(`Asset directory does not exist: ${absDir}`);
  }
  const files = collectAssetFiles(absDir);
  if (files.length === 0) {
    throw new Error(`Asset directory is empty: ${absDir}`);
  }
  const hasher = createHash("sha256");
  let totalBytes = 0;
  for (const rel of files) {
    const bytes = fs.readFileSync(path.join(absDir, rel));
    totalBytes += bytes.byteLength;
    hasher.update(`${rel}\0${String(bytes.byteLength)}\0`);
    hasher.update(bytes);
    hasher.update("\0");
  }
  const hash = hasher.digest("hex");
  return { directory: absDir, path: absDir, hash, fileCount: files.length, totalBytes };
}

function resolveProbeUrl(baseUrl: string, targetPath: string): string {
  if (/^https?:\/\//i.test(targetPath)) return targetPath;
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedPath = targetPath.startsWith("/") ? targetPath.slice(1) : targetPath;
  return new URL(normalizedPath, normalizedBase).toString();
}

function matchesStatus(status: number, expected: number | readonly number[] | undefined): boolean {
  if (expected === undefined) return status === 200;
  return typeof expected === "number" ? status === expected : expected.includes(status);
}

function extractCommitSha(headers: Headers, parsedJson: unknown): string | undefined {
  const headerSha = headers.get("x-commit-sha") ?? headers.get("x-git-sha");
  if (headerSha && headerSha.trim().length > 0) return headerSha.trim();
  if (typeof parsedJson === "object" && parsedJson !== null && !Array.isArray(parsedJson)) {
    const record = parsedJson as Record<string, unknown>;
    for (const key of ["commitSha", "commit", "sha"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
  }
  return undefined;
}

function validateProbeResponse(
  check: EndpointCheck,
  status: number,
  headers: Headers,
  bodyText: string,
  defaultCommitSha: string | undefined,
): string | undefined {
  if (!matchesStatus(status, check.expectedStatus)) {
    return `expected HTTP ${String(check.expectedStatus ?? 200)}, got ${String(status)}`;
  }
  for (const [name, expected] of Object.entries(check.expectedHeaders ?? {})) {
    const actual = headers.get(name);
    if (actual === null) return `missing expected header "${name}"`;
    if (typeof expected === "string" ? !actual.includes(expected) : !expected.test(actual)) {
      return `header "${name}" value "${actual}" did not match ${String(expected)}`;
    }
  }
  for (const needle of check.bodyIncludes ?? []) {
    if (!bodyText.includes(needle)) {
      return `response body did not contain "${needle}"`;
    }
  }
  const expectedSha = check.expectedCommitSha ?? (check.expectJson ? defaultCommitSha : undefined);
  let parsedJson: unknown;
  const needsJson = check.expectJson !== undefined || (expectedSha !== undefined && headers.get("content-type")?.includes("application/json"));
  if (needsJson) {
    try {
      parsedJson = JSON.parse(bodyText) as unknown;
    } catch (error) {
      return `response body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (check.expectJson) {
    const verdict = check.expectJson(parsedJson);
    if (verdict !== true) {
      return typeof verdict === "string" ? verdict : "JSON predicate returned false";
    }
  }
  if (expectedSha) {
    const actualSha = extractCommitSha(headers, parsedJson);
    if (!actualSha || !actualSha.startsWith(expectedSha)) {
      return `expected commit SHA "${expectedSha}", got "${actualSha ?? "none"}"`;
    }
  }
  return undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(resolve, ms);
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

async function probeOnce(
  url: string,
  check: EndpointCheck,
  fetchFn: typeof globalThis.fetch,
  timeoutMs: number,
  defaultCommitSha: string | undefined,
): Promise<{ readonly ok: boolean; readonly status: number; readonly retryable: boolean; readonly error?: string }> {
  const method = check.method ?? "GET";
  try {
    const response = await fetchFn(url, {
      method,
      headers: check.headers,
      body: check.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const bodyText = method === "HEAD" ? "" : await response.text();
    const mismatch = validateProbeResponse(check, response.status, response.headers, bodyText, defaultCommitSha);
    if (!mismatch) return { ok: true, status: response.status, retryable: false };
    const retryable = RETRYABLE_STATUSES.has(response.status) && !matchesStatus(response.status, check.expectedStatus);
    return { ok: false, status: response.status, retryable, error: mismatch };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      retryable: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function verifyDeploymentEndpoints(
  baseUrl: string,
  endpoints: readonly EndpointCheck[],
  options: VerifyDeploymentOptions = {},
): Promise<DeploymentReceipt> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const sleepFn = options.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 6);
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 500);
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? 8_000);
  const timeoutMs = Math.max(100, options.timeoutMs ?? 10_000);

  const probes: EndpointProbeResult[] = [];
  for (const check of endpoints) {
    const url = resolveProbeUrl(baseUrl, check.path);
    const method = check.method ?? "GET";
    const started = performance.now();
    let attempts = 0;
    let lastStatus = 0;
    let lastError: string | undefined;
    let passed = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      const result = await probeOnce(url, check, fetchFn, timeoutMs, options.commitSha);
      lastStatus = result.status;
      if (result.ok) {
        passed = true;
        lastError = undefined;
        break;
      }
      lastError = result.error;
      if (!result.retryable || attempt === maxAttempts) break;
      const delay = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
      if (delay > 0) await sleepFn(delay);
    }

    probes.push({
      url,
      method,
      ok: passed,
      status: lastStatus,
      attempts,
      durationMs: Math.round(performance.now() - started),
      ...(lastError !== undefined ? { error: lastError } : {}),
    });
  }

  const receipt: DeploymentReceipt = {
    ok: probes.every((probe) => probe.ok),
    baseUrl,
    verifiedAt: new Date().toISOString(),
    ...(options.commitSha !== undefined ? { commitSha: options.commitSha } : {}),
    ...(options.assetHash !== undefined ? { assetHash: options.assetHash } : {}),
    probes,
  };
  if (!receipt.ok && options.throwOnFailure !== false) {
    throw new DeploymentVerificationError(receipt);
  }
  return receipt;
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key: string | Uint8Array, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeS3Path(bucket: string, key?: string): string {
  const encodedBucket = encodeRfc3986(bucket);
  if (!key) return `/${encodedBucket}`;
  return `/${encodedBucket}/${key.split("/").map(encodeRfc3986).join("/")}`;
}

function canonicalQueryString(params: readonly [string, string][]): string {
  return params
    .map(([key, val]): [string, string] => [encodeRfc3986(key), encodeRfc3986(val)])
    .sort(([aKey, aVal], [bKey, bVal]) => compareCodePoints(aKey, bKey) || compareCodePoints(aVal, bVal))
    .map(([key, val]) => `${key}=${val}`)
    .join("&");
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function extractXmlTagValues(xml: string, tag: string): string[] {
  const matches: string[] = [];
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  for (const match of xml.matchAll(pattern)) {
    if (match[1] !== undefined) matches.push(decodeXmlEntities(match[1]));
  }
  return matches;
}

function extractXmlBlocks(xml: string, tag: string): string[] {
  const blocks: string[] = [];
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  for (const match of xml.matchAll(pattern)) {
    if (match[1] !== undefined) blocks.push(match[1]);
  }
  return blocks;
}

function formatAmzDate(now: Date): { readonly amzDate: string; readonly dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function signS3Request(options: {
  readonly method: string;
  readonly host: string;
  readonly canonicalUri: string;
  readonly query: string;
  readonly payloadHash: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly now?: Date;
}): Record<string, string> {
  const { amzDate, dateStamp } = formatAmzDate(options.now ?? new Date());
  const region = "auto";
  const service = "s3";
  const allHeaders: Record<string, string> = {
    host: options.host,
    "x-amz-content-sha256": options.payloadHash,
    "x-amz-date": amzDate,
  };
  for (const [key, value] of Object.entries(options.extraHeaders ?? {})) {
    allHeaders[key.toLowerCase()] = value.trim().replace(/[ \t]+/g, " ");
  }
  const sortedNames = Object.keys(allHeaders).sort();
  const canonicalHeaders = sortedNames.map((name) => `${name}:${allHeaders[name]}\n`).join("");
  const signedHeaders = sortedNames.join(";");
  const canonicalRequest = [
    options.method,
    options.canonicalUri,
    options.query,
    canonicalHeaders,
    signedHeaders,
    options.payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmacSha256(`AWS4${options.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return {
    ...allHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

interface R2Transport {
  readonly label: string;
  readonly list: (prefix: string, delimiter?: string) => Promise<{ readonly keys: string[]; readonly children: string[] }>;
  readonly sendObject: (options: {
    readonly method: "GET" | "PUT" | "DELETE";
    readonly key: string;
    readonly body?: string;
    readonly headers?: Readonly<Record<string, string>>;
  }) => Promise<Response>;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    return;
  }
}

function buildR2BucketClient(transport: R2Transport): R2BucketClient {
  return {
    async listKeys(prefix) {
      return (await transport.list(prefix)).keys;
    },
    async listChildren(prefix) {
      const normalized = prefix.length > 0 && !prefix.endsWith("/") ? `${prefix}/` : prefix;
      const { children } = await transport.list(normalized, "/");
      return children.map((entry) => entry.slice(normalized.length).replace(/\/$/, "")).filter(Boolean);
    },
    async read(key) {
      const response = await transport.sendObject({ method: "GET", key });
      if (response.status === 404) {
        await cancelBody(response);
        return undefined;
      }
      if (!response.ok) {
        await cancelBody(response);
        throw new R2RequestError(`${transport.label} read "${key}" failed (HTTP ${String(response.status)})`, response.status);
      }
      const text = await response.text();
      return { text, version: response.headers.get("etag") ?? sha256Hex(text) };
    },
    async write(key, body, condition) {
      const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
      if (condition && "ifAbsent" in condition) headers["if-none-match"] = "*";
      else if (condition && "ifVersion" in condition) headers["if-match"] = condition.ifVersion;
      const response = await transport.sendObject({ method: "PUT", key, body, headers });
      if (condition && (response.status === 412 || response.status === 409)) {
        await cancelBody(response);
        return undefined;
      }
      if (!response.ok) {
        await cancelBody(response);
        throw new R2RequestError(`${transport.label} write "${key}" failed (HTTP ${String(response.status)})`, response.status);
      }
      await cancelBody(response);
      return response.headers.get("etag") ?? sha256Hex(body);
    },
    async delete(key, ifVersion) {
      const headers = ifVersion ? { "if-match": ifVersion } : undefined;
      const response = await transport.sendObject({ method: "DELETE", key, headers });
      if (response.status === 404 || (ifVersion && (response.status === 412 || response.status === 409))) {
        await cancelBody(response);
        return;
      }
      if (!response.ok) {
        await cancelBody(response);
        throw new R2RequestError(`${transport.label} delete "${key}" failed (HTTP ${String(response.status)})`, response.status);
      }
      await cancelBody(response);
    },
    async deleteMany(keys) {
      for (let i = 0; i < keys.length; i += 10) {
        await Promise.all(keys.slice(i, i + 10).map((key) => this.delete(key)));
      }
    },
  };
}

function createS3R2Client(config: Extract<R2BucketConfig, { readonly kind: "s3" }>): R2BucketClient {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const timeoutMs = Math.max(100, config.timeoutMs ?? 30_000);
  const endpoint = new URL(config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`);

  async function request(options: {
    readonly method: string;
    readonly key?: string;
    readonly query?: readonly [string, string][];
    readonly body?: string;
    readonly headers?: Readonly<Record<string, string>>;
  }): Promise<Response> {
    const canonicalUri = encodeS3Path(config.bucket, options.key);
    const queryString = options.query ? canonicalQueryString(options.query) : "";
    const payloadHash = sha256Hex(options.body ?? "");
    const signed = signS3Request({
      method: options.method,
      host: endpoint.host,
      canonicalUri,
      query: queryString,
      payloadHash,
      extraHeaders: options.headers,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    });
    const url = `${endpoint.origin}${canonicalUri}${queryString ? `?${queryString}` : ""}`;
    return fetchFn(url, {
      method: options.method,
      headers: signed,
      signal: AbortSignal.timeout(timeoutMs),
      ...(options.body !== undefined ? { body: options.body } : {}),
    });
  }

  return buildR2BucketClient({
    label: "R2 S3",
    async list(prefix, delimiter) {
      const keys: string[] = [];
      const children: string[] = [];
      let continuationToken: string | undefined;
      for (;;) {
        const query: [string, string][] = [["list-type", "2"], ["prefix", prefix]];
        if (delimiter) query.push(["delimiter", delimiter]);
        if (continuationToken) query.push(["continuation-token", continuationToken]);
        const response = await request({ method: "GET", query });
        const xml = await response.text();
        if (!response.ok) {
          throw new R2RequestError(`R2 S3 list failed (HTTP ${String(response.status)})`, response.status);
        }
        for (const block of extractXmlBlocks(xml, "Contents")) keys.push(...extractXmlTagValues(block, "Key"));
        for (const block of extractXmlBlocks(xml, "CommonPrefixes")) children.push(...extractXmlTagValues(block, "Prefix"));
        const truncated = extractXmlTagValues(xml, "IsTruncated")[0] === "true";
        continuationToken = extractXmlTagValues(xml, "NextContinuationToken")[0];
        if (!truncated || !continuationToken) break;
      }
      return { keys, children };
    },
    sendObject: (options) => request(options),
  });
}

function createApiR2Client(config: Extract<R2BucketConfig, { readonly kind: "api" }>): R2BucketClient {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const timeoutMs = Math.max(100, config.timeoutMs ?? 30_000);
  const baseUrl = (config.baseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
  const objectsBase = `${baseUrl}/accounts/${encodeURIComponent(config.accountId)}/r2/buckets/${encodeURIComponent(config.bucket)}/objects`;
  const authHeader = { authorization: `Bearer ${config.apiToken}` };
  const encodeKeyPath = (key: string) => key.split("/").map(encodeURIComponent).join("/");

  return buildR2BucketClient({
    label: "Cloudflare R2 API",
    async list(prefix, delimiter) {
      const keys: string[] = [];
      const children: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const url = new URL(objectsBase);
        if (prefix) url.searchParams.set("prefix", prefix);
        if (delimiter) url.searchParams.set("delimiter", delimiter);
        if (cursor) url.searchParams.set("cursor", cursor);
        const response = await fetchFn(url, { method: "GET", headers: authHeader, signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) {
          await cancelBody(response);
          throw new R2RequestError(`Cloudflare R2 API list failed (HTTP ${String(response.status)})`, response.status);
        }
        const payload = (await response.json()) as {
          readonly success?: boolean;
          readonly result?: readonly { readonly key?: string }[];
          readonly result_info?: {
            readonly cursor?: string;
            readonly is_truncated?: boolean;
            readonly delimited?: readonly string[];
          };
        };
        if (payload.success === false) {
          throw new R2RequestError("Cloudflare R2 API list returned success=false", response.status);
        }
        for (const item of payload.result ?? []) if (typeof item.key === "string") keys.push(item.key);
        for (const item of payload.result_info?.delimited ?? []) if (typeof item === "string") children.push(item);
        const nextCursor = payload.result_info?.cursor;
        if (!payload.result_info?.is_truncated || !nextCursor) break;
        cursor = nextCursor;
      }
      return { keys, children };
    },
    sendObject: ({ method, key, body, headers }) =>
      fetchFn(`${objectsBase}/${encodeKeyPath(key)}`, {
        method,
        headers: { ...authHeader, ...(headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
        ...(body !== undefined ? { body } : {}),
      }),
  });
}

export function createR2BucketClient(config: R2BucketConfig): R2BucketClient {
  switch (config.kind) {
    case "s3":
      return createS3R2Client(config);
    case "api":
      return createApiR2Client(config);
    default: {
      const _exhaustive: never = config;
      throw new Error(`Unsupported R2BucketConfig: ${String(_exhaustive)}`);
    }
  }
}

export function makeR2BucketObjects<E>(
  config: R2BucketConfig,
  adapter: BucketEffectAdapter<E>,
): AlchemyBucketObjects<E> {
  const client = createR2BucketClient(config);
  const toError = (operation: string, cause: unknown): E => {
    const status = cause instanceof R2RequestError ? cause.status : undefined;
    const message = cause instanceof Error ? cause.message : `R2 ${operation} failed: ${String(cause)}`;
    return adapter.makeError({
      message,
      ...(cause instanceof Error ? { cause } : {}),
      ...(status !== undefined ? { status } : {}),
    });
  };
  return {
    listKeys: (prefix) => adapter.tryPromise({ try: () => client.listKeys(prefix), catch: (cause) => toError("listKeys", cause) }),
    listChildren: (prefix) => adapter.tryPromise({ try: () => client.listChildren(prefix), catch: (cause) => toError("listChildren", cause) }),
    read: (key) => adapter.tryPromise({ try: () => client.read(key), catch: (cause) => toError("read", cause) }),
    write: (key, body, condition) => adapter.tryPromise({ try: () => client.write(key, body, condition), catch: (cause) => toError("write", cause) }),
    delete: (key, ifVersion) => adapter.tryPromise({ try: () => client.delete(key, ifVersion), catch: (cause) => toError("delete", cause) }),
    deleteMany: (keys) => adapter.tryPromise({ try: () => client.deleteMany(keys), catch: (cause) => toError("deleteMany", cause) }),
  };
}
