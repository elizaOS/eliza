/**
 * Testing harness for `@elizaos/confidant`. Imported via the subpath:
 *
 *     import { createTestConfidant, MockBackend, MockPromptHandler }
 *       from "@elizaos/confidant/testing";
 *
 * Goals
 * - Plugin authors can test their Confidant-using code against a real
 *   Confidant (real encryption, real audit log, real policy engine) without
 *   needing the OS keychain, password-manager CLIs, or `process.env`.
 * - Host-app authors can test their wiring (schemas + grants + bridges)
 *   against the same real Confidant.
 * - The harness is framework-agnostic — no vitest / jest imports — so it
 *   works with any test runner.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfidant, type Confidant } from "./confidant.js";
import { generateMasterKey } from "./crypto/envelope.js";
import { inMemoryMasterKey } from "./crypto/master-key.js";
import { defineSecretSchema } from "./secret-schema.js";
import { setPermissions, readStore, writeStore } from "./store.js";
import {
  BackendError,
  type VaultBackend,
} from "./backends/types.js";
import type { ScopedConfidant } from "./scoped.js";
import type {
  AuditRecord,
  Grant,
  PromptHandler,
  SecretId,
  SecretSchemaEntry,
  VaultReference,
  VaultSource,
} from "./types.js";

// ── Test Confidant harness ──────────────────────────────────────────

export interface TestConfidantOptions {
  /**
   * Pre-load literal values keyed by SecretId. Each value is encrypted
   * at-rest in the test's temp store, exactly as production would.
   */
  readonly secrets?: Readonly<Record<SecretId, string>>;
  /**
   * Pre-load reference URIs keyed by SecretId. Use this with a
   * `MockBackend` to test reference resolution without hitting a real
   * password manager / keyring.
   */
  readonly references?: Readonly<Record<SecretId, VaultReference>>;
  /**
   * Register schemas alongside the test setup. Each entry attributes
   * ownership to a `pluginId` so the implicit-grant rule fires when
   * that plugin resolves its own SecretIds.
   */
  readonly schemas?: Readonly<Record<SecretId, Omit<SecretSchemaEntry, "id">>>;
  /**
   * Explicit cross-skill grants. Per-skill, glob patterns. Use this when
   * a test exercises a non-owning skill resolving someone else's
   * credential.
   */
  readonly grants?: Readonly<Record<string, ReadonlyArray<string | Grant>>>;
  /**
   * Backends to register. Defaults to none; pre-loaded `secrets` resolve
   * via the literal store, pre-loaded `references` need a backend whose
   * `source` matches the reference scheme.
   */
  readonly backends?: readonly VaultBackend[];
  /**
   * Prompt handler. Default: `MockPromptHandler` that approves every
   * request. Override with `new MockPromptHandler({ respondWith: false })`
   * to test denial paths.
   */
  readonly promptHandler?: PromptHandler;
  /**
   * Working directory for the test's confidant.json + audit log. Default:
   * a fresh `mkdtemp` directory; `dispose()` cleans it up. Provide an
   * explicit path to keep artifacts after the test (debugging).
   */
  readonly workDir?: string;
}

/**
 * The harness returned by `createTestConfidant`. It composes a real
 * Confidant with assertion helpers that read the audit log directly.
 */
export interface TestConfidant {
  /** The underlying Confidant. Use it as you would in production. */
  readonly confidant: Confidant;
  /** Path to the test's confidant.json (encrypted store). */
  readonly storePath: string;
  /** Path to the test's audit log JSONL. */
  readonly auditLogPath: string;

  /** Convenience: scoped Confidant for a given skill id. */
  scopeFor(skillId: string): ScopedConfidant;

  /** All audit records written so far. */
  getAuditRecords(): Promise<readonly AuditRecord[]>;
  /** Records where `granted === true`. */
  getResolves(): Promise<readonly AuditRecord[]>;
  /** Records where `granted === false`. */
  getDenials(): Promise<readonly AuditRecord[]>;
  /** Truncate the audit log for the next set of assertions. */
  clearAuditLog(): Promise<void>;

  /** Cleanup. Removes the temp directory unless `workDir` was provided. */
  dispose(): Promise<void>;
}

export async function createTestConfidant(
  opts: TestConfidantOptions = {},
): Promise<TestConfidant> {
  const ownsWorkDir = !opts.workDir;
  const workDir =
    opts.workDir ?? (await fs.mkdtemp(join(tmpdir(), "confidant-test-")));
  const storePath = join(workDir, "confidant.json");
  const auditLogPath = join(workDir, "audit", "confidant.jsonl");

  // 1. Register schemas first so implicit grants are available when
  //    pre-loaded secrets are stored. Schema registration is process-
  //    global, so test isolation requires resetting between tests; see
  //    `resetTestRegistry()` for the helper.
  if (opts.schemas) {
    defineSecretSchema(opts.schemas as Record<string, Omit<SecretSchemaEntry, "id">>);
  }

  // 2. Pre-write explicit grants directly to the store before the
  //    Confidant is constructed, so first-resolve doesn't race against
  //    the grant write.
  if (opts.grants) {
    let store = await readStore(storePath);
    for (const [skillId, grants] of Object.entries(opts.grants)) {
      const normalized: Grant[] = grants.map((g) =>
        typeof g === "string"
          ? { pattern: g, mode: "always" as const, grantedAt: Date.now() }
          : g,
      );
      store = setPermissions(store, skillId, { grants: normalized });
    }
    await writeStore(storePath, store);
  }

  const confidant = createConfidant({
    storePath,
    auditLogPath,
    masterKey: inMemoryMasterKey(generateMasterKey()),
    ...(opts.backends ? { backends: opts.backends } : {}),
    promptHandler:
      opts.promptHandler ?? new MockPromptHandler({ respondWith: true }),
  });

  // 3. Pre-load secrets and references through the public API so the
  //    test exercises the same code path production does.
  if (opts.secrets) {
    for (const [id, value] of Object.entries(opts.secrets)) {
      await confidant.set(id, value);
    }
  }
  if (opts.references) {
    for (const [id, ref] of Object.entries(opts.references)) {
      await confidant.setReference(id, ref);
    }
  }

  return {
    confidant,
    storePath,
    auditLogPath,
    scopeFor: (skillId) => confidant.scopeFor(skillId),
    async getAuditRecords() {
      return readAuditLog(auditLogPath);
    },
    async getResolves() {
      const all = await readAuditLog(auditLogPath);
      return all.filter((r) => r.granted);
    },
    async getDenials() {
      const all = await readAuditLog(auditLogPath);
      return all.filter((r) => !r.granted);
    },
    async clearAuditLog() {
      try {
        await fs.writeFile(auditLogPath, "", { mode: 0o600 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },
    async dispose() {
      if (ownsWorkDir) {
        await fs.rm(workDir, { recursive: true, force: true });
      }
    },
  };
}

async function readAuditLog(path: string): Promise<readonly AuditRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((line) => JSON.parse(line) as AuditRecord);
}

// ── Mock backend ───────────────────────────────────────────────────

export interface MockBackendCall {
  readonly method: "resolve" | "store" | "remove";
  readonly ref: VaultReference;
  readonly value?: string;
  readonly id?: string;
}

/**
 * In-memory `VaultBackend` for testing reference resolution. Behaves
 * like a real backend (resolve / store / remove), records every call,
 * and supports forced failures for testing error paths.
 *
 * Construct one per backend `source` you want to mock:
 *
 *     const op = new MockBackend("1password", {
 *       "op://Personal/OpenRouter/api-key": "sk-or-v1-test",
 *     });
 *     const test = await createTestConfidant({
 *       backends: [op],
 *       references: { "llm.openrouter.apiKey": "op://Personal/OpenRouter/api-key" },
 *     });
 *     await test.scopeFor("@elizaos/plugin-openrouter").resolve("llm.openrouter.apiKey");
 *     expect(op.getCalls()).toHaveLength(1);
 */
export class MockBackend implements VaultBackend {
  readonly source: VaultSource;
  private values: Map<VaultReference, string> = new Map();
  private calls: MockBackendCall[] = [];
  private nextErrors: Error[] = [];

  constructor(
    source: VaultSource,
    initial?: Readonly<Record<VaultReference, string>>,
  ) {
    this.source = source;
    if (initial) {
      for (const [ref, value] of Object.entries(initial)) {
        this.values.set(ref, value);
      }
    }
  }

  async resolve(ref: VaultReference): Promise<string> {
    this.calls.push({ method: "resolve", ref });
    const failure = this.nextErrors.shift();
    if (failure) throw failure;
    const value = this.values.get(ref);
    if (value === undefined) {
      throw new BackendError(this.source, `no value for ref ${ref}`);
    }
    return value;
  }

  async store(id: string, value: string): Promise<VaultReference> {
    const ref = `${schemeFor(this.source)}://test/${id}`;
    this.values.set(ref, value);
    this.calls.push({ method: "store", ref, id, value });
    return ref;
  }

  async remove(ref: VaultReference): Promise<void> {
    this.values.delete(ref);
    this.calls.push({ method: "remove", ref });
  }

  /** Inspect every interaction the harness made with this backend. */
  getCalls(): readonly MockBackendCall[] {
    return this.calls;
  }

  /** Convenience: just the resolves. */
  getResolves(): readonly MockBackendCall[] {
    return this.calls.filter((c) => c.method === "resolve");
  }

  resetCalls(): void {
    this.calls = [];
  }

  /** Pre-stage a value for a reference. */
  setValue(ref: VaultReference, value: string): void {
    this.values.set(ref, value);
  }

  /** Remove a staged value (so the next resolve throws). */
  removeValue(ref: VaultReference): void {
    this.values.delete(ref);
  }

  /**
   * Make the next call (in order: resolve / store / remove) fail with
   * `error`. Multiple failures can be queued.
   */
  failNext(error: Error): void {
    this.nextErrors.push(error);
  }
}

function schemeFor(source: VaultSource): string {
  switch (source) {
    case "file":
      return "file";
    case "keyring":
      return "keyring";
    case "1password":
      return "op";
    case "protonpass":
      return "pass";
    case "env-legacy":
      return "env";
    case "cloud":
      return "cloud";
  }
}

// ── Mock keychain backend ───────────────────────────────────────────

/**
 * Convenience subclass of `MockBackend` for testing OS-keychain-backed
 * secrets (macOS Keychain, Windows Credential Manager, Linux libsecret).
 * Stores values keyed by `(service, account)` and produces idiomatic
 * `keyring://service/account` references — the same shape the real
 * `KeyringBackend` uses, so tests exercise the production URI format
 * without touching the real OS keychain.
 *
 *     const mac = new MockKeyringBackend({
 *       "elizaos/llm.openrouter.apiKey": "sk-or-v1-test",
 *     });
 *     const test = await createTestConfidant({
 *       schemas: { "llm.openrouter.apiKey": { ... } },
 *       backends: [mac],
 *       references: {
 *         "llm.openrouter.apiKey": "keyring://elizaos/llm.openrouter.apiKey",
 *       },
 *     });
 *
 * Cross-platform — works the same on macOS, Windows, and Linux because
 * nothing actually hits the OS. For a true OS-keychain integration
 * test that hits the real platform keychain, use the real
 * `KeyringBackend` exported from `@elizaos/confidant`.
 */
export class MockKeyringBackend extends MockBackend {
  constructor(initial?: Readonly<Record<string, string>>) {
    // Initial map keys are `service/account` for ergonomics; convert
    // to `keyring://service/account` references internally.
    const refs: Record<VaultReference, string> = {};
    if (initial) {
      for (const [path, value] of Object.entries(initial)) {
        refs[`keyring://${path}`] = value;
      }
    }
    super("keyring", refs);
  }

  /**
   * Set a keychain entry by `(service, account)`. Equivalent to
   * `setValue("keyring://service/account", value)` but matches the
   * real `KeyringBackend` mental model.
   */
  setEntry(service: string, account: string, value: string): void {
    this.setValue(`keyring://${service}/${account}`, value);
  }

  /** Remove a keychain entry by `(service, account)`. */
  removeEntry(service: string, account: string): void {
    this.removeValue(`keyring://${service}/${account}`);
  }

  /** Build the canonical reference URI for a `(service, account)` pair. */
  static reference(service: string, account: string): VaultReference {
    return `keyring://${service}/${account}`;
  }
}

// ── Mock prompt handler ─────────────────────────────────────────────

export interface MockPromptCall {
  readonly skillId: string;
  readonly secretId: SecretId;
  readonly reason?: string;
}

export interface MockPromptHandlerOptions {
  /**
   * What to return from `promptForGrant`. Either a fixed boolean (every
   * call) or a function that decides per-call.
   */
  readonly respondWith?:
    | boolean
    | ((input: MockPromptCall) => boolean | Promise<boolean>);
}

export class MockPromptHandler implements PromptHandler {
  private calls: MockPromptCall[] = [];
  private decide: (input: MockPromptCall) => boolean | Promise<boolean>;

  constructor(opts: MockPromptHandlerOptions = {}) {
    const r = opts.respondWith ?? true;
    this.decide = typeof r === "function" ? r : () => r;
  }

  async promptForGrant(input: MockPromptCall): Promise<boolean> {
    this.calls.push(input);
    return this.decide(input);
  }

  getCalls(): readonly MockPromptCall[] {
    return this.calls;
  }

  resetCalls(): void {
    this.calls = [];
  }
}

// ── Schema isolation helper ─────────────────────────────────────────

/**
 * Schemas are registered in a process-global registry; tests that share
 * a process must reset it between cases. Re-exports the test-only reset
 * from the schema module so callers don't have to reach into internals.
 */
export { __resetSecretSchemaForTests as resetTestRegistry } from "./secret-schema.js";
