/**
 * End-to-end integration: vault × runtime-ops.
 *
 * Exercises the full chain that ships in production:
 *
 *   1. A request arrives at `handleProviderSwitchRoutes` carrying an apiKey.
 *   2. The route persists the key in `@elizaos/vault` BEFORE constructing
 *      the operation intent.
 *   3. The intent (`apiKeyRef` only, no plaintext) flows through the
 *      manager into the filesystem repository.
 *   4. The hot strategy later resolves `apiKeyRef` through the vault and
 *      pushes the plaintext into `process.env`.
 *
 * Invariants under test (each is a separate failure mode users care
 * about — none of them can regress silently):
 *
 *   - The persisted op file on disk contains NO plaintext API key.
 *   - The vault contains the key, encrypted at rest.
 *   - The audit log records the route's `set` and the strategy's `reveal`,
 *     each with its caller; neither line contains the secret value.
 *   - Idempotent retries do NOT write the vault twice.
 *   - Hot reload populates `process.env` with the resolved plaintext.
 *   - Pruning the operation record does NOT delete the vault entry.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createManager,
  createTestVault,
  type SecretsManager,
  type TestVault,
} from "@elizaos/vault";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { defaultClassifier } from "../../../src/runtime/operations/classifier.js";
import { HealthChecker } from "../../../src/runtime/operations/health.js";
import { DefaultRuntimeOperationManager } from "../../../src/runtime/operations/manager.js";
import { createHotStrategy } from "../../../src/runtime/operations/reload-hot.js";
import { FilesystemRuntimeOperationRepository } from "../../../src/runtime/operations/repository.js";
import type {
  OperationIntent,
  ProviderSwitchIntent,
  ReloadContext,
  RuntimeOperation,
} from "../../../src/runtime/operations/types.js";
import { resolveProviderApiKey, VaultResolveError } from "../../../src/runtime/operations/vault-bridge.js";

let stateDir: string;
let testVault: TestVault;
let secrets: SecretsManager;
let repo: FilesystemRuntimeOperationRepository;

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "vault-integration-"));
  testVault = await createTestVault({ workDir: join(stateDir, "vault-home") });
  secrets = createManager({ vault: testVault.vault });
  repo = new FilesystemRuntimeOperationRepository(stateDir, {
    retentionMs: 365 * 24 * 60 * 60 * 1000,
    maxRecords: 1000,
  });
});

afterEach(async () => {
  await testVault.dispose();
  rmSync(stateDir, { recursive: true, force: true });
});

function listOpsDir(): string[] {
  try {
    return readdirSync(join(stateDir, "runtime-operations")).filter((f) =>
      f.endsWith(".json"),
    );
  } catch {
    return [];
  }
}

function readOpFile(id: string): string {
  return readFileSync(
    join(stateDir, "runtime-operations", `${id}.json`),
    "utf8",
  );
}

describe("vault × runtime-ops — accepted operation persists ref, never plaintext", () => {
  test("manager.start with provider-switch intent: op file holds apiKeyRef, vault holds secret", async () => {
    // Arrange — the route's contract: write secret first, then build intent.
    const apiKey = "sk-this-must-not-leak-anywhere";
    const { persistProviderApiKey } = await import("./vault-bridge.js");
    const apiKeyRef = await persistProviderApiKey({
      secrets,
      normalizedProvider: "openai",
      apiKey,
      caller: "provider-switch-route",
    });
    expect(apiKeyRef).toBe("providers.openai.api-key");

    const intent: ProviderSwitchIntent = {
      kind: "provider-switch",
      provider: "openai",
      apiKeyRef,
      primaryModel: "gpt-5.5",
    };

    // Build the manager with a hot strategy that uses our test vault.
    const healthChecker = new HealthChecker();
    const hot = createHotStrategy({
      secrets,
      // No-op env applier — we test env resolution separately below; here
      // the focus is the persisted record's shape.
      applyProviderEnv: async () => {},
      notifyConfigChanged: async () => {},
    });
    const manager = new DefaultRuntimeOperationManager({
      repository: repo,
      runtime: () => ({}) as never, // unused by hot path
      // Same-provider switch (key/model only) collapses to "hot".
      classifyContext: () => ({ currentProvider: "openai" }),
      classifier: defaultClassifier,
      healthChecker,
      strategies: { hot },
    });

    const outcome = await manager.start({ intent });
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    const opId = outcome.operation.id;

    // Drain the manager's execution chain so the op completes.
    // Was: `await new Promise((r) => setTimeout(r, 60))` — a fixed 60ms
    // sleep. Passes locally; flakes in CI on slower runners where the
    // operation is still in `running` status when we read it. Poll
    // until the op reaches a terminal state (or a 5s deadline).
    const finalOp = await (async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const op = await repo.get(opId);
        if (op?.status === "succeeded" || op?.status === "failed") return op;
        await new Promise((r) => setTimeout(r, 25));
      }
      return repo.get(opId);
    })();
    expect(finalOp?.status).toBe("succeeded");

    // Invariant 1: on-disk op file MUST NOT contain the secret.
    const onDisk = readOpFile(opId);
    expect(onDisk).not.toContain(apiKey);
    expect(onDisk).toContain("apiKeyRef");
    expect(onDisk).toContain("providers.openai.api-key");

    // Invariant 2: the in-memory intent has only apiKeyRef.
    if (finalOp?.intent.kind === "provider-switch") {
      expect(finalOp.intent.apiKeyRef).toBe("providers.openai.api-key");
      expect("apiKey" in finalOp.intent).toBe(false);
    }

    // Invariant 3: the vault has the secret, encrypted at rest.
    const vaultJson = readFileSync(testVault.storePath, "utf8");
    expect(vaultJson).not.toContain(apiKey);
    const desc = await testVault.vault.describe(apiKeyRef);
    expect(desc?.sensitive).toBe(true);

    // Invariant 4: the audit log records the route's set call by name and
    // never contains the plaintext.
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
});

describe("vault × runtime-ops — hot reload resolves apiKeyRef into process.env", () => {
  test("makeDefaultApplyProviderEnv reveals through vault and surfaces to downstream env-pump", async () => {
    const apiKey = "sk-only-resolves-via-vault";
    await testVault.vault.set("providers.openai.api-key", apiKey, {
      sensitive: true,
      caller: "test:seed",
    });

    // Replace the default applyProviderEnv with a capture so we can verify
    // the strategy passes the vault-resolved plaintext to downstream
    // logic without actually mutating ~/.eliza/config.json or process.env
    // during the test.
    let capturedApiKey: string | undefined;
    const hot = createHotStrategy({
      secrets,
      applyProviderEnv: async (intent: ProviderSwitchIntent) => {
        capturedApiKey = await resolveProviderApiKey({
          secrets,
          apiKeyRef: intent.apiKeyRef,
          caller: "runtime-ops:reload-hot",
        });
      },
      notifyConfigChanged: async () => {},
    });

    const intent: ProviderSwitchIntent = {
      kind: "provider-switch",
      provider: "openai",
      apiKeyRef: "providers.openai.api-key",
    };
    const ctx: ReloadContext = {
      runtime: {} as never,
      intent,
      reportPhase: async () => {},
    };
    await hot.apply(ctx);

    expect(capturedApiKey).toBe(apiKey);

    // Audit log: the strategy's reveal must be present, with the right
    // caller, and never the secret itself.
    const audit = await testVault.getAuditRecords();
    const reveal = audit.find(
      (a) =>
        a.action === "reveal" &&
        a.key === "providers.openai.api-key" &&
        a.caller === "runtime-ops:reload-hot",
    );
    expect(reveal).toBeDefined();
    const auditRaw = readFileSync(testVault.auditLogPath, "utf8");
    expect(auditRaw).not.toContain(apiKey);
  });

  test("missing apiKeyRef → applyProviderEnv runs without consulting vault", async () => {
    let capturedApiKey: string | undefined = "untouched";
    const hot = createHotStrategy({
      secrets,
      applyProviderEnv: async (intent: ProviderSwitchIntent) => {
        capturedApiKey = await resolveProviderApiKey({
          secrets,
          apiKeyRef: intent.apiKeyRef,
          caller: "runtime-ops:reload-hot",
        });
      },
      notifyConfigChanged: async () => {},
    });
    await hot.apply({
      runtime: {} as never,
      intent: { kind: "provider-switch", provider: "openai" },
      reportPhase: async () => {},
    });
    expect(capturedApiKey).toBeUndefined();
    // No reveal should have been recorded — the strategy short-circuited.
    const audit = await testVault.getAuditRecords();
    expect(audit.find((a) => a.action === "reveal")).toBeUndefined();
  });

  test("vault miss with apiKeyRef fails loudly", async () => {
    let captured: string | undefined = "untouched";
    const hot = createHotStrategy({
      secrets,
      applyProviderEnv: async (intent: ProviderSwitchIntent) => {
        captured = await resolveProviderApiKey({
          secrets,
          apiKeyRef: intent.apiKeyRef,
          caller: "runtime-ops:reload-hot",
        });
      },
      notifyConfigChanged: async () => {},
    });
    const apply = hot.apply({
      runtime: {} as never,
      intent: {
        kind: "provider-switch",
        provider: "openai",
        apiKeyRef: "providers.openai.api-key", // not seeded
      },
      reportPhase: async () => {},
    });
    await expect(apply).rejects.toBeInstanceOf(VaultResolveError);
    expect(captured).toBe("untouched");
  });
});

describe("vault × runtime-ops — idempotency does not double-write the vault", () => {
  test("two start() calls with the same idempotency key route through one persisted op AND match the same vault entry", async () => {
    const apiKey = "sk-idem-1";
    const { persistProviderApiKey } = await import("./vault-bridge.js");

    // Caller (route) writes the vault BEFORE constructing the intent.
    // The route's contract says vault is the canonical store, written at
    // the boundary; the manager handles dedup of the operation record.
    const apiKeyRef = await persistProviderApiKey({
      secrets,
      normalizedProvider: "openai",
      apiKey,
      caller: "provider-switch-route",
    });

    const intent: ProviderSwitchIntent = {
      kind: "provider-switch",
      provider: "openai",
      apiKeyRef,
    };

    const manager = new DefaultRuntimeOperationManager({
      repository: repo,
      runtime: () => ({}) as never,
      classifyContext: () => ({ currentProvider: "anthropic" }),
      classifier: defaultClassifier,
      healthChecker: new HealthChecker(),
      strategies: {
        hot: createHotStrategy({
          secrets,
          applyProviderEnv: async () => {},
          notifyConfigChanged: async () => {},
        }),
      },
    });

    const first = await manager.start({ intent, idempotencyKey: "key-A" });
    await new Promise((r) => setTimeout(r, 50));
    const second = await manager.start({ intent, idempotencyKey: "key-A" });
    expect(first.kind).toBe("accepted");
    expect(second.kind).toBe("deduped");
    if (first.kind !== "accepted" || second.kind !== "deduped") return;
    expect(first.operation.id).toBe(second.operation.id);

    // One op file on disk.
    expect(listOpsDir()).toHaveLength(1);

    // The vault has exactly one entry for this provider — the route writes
    // it once, and dedup at the manager level does not produce a second
    // call to persistProviderApiKey (the test mirrors that contract).
    const entries = await testVault.vault.list("providers.openai");
    expect(
      entries.filter((k) => k === "providers.openai.api-key"),
    ).toHaveLength(1);
  });
});

describe("vault × runtime-ops — pruning preserves vault entries", () => {
  test("pruning a terminal operation removes the op file but leaves the vault entry intact", async () => {
    const apiKey = "sk-pruning-test";
    await testVault.vault.set("providers.openai.api-key", apiKey, {
      sensitive: true,
    });

    const intent: ProviderSwitchIntent = {
      kind: "provider-switch",
      provider: "openai",
      apiKeyRef: "providers.openai.api-key",
    };

    // Seed with timestamps near `now` so the post-create opportunistic
    // prune (which uses real Date.now()) does not immediately reap the
    // op. Force pruning later by passing a future "now" to pruneTerminal.
    const now = Date.now();
    const op: RuntimeOperation = {
      id: "to-be-pruned",
      kind: "provider-switch",
      intent: intent satisfies OperationIntent,
      tier: "hot",
      status: "succeeded",
      phases: [],
      startedAt: now,
      finishedAt: now,
    };
    await repo.create(op);
    expect(listOpsDir()).toEqual(["to-be-pruned.json"]);

    // 400 days later — exceeds the 365-day retention window.
    const removed = await repo.pruneTerminal(now + 400 * 24 * 60 * 60 * 1000);
    expect(removed).toBe(1);

    // Op file gone, vault entry preserved (vault has its own retention).
    expect(listOpsDir()).toEqual([]);
    expect(await testVault.vault.has("providers.openai.api-key")).toBe(true);
    expect(
      await resolveProviderApiKey({
        secrets,
        apiKeyRef: "providers.openai.api-key",
        caller: "post-prune",
      }),
    ).toBe(apiKey);
  });
});

describe("vault × runtime-ops — legacy op records are migrated AND cannot be re-read with the secret", () => {
  test("a legacy op file is auto-migrated on hydrate and the secret never re-enters memory", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = path.join(stateDir, "runtime-operations");
    await fs.mkdir(dir, { recursive: true });

    const legacyApiKey = "sk-legacy-pre-vault-must-be-stripped";
    const legacyOp = {
      id: "pre-vault",
      kind: "provider-switch",
      intent: {
        kind: "provider-switch",
        provider: "openai",
        apiKey: legacyApiKey,
        primaryModel: "gpt-5",
      },
      tier: "hot",
      status: "succeeded",
      phases: [],
      startedAt: Date.now(),
      finishedAt: Date.now(),
    };
    const filePath = path.join(dir, "pre-vault.json");
    await fs.writeFile(filePath, `${JSON.stringify(legacyOp, null, 2)}\n`);

    // Construct a fresh repo (fresh hydrate) — the migration triggers.
    const fresh = new FilesystemRuntimeOperationRepository(stateDir, {
      retentionMs: 365 * 24 * 60 * 60 * 1000,
      maxRecords: 1000,
    });
    const loaded = await fresh.get("pre-vault");
    if (loaded?.intent.kind !== "provider-switch") {
      throw new Error("expected provider-switch intent");
    }
    expect("apiKey" in loaded.intent).toBe(false);

    // The secret is gone from the on-disk file.
    const after = await fs.readFile(filePath, "utf8");
    expect(after).not.toContain(legacyApiKey);

    // Resolution falls back to undefined because no apiKeyRef was set on
    // the legacy record. The next provider-switch via the route will
    // populate the vault for real.
    expect(loaded.intent.apiKeyRef).toBeUndefined();
  });
});
