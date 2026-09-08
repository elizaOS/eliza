/** Static gate: restore authority has only the explicitly activated production callers. */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const REPOSITORY_ROOT = join(import.meta.dir, "../../../../..");
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "__tests__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "test",
  "tests",
]);

function productionSources(directory = REPOSITORY_ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) return [];
      return productionSources(absolute);
    }
    if (!entry.isFile() || !/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) return [];
    return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name) ? [] : [absolute];
  });
}

describe("disabled-first restore API boundary", () => {
  test("keeps post-quarantine APIs dormant and active calls narrowly allowlisted", () => {
    const sources = productionSources().map((path) => ({
      path,
      source: readFileSync(path, "utf8"),
    }));
    for (const forbidden of [
      "queryAgentBackupRestoreCommitOutcome",
      "markAgentBackupRestoreVerified",
      "runAgentBackupRestoreCoordinator",
      "dispatchAgentBackupRestore",
    ]) {
      expect(
        sources.filter(({ source }) => source.includes(forbidden)).map(({ path }) => path),
        `Unexpected provisional restore surface: ${forbidden}`,
      ).toEqual([]);
    }
    const approvedProductionSources: Readonly<Record<string, readonly string[]>> = {
      acquireAgentBackupRestoreLease: ["/db/repositories/agent-backup-restore-lease.ts"],
      renewAgentBackupRestoreLease: ["/db/repositories/agent-backup-restore-lease.ts"],
      releaseAgentBackupRestoreLease: ["/db/repositories/agent-backup-restore-lease.ts"],
      loadAgentBackupRestoreSourceV3: [
        "/db/repositories/agent-backup-restore.ts",
        "/db/repositories/agent-vault-key-authority.ts",
        "/lib/services/agent-backup-restore-quarantined-create-runtime.ts",
      ],
      createOrRotateAgentVaultKeyGeneration: ["/db/repositories/agent-vault-key-authority.ts"],
      loadCurrentAgentVaultKeyAuthority: [
        "/db/repositories/agent-vault-key-authority.ts",
        "/lib/services/agent-backup-capture-v3-vault-authority.ts",
      ],
      bindAgentBackupVaultKeyGeneration: ["/db/repositories/agent-vault-key-authority.ts"],
      withAgentBackupRestoreVaultPassphrase: [
        "/db/repositories/agent-vault-key-authority.ts",
        "/lib/services/agent-backup-restore-quarantined-create-runtime.ts",
      ],
      openAgentBackupRestoreOperation: ["/db/repositories/agent-backup-restore-operations.ts"],
      claimAgentBackupRestoreOperation: [
        "/db/repositories/agent-backup-restore-operations.ts",
        "/lib/services/agent-backup-restore-quarantined-create-runtime.ts",
      ],
      releaseAgentBackupRestoreOperationClaim: [
        "/db/repositories/agent-backup-restore-operations.ts",
        "/lib/services/agent-backup-restore-quarantined-create-runtime.ts",
      ],
      reserveAgentBackupRestoreTargetAndStartReplacementIntent: [
        "/db/repositories/agent-backup-restore-operations.ts",
        "/lib/services/agent-backup-restore-quarantined-create-runtime.ts",
      ],
      recordAgentBackupRestoreExactImagePlatformAuthority: [
        "/db/repositories/agent-backup-restore-operations.ts",
        "/lib/services/agent-backup-restore-quarantined-create-runtime.ts",
      ],
      resolveAgentBackupRestoreExactImagePlatform: [
        "/lib/services/agent-backup-restore-exact-image-platform.ts",
        "/lib/services/agent-backup-restore-quarantined-create-runtime.ts",
      ],
      markAgentSandboxExactRestoreProviderStarted: [
        "/db/repositories/agent-backup-restore-operations.ts",
        "/lib/services/agent-backup-restore-quarantined-create-runtime.ts",
      ],
      recordAgentSandboxExactRestoreProviderCreated: [
        "/db/repositories/agent-backup-restore-operations.ts",
        "/lib/services/agent-backup-restore-quarantined-create-runtime.ts",
      ],
      recordAgentSandboxExactRestoreProviderSucceeded: [
        "/db/repositories/agent-backup-restore-operations.ts",
        "/lib/services/agent-backup-restore-quarantined-create-runtime.ts",
      ],
      claimAgentSandboxExactRestoreCleanup: [
        "/db/repositories/agent-backup-restore-operations.ts",
        "/lib/services/agent-backup-restore-quarantined-create-runtime.ts",
      ],
      beginAgentSandboxExactRestoreCleanup: [
        "/db/repositories/agent-backup-restore-operations.ts",
        "/lib/services/agent-backup-restore-quarantined-create-runtime.ts",
      ],
      finishAgentSandboxExactRestoreCleanup: [
        "/db/repositories/agent-backup-restore-operations.ts",
        "/lib/services/agent-backup-restore-quarantined-create-runtime.ts",
      ],
      releaseAgentSandboxExactRestoreCleanupClaim: [
        "/db/repositories/agent-backup-restore-operations.ts",
        "/lib/services/agent-backup-restore-quarantined-create-runtime.ts",
      ],
      reserveAgentBackupRestoreTarget: ["/db/repositories/agent-backup-restore-operations.ts"],
      advanceAgentBackupRestoreOperation: ["/db/repositories/agent-backup-restore-operations.ts"],
      openAgentBackupRestoreQuarantine: ["/db/repositories/agent-backup-restore-quarantine.ts"],
      recordAgentBackupRestoreQuarantinedContainer: [
        "/db/repositories/agent-backup-restore-quarantine.ts",
      ],
      recordAgentBackupRestoreQuarantinedContainerAndReplacementCreated: [
        "/db/repositories/agent-backup-restore-quarantine.ts",
      ],
      verifyAgentSandboxExactRestoreReplacementIntent: [
        "/db/repositories/agent-sandbox-replacement-attempts.ts",
        "/lib/services/agent-backup-restore-quarantined-create-runtime.ts",
      ],
      recordAgentActivationPublication: ["/db/repositories/agent-backup-restore-history.ts"],
      authorizeAgentActivationDispatch: ["/db/repositories/agent-backup-restore-history.ts"],
      recordAgentVaultKeySeedReceipt: [
        "/db/repositories/agent-backup-restore-history.ts",
        "/lib/services/agent-backup-restore-quarantined-create-runtime.ts",
      ],
      commitAgentBackupRestore: ["/db/repositories/agent-backup-restore-history.ts"],
    };
    for (const symbol of [
      "acquireAgentBackupRestoreLease",
      "renewAgentBackupRestoreLease",
      "releaseAgentBackupRestoreLease",
      "loadAgentBackupRestoreSourceV3",
      "createOrRotateAgentVaultKeyGeneration",
      "loadCurrentAgentVaultKeyAuthority",
      "bindAgentBackupVaultKeyGeneration",
      "withAgentBackupRestoreVaultPassphrase",
      "openAgentBackupRestoreOperation",
      "claimAgentBackupRestoreOperation",
      "releaseAgentBackupRestoreOperationClaim",
      "reserveAgentBackupRestoreTargetAndStartReplacementIntent",
      "recordAgentBackupRestoreExactImagePlatformAuthority",
      "resolveAgentBackupRestoreExactImagePlatform",
      "markAgentSandboxExactRestoreProviderStarted",
      "recordAgentSandboxExactRestoreProviderCreated",
      "recordAgentSandboxExactRestoreProviderSucceeded",
      "claimAgentSandboxExactRestoreCleanup",
      "beginAgentSandboxExactRestoreCleanup",
      "finishAgentSandboxExactRestoreCleanup",
      "releaseAgentSandboxExactRestoreCleanupClaim",
      "reserveAgentBackupRestoreTarget",
      "advanceAgentBackupRestoreOperation",
      "openAgentBackupRestoreQuarantine",
      "recordAgentBackupRestoreQuarantinedContainer",
      "recordAgentBackupRestoreQuarantinedContainerAndReplacementCreated",
      "verifyAgentSandboxExactRestoreReplacementIntent",
      "recordAgentActivationPublication",
      "authorizeAgentActivationDispatch",
      "recordAgentVaultKeySeedReceipt",
      "commitAgentBackupRestore",
    ]) {
      const symbolBoundary = new RegExp(`\\b${symbol}\\b`);
      const matchingSources = sources.filter(
        ({ source }) => source.includes(symbol) && symbolBoundary.test(source),
      );
      const occurrences = matchingSources.map(({ path }) => path);
      const allowedSuffixes = approvedProductionSources[symbol];
      expect(allowedSuffixes, `${symbol} must have an explicit source allowlist`).toBeDefined();
      expect(
        occurrences
          .map((path) => allowedSuffixes?.find((suffix) => path.endsWith(suffix)) ?? path)
          .sort(),
        `${symbol} gained an unapproved production source`,
      ).toEqual([...(allowedSuffixes ?? [])].sort());
      const invocationLikeOccurrences = matchingSources.flatMap(
        ({ source }) => source.match(new RegExp(`\\b${symbol}(?:<[^>]+>)?\\s*\\(`, "g")) ?? [],
      );
      const expectedInvocationLikeOccurrences =
        symbol === "loadCurrentAgentVaultKeyAuthority"
          ? 3
          : symbol === "loadAgentBackupRestoreSourceV3"
            ? 2
            : 1;
      expect(
        invocationLikeOccurrences ?? [],
        `${symbol} gained a production call site`,
      ).toHaveLength(expectedInvocationLikeOccurrences);
    }

    const lockedExactHelperCallSites = {
      startOrReplayExactRestoreReplacementIntentInTransaction: [
        "packages/cloud/shared/src/db/repositories/agent-backup-restore-operations.ts",
        "packages/cloud/shared/src/db/repositories/agent-sandbox-replacement-attempts.ts",
      ],
      recordAgentSandboxReplacementCreatedInTransaction: [
        "packages/cloud/shared/src/db/repositories/agent-backup-restore-operations.ts",
        "packages/cloud/shared/src/db/repositories/agent-backup-restore-quarantine.ts",
        "packages/cloud/shared/src/db/repositories/agent-sandbox-replacement-attempts.ts",
      ],
      markAgentSandboxExactRestoreProviderStartedForLockedAuthoritiesInTransaction: [
        "packages/cloud/shared/src/db/repositories/agent-backup-restore-operations.ts",
        "packages/cloud/shared/src/db/repositories/agent-sandbox-replacement-attempts.ts",
      ],
      recordAgentSandboxExactRestoreProviderSucceededForLockedAuthoritiesInTransaction: [
        "packages/cloud/shared/src/db/repositories/agent-backup-restore-operations.ts",
        "packages/cloud/shared/src/db/repositories/agent-sandbox-replacement-attempts.ts",
      ],
      rearmAgentBackupRestoreQuarantineAfterExactProviderCleanupForLockedAuthoritiesInTransaction: [
        "packages/cloud/shared/src/db/repositories/agent-backup-restore-operations.ts",
        "packages/cloud/shared/src/db/repositories/agent-backup-restore-quarantine.ts",
      ],
      beginAgentSandboxExactRestoreCleanupForLockedAuthoritiesInTransaction: [
        "packages/cloud/shared/src/db/repositories/agent-backup-restore-operations.ts",
        "packages/cloud/shared/src/db/repositories/agent-sandbox-replacement-attempts.ts",
      ],
      finishAgentSandboxExactRestoreCleanupForLockedAuthoritiesInTransaction: [
        "packages/cloud/shared/src/db/repositories/agent-backup-restore-operations.ts",
        "packages/cloud/shared/src/db/repositories/agent-sandbox-replacement-attempts.ts",
      ],
      openAgentBackupRestoreQuarantineForLockedAuthoritiesInTransaction: [
        "packages/cloud/shared/src/db/repositories/agent-backup-restore-operations.ts",
        "packages/cloud/shared/src/db/repositories/agent-backup-restore-quarantine.ts",
      ],
      recordAgentBackupRestoreQuarantinedContainerForLockedAuthoritiesInTransaction: [
        "packages/cloud/shared/src/db/repositories/agent-backup-restore-operations.ts",
        "packages/cloud/shared/src/db/repositories/agent-backup-restore-quarantine.ts",
      ],
    } as const;
    for (const [symbol, expectedPaths] of Object.entries(lockedExactHelperCallSites)) {
      const symbolBoundary = new RegExp(`\\b${symbol}\\b`);
      const matchingSources = sources.filter(
        ({ source }) => source.includes(symbol) && symbolBoundary.test(source),
      );
      const actualPaths = matchingSources
        .map(({ path }) => path.slice(REPOSITORY_ROOT.length + 1))
        .sort();
      expect(actualPaths, `${symbol} gained a production import or call site`).toEqual(
        [...expectedPaths].sort(),
      );
      const invocationLikeOccurrences = matchingSources.flatMap(
        ({ source }) => source.match(new RegExp(`\\b${symbol}(?:<[^>]+>)?\\s*\\(`, "g")) ?? [],
      );
      expect(
        invocationLikeOccurrences ?? [],
        `${symbol} gained a production invocation`,
      ).toHaveLength(
        symbol === "openAgentBackupRestoreQuarantineForLockedAuthoritiesInTransaction"
          ? 3
          : expectedPaths.length,
      );
    }
    expect(readFileSync(join(import.meta.dir, "index.ts"), "utf8")).not.toMatch(
      /agent-backup-restore|agent-vault-key-authority/,
    );
    const runtimeSource = readFileSync(
      join(import.meta.dir, "../lib/services/agent-backup-restore-quarantined-create-runtime.ts"),
      "utf8",
    );
    expect(runtimeSource).toContain('exactRestoreCreateCapability !== "stopped-quarantine-v1"');
    expect(runtimeSource).not.toContain("resolveImageDigest");
    expect(runtimeSource).not.toMatch(
      /recordAgentActivationPublication|authorizeAgentActivationDispatch|commitAgentBackupRestore|SandboxRegistry|headscaleClient|mintAgentToken|ensureStewardTenant/,
    );
    for (const entrypoint of [
      "runAgentBackupRestoreQuarantinedCreate",
      "reconcileAgentBackupRestoreQuarantinedCreate",
    ]) {
      const paths = sources
        .flatMap(({ path, source }) => (source.includes(entrypoint) ? [path] : []))
        .map((path) => path.slice(REPOSITORY_ROOT.length))
        .sort();
      expect(paths, `${entrypoint} must remain definition-only`).toEqual([
        "/packages/cloud/shared/src/lib/services/agent-backup-restore-quarantined-create-runtime.ts",
      ]);
    }
    const runtimeAst = ts.createSourceFile(
      "agent-backup-restore-quarantined-create-runtime.ts",
      runtimeSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const runtimeFunctions = new Map<string, ts.FunctionDeclaration>();
    const runtimeFunctionCounts = new Map<string, number>();
    const entrypointCalls = new Map<string, number>();
    for (const entrypoint of [
      "runAgentBackupRestoreQuarantinedCreate",
      "reconcileAgentBackupRestoreQuarantinedCreate",
    ]) {
      entrypointCalls.set(entrypoint, 0);
    }
    const visitRuntime = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        runtimeFunctions.set(node.name.text, node);
        runtimeFunctionCounts.set(
          node.name.text,
          (runtimeFunctionCounts.get(node.name.text) ?? 0) + 1,
        );
      }
      if (ts.isCallExpression(node)) {
        const calledName = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : null;
        if (calledName && entrypointCalls.has(calledName)) {
          entrypointCalls.set(calledName, (entrypointCalls.get(calledName) ?? 0) + 1);
        }
      }
      ts.forEachChild(node, visitRuntime);
    };
    visitRuntime(runtimeAst);
    for (const [entrypoint, calls] of entrypointCalls) {
      expect(
        runtimeFunctionCounts.get(entrypoint) ?? 0,
        `${entrypoint} must have one production declaration`,
      ).toBe(1);
      expect(calls, `${entrypoint} gained a production invocation`).toBe(0);
    }
    const countDependencyCalls = (functionName: string, methodName: string): number => {
      const declaration = runtimeFunctions.get(functionName);
      if (!declaration?.body) return -1;
      let count = 0;
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "dependencies" &&
          node.expression.name.text === methodName
        ) {
          count += 1;
        }
        ts.forEachChild(node, visit);
      };
      visit(declaration.body);
      return count;
    };
    expect(
      countDependencyCalls("runAgentBackupRestoreQuarantinedCreate", "resolveImagePlatform"),
      "create must resolve one exact platform only before provider start",
    ).toBe(1);
    expect(
      countDependencyCalls("reconcileAgentBackupRestoreQuarantinedCreate", "resolveImagePlatform"),
      "cleanup reconciliation must never read mutable registry state",
    ).toBe(0);
  }, 60_000);

  test("keeps target reservation free of remote effects and generic identity bypasses", () => {
    const operationSource = readFileSync(
      join(import.meta.dir, "repositories/agent-backup-restore-operations.ts"),
      "utf8",
    );
    expect(operationSource).not.toMatch(
      /DockerNodeManager|getAvailableNode|nodeAutoscaler|parseDockerNodes|process\.env|ensureVolumeVaultPassphrase/,
    );
    const genericAdvance = operationSource.slice(
      operationSource.indexOf("export async function advanceAgentBackupRestoreOperation"),
      operationSource.indexOf("export async function heartbeatAgentBackupRestoreOperation"),
    );
    const advanceMutationStart = genericAdvance.indexOf(".set({");
    const advanceMutation = genericAdvance.slice(
      advanceMutationStart,
      genericAdvance.indexOf(".where(", advanceMutationStart),
    );
    expect(advanceMutation).not.toMatch(/expected_node_|expected_image_/);
    expect(genericAdvance).toContain(
      "Restore operation cannot leave target reservation without complete target authority",
    );
    expect(genericAdvance).toContain("operation.expected_node_history_id === null");

    const dockerNodeSource = readFileSync(
      join(import.meta.dir, "repositories/docker-nodes.ts"),
      "utf8",
    );
    expect(dockerNodeSource).toContain('"current_node_history_id"');
    expect(dockerNodeSource).not.toMatch(/\bcurrent_node_history_id\s*:/);

    const openOperation = operationSource.slice(
      operationSource.indexOf("export async function openAgentBackupRestoreOperation"),
      operationSource.indexOf("export async function claimAgentBackupRestoreOperation"),
    );
    const transactionalOpen = openOperation.slice(
      openOperation.indexOf("return await dbWrite.transaction"),
    );
    const openLockAnchors = [
      ".from(agentSandboxBackups)",
      ".from(agentBackupRestoreOperations)",
      ".from(agentBackupRestoreLeases)",
      "lockAgentBackupCatalogAuthority(",
      "readPostLockDatabaseNow(tx)",
    ];
    for (let index = 1; index < openLockAnchors.length; index += 1) {
      expect(transactionalOpen.indexOf(openLockAnchors[index - 1] as string)).toBeLessThan(
        transactionalOpen.indexOf(openLockAnchors[index] as string),
      );
    }

    const reserveDeclaration = "export async function reserveAgentBackupRestoreTarget(params:";
    const reserveSource = operationSource.slice(
      operationSource.indexOf(reserveDeclaration),
      operationSource.indexOf("export async function advanceAgentBackupRestoreOperation"),
    );
    expect(operationSource.indexOf(reserveDeclaration)).toBeGreaterThanOrEqual(0);
    const transactionalReserve = reserveSource.slice(
      reserveSource.indexOf("return await dbWrite.transaction"),
    );
    expect(reserveSource).toContain("targetNodeHistoryId: string");
    expect(reserveSource).toContain("expected_node_history_id: target.nodeHistoryId");
    const lockAnchors = [
      ".from(agentSandboxBackups)",
      ".from(agentBackupRestoreOperations)",
      ".from(agentBackupRestoreLeases)",
      ".from(dockerNodes)",
      "proveExactAgentNodeOccurrenceForLockedNode(",
      "lockAgentBackupCatalogAuthority(",
      "readPostLockDatabaseNow(tx)",
    ];
    for (let index = 1; index < lockAnchors.length; index += 1) {
      expect(transactionalReserve.indexOf(lockAnchors[index - 1] as string)).toBeLessThan(
        transactionalReserve.indexOf(lockAnchors[index] as string),
      );
    }

    const vaultSource = readFileSync(
      join(import.meta.dir, "repositories/agent-vault-key-authority.ts"),
      "utf8",
    );
    const restoreVaultAuthority = vaultSource.slice(
      vaultSource.indexOf("async function loadAgentBackupRestoreVaultGeneration"),
    );
    expect(restoreVaultAuthority).not.toMatch(
      /agentVaultKeyAuthorities|ensureVolumeVaultPassphrase|buildVolumeVaultPassphraseCommand/,
    );
    for (const requiredAuthorityField of [
      "restoreOperationId",
      "restoreClaimGeneration",
      "targetNodeRecordId",
      "targetNodeIncarnation",
      "targetNodeHistoryId",
    ]) {
      expect(restoreVaultAuthority).toContain(requiredAuthorityField);
    }

    const targetProof = restoreVaultAuthority.slice(
      restoreVaultAuthority.indexOf("async function proveAgentBackupRestoreVaultTargetAuthority"),
      restoreVaultAuthority.indexOf("export async function withAgentBackupRestoreVaultPassphrase"),
    );
    const vaultLockAnchors = [
      ".from(agentSandboxBackups)",
      ".from(agentBackupRestoreOperations)",
      ".from(agentBackupRestoreLeases)",
      ".from(dockerNodes)",
      "proveExactAgentNodeOccurrenceForLockedNode(",
      "lockAgentBackupCatalogAuthority(",
      "readPostLockDatabaseNow(tx)",
    ];
    for (let index = 1; index < vaultLockAnchors.length; index += 1) {
      expect(targetProof.indexOf(vaultLockAnchors[index - 1] as string)).toBeLessThan(
        targetProof.indexOf(vaultLockAnchors[index] as string),
      );
    }
    const finalClock = targetProof.indexOf("readPostLockDatabaseNow(tx)");
    const lockedHandoff = targetProof.indexOf(
      "runBoundedAgentBackupRestoreVaultTargetHandoff(",
      finalClock,
    );
    const postHandoffClock = targetProof.indexOf(
      "const afterHandoffDatabaseNow = await readPostLockDatabaseNow(tx)",
      lockedHandoff,
    );
    expect(finalClock).toBeGreaterThanOrEqual(0);
    expect(lockedHandoff).toBeGreaterThan(finalClock);
    expect(postHandoffClock).toBeGreaterThan(lockedHandoff);
    expect(targetProof.indexOf("return await dbWrite.transaction")).toBeGreaterThanOrEqual(0);
    expect(vaultSource).toContain("MAX_RESTORE_VAULT_HANDOFF_TIMEOUT_MS = 60_000");
    expect(vaultSource).toContain("RESTORE_VAULT_HANDOFF_AUTHORITY_MARGIN_MS = 1_000");
    expect(vaultSource).toContain("await Promise.race([");
    expect(vaultSource).toContain("controller.abort(timeoutError)");

    const historySource = readFileSync(
      join(import.meta.dir, "repositories/agent-backup-restore-history.ts"),
      "utf8",
    );
    const incarnationProof = historySource.slice(
      historySource.indexOf("export async function proveExactAgentNodeOccurrenceForLockedNode"),
      historySource.indexOf("async function lockCurrentNodeHistory"),
    );
    expect(incarnationProof).toContain("node.current_node_history_id !== expectedNodeHistoryId");
    expect(incarnationProof).toContain(
      "eq(agentNodeIncarnationHistories.id, expectedNodeHistoryId)",
    );
    expect(incarnationProof).not.toMatch(
      /\bxmin\b|\bage\s*\(|\bgte\s*\(|\bne\s*\(|created_at|attested_at/,
    );

    const vaultCallback = restoreVaultAuthority.slice(
      restoreVaultAuthority.indexOf("export async function withAgentBackupRestoreVaultPassphrase"),
    );
    const preKmsSource = vaultCallback.indexOf(
      "const beforeKms = await loadAgentBackupRestoreVaultGeneration(input)",
    );
    const preKmsTargetProof = vaultCallback.indexOf(
      "await proveAgentBackupRestoreVaultTargetAuthority(",
      preKmsSource,
    );
    const kmsDecrypt = vaultCallback.indexOf("await decryptGeneration(", preKmsTargetProof);
    const postKmsSource = vaultCallback.indexOf(
      "const afterKms = await loadAgentBackupRestoreVaultGeneration(input)",
      kmsDecrypt,
    );
    const postKmsTargetProof = vaultCallback.indexOf(
      "await proveAgentBackupRestoreVaultTargetAuthority(",
      preKmsTargetProof + 1,
    );
    const secretUse = vaultCallback.indexOf("secret.withPassphrase(", postKmsTargetProof);
    expect(preKmsSource).toBeGreaterThanOrEqual(0);
    expect(preKmsTargetProof).toBeGreaterThan(preKmsSource);
    expect(kmsDecrypt).toBeGreaterThan(preKmsTargetProof);
    expect(postKmsSource).toBeGreaterThan(kmsDecrypt);
    expect(postKmsTargetProof).toBeGreaterThan(postKmsSource);
    expect(secretUse).toBeGreaterThan(postKmsTargetProof);
    expect(vaultCallback.slice(preKmsTargetProof, kmsDecrypt)).not.toContain(
      "secret.withPassphrase",
    );
    expect(vaultCallback.slice(postKmsTargetProof, secretUse + 90)).toContain(
      "secret.withPassphrase((passphrase) => use(passphrase, signal), signal)",
    );
  });

  test("keeps cross-backup attempt mismatches out of the blocking lease lock", () => {
    const leaseSource = readFileSync(
      join(import.meta.dir, "repositories/agent-backup-restore-lease.ts"),
      "utf8",
    );
    const acquireSource = leaseSource.slice(
      leaseSource.indexOf("export async function acquireAgentBackupRestoreLease"),
      leaseSource.indexOf("export async function renewAgentBackupRestoreLease"),
    );
    const attemptLock = acquireSource.slice(
      acquireSource.indexOf("const [existingAttempt]"),
      acquireSource.indexOf("const [unreleased]"),
    );
    const blockingLookup = attemptLock.slice(0, attemptLock.indexOf("if (!existingAttempt)"));
    expect(blockingLookup).toContain("eq(agentBackupRestoreLeases.backup_id, params.backupId)");
    expect(blockingLookup).toContain('.for("update")');

    const divergentLookup = attemptLock.slice(attemptLock.indexOf("const [divergentAttempt]"));
    expect(divergentLookup).toContain(
      "eq(agentBackupRestoreLeases.restore_attempt_id, params.restoreAttemptId)",
    );
    expect(divergentLookup).not.toContain('.for("update")');
    expect(divergentLookup).toContain("Restore attempt replay authority mismatch");
  });

  test("keeps the restore quarantine DB-only, target-derived, and route-free", () => {
    const quarantineSource = readFileSync(
      join(import.meta.dir, "repositories/agent-backup-restore-quarantine.ts"),
      "utf8",
    );
    expect(quarantineSource).not.toMatch(
      /DockerSandboxProvider|DockerNodeManager|DockerSSHClient|getAvailableNode|nodeAutoscaler|parseDockerNodes|SandboxRegistry|SANDBOX_REGISTRY|ssh\.exec|process\.env|fetch\s*\(/i,
    );
    expect(quarantineSource).toContain("activation_generation: operation.restore_attempt_id");

    const lockOwningFunctions = [
      quarantineSource.slice(
        quarantineSource.indexOf("export async function openAgentBackupRestoreQuarantine"),
        quarantineSource.indexOf(
          "async function recordAgentBackupRestoreQuarantinedContainerBoundary",
        ),
      ),
      quarantineSource.slice(
        quarantineSource.indexOf(
          "async function recordAgentBackupRestoreQuarantinedContainerBoundary",
        ),
        quarantineSource.indexOf(
          "\nexport async function recordAgentBackupRestoreQuarantinedContainer(\n",
        ),
      ),
    ];
    const lockAnchors = [
      ".from(agentSandboxBackups)",
      ".from(agentBackupRestoreOperations)",
      ".from(agentBackupRestoreLeases)",
      ".from(agentSandboxes)",
      ".from(dockerNodes)",
      "proveExactAgentNodeOccurrenceForLockedNode(",
      "lockAgentBackupCatalogAuthority(",
      "readPostLockDatabaseNow(tx)",
    ];
    for (const source of lockOwningFunctions) {
      const transactional = source.slice(source.indexOf("return dbWrite.transaction"));
      for (let index = 1; index < lockAnchors.length; index += 1) {
        expect(transactional.indexOf(lockAnchors[index - 1] as string)).toBeLessThan(
          transactional.indexOf(lockAnchors[index] as string),
        );
      }
    }
    const sandboxMutations = [
      quarantineSource.slice(
        quarantineSource.indexOf(
          "export async function openAgentBackupRestoreQuarantineForLockedAuthoritiesInTransaction",
        ),
        quarantineSource.indexOf("export async function openAgentBackupRestoreQuarantine"),
      ),
      lockOwningFunctions[1] as string,
    ];
    for (const source of sandboxMutations) {
      const sandboxMutationStart = source.indexOf(".update(agentSandboxes)");
      const sandboxMutation = source.slice(
        source.indexOf(".set({", sandboxMutationStart),
        source.indexOf(".where(", sandboxMutationStart),
      );
      expect(sandboxMutation).not.toMatch(/\n\s+(?:sandbox_id|node_id|image_digest|status):/);
    }
  });

  test("contains no coordinator, capacity, billing, or probe migration in the dormant range", () => {
    const restoreMigrations = readdirSync(MIGRATIONS_DIR).filter((name) => {
      const ordinal = Number(name.slice(0, 4));
      return ordinal >= 236 && ordinal <= 250 && name.endsWith(".sql");
    });
    expect(restoreMigrations).toHaveLength(15);
    expect(restoreMigrations.join("\n")).not.toMatch(/capacity|billing|probe|coordinator/i);
    const migrationSource = restoreMigrations
      .map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf8"))
      .join("\n");
    expect(migrationSource).toContain("agent_backup_restore_receipts");
    expect(migrationSource).toContain("agent_vault_key_seed_receipts");
  });

  test("locks reservation replay before every sandbox and catalogue authority", () => {
    const catalogSource = readFileSync(
      join(import.meta.dir, "repositories/agent-backup-catalog.ts"),
      "utf8",
    );
    const replayHelper = catalogSource.slice(
      catalogSource.indexOf("export async function lockAgentBackupReservationReplayInTransaction"),
      catalogSource.indexOf("export async function reserveAgentBackupOperationInTransaction"),
    );
    const replayBackup = replayHelper.indexOf(".from(agentSandboxBackups)");
    const replayOperation = replayHelper.indexOf(
      "eq(agentSandboxBackups.backup_operation_id",
      replayBackup,
    );
    const replayForUpdate = replayHelper.indexOf('.for("update")', replayOperation);
    expect(replayBackup).toBeGreaterThanOrEqual(0);
    expect(replayOperation).toBeGreaterThan(replayBackup);
    expect(replayForUpdate).toBeGreaterThan(replayOperation);

    const reservation = catalogSource.slice(
      catalogSource.indexOf("export async function reserveAgentBackupOperationInTransaction"),
      catalogSource.indexOf("export async function claimDueAgentBackupOperations"),
    );
    const reserveReplay = reservation.indexOf(
      "await lockAgentBackupReservationReplayInTransaction(tx, input)",
    );
    const reserveSandbox = reservation.indexOf(".from(agentSandboxes)", reserveReplay);
    const authorityLock = reservation.indexOf("const reservationAuthority");
    expect(reserveReplay).toBeGreaterThanOrEqual(0);
    expect(reserveSandbox).toBeGreaterThan(reserveReplay);
    expect(authorityLock).toBeGreaterThan(reserveSandbox);

    const schedulerSource = readFileSync(
      join(import.meta.dir, "repositories/agent-backup-scheduler.ts"),
      "utf8",
    );
    const scheduleReservation = schedulerSource.slice(
      schedulerSource.indexOf("export async function reserveClaimedAgentBackupSchedule"),
      schedulerSource.indexOf("export async function failClaimedAgentBackupSchedule"),
    );
    const schedulerReplay = scheduleReservation.indexOf(
      "await lockAgentBackupReservationReplayInTransaction(tx, claim)",
    );
    const schedulerSandbox = scheduleReservation.indexOf("await lockClaimedSandbox(tx, claim)");
    expect(schedulerReplay).toBeGreaterThanOrEqual(0);
    expect(schedulerSandbox).toBeGreaterThan(schedulerReplay);
  });
});
