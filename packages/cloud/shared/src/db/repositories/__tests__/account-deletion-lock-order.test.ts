/** Statically ratchets the PostgreSQL account-deletion row-lock order. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositorySource = readFileSync(
  join(import.meta.dir, "..", "account-deletion-requests.ts"),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

interface Anchor {
  label: string;
  pattern: RegExp;
}

const ORGANIZATION_ACCESS: Anchor = {
  label: "first organization access",
  pattern: /\.(?:from|update|insert|delete)\(organizations\)/,
};
const ORGANIZATION_LOCK: Anchor = {
  label: "organization FOR UPDATE",
  pattern: /\.from\(organizations\)[^;]*\.for\("update"\)/s,
};
const USERS_ACCESS: Anchor = {
  label: "first users access",
  pattern: /\.(?:from|update|insert|delete)\(users\)/,
};
const SORTED_USERS_LOCK: Anchor = {
  label: "users ordered by id FOR UPDATE",
  pattern: /\.from\(users\)[^;]*\.orderBy\(\s*asc\(users\.id\),?\s*\)[^;]*\.for\("update"\)/s,
};
const REQUEST_LOCK: Anchor = {
  label: "request FOR UPDATE",
  pattern: /\.from\(accountDeletionRequests\)[^;]*\.for\("update"\)/s,
};
const REQUEST_TABLE_ACCESS: Anchor = {
  label: "first direct request access",
  pattern: /\.(?:from|update|insert|delete)\(accountDeletionRequests\)/,
};
const REQUEST_LOCK_HELPER: Anchor = {
  label: "request lock helper",
  pattern: /await lockAccountDeletionRequest\(tx,\s*[^)]+\)/s,
};
const REQUEST_ACCESS: Anchor = {
  label: "first request access",
  pattern:
    /(?:await lockAccountDeletionRequest\(tx,\s*[^)]+\)|\.(?:from|update|insert|delete)\(accountDeletionRequests\))/s,
};
const EXPORT_LOCK: Anchor = {
  label: "export FOR UPDATE",
  pattern: /\.from\(accountDeletionExports\)[^;]*\.for\("update"\)/s,
};
const EXPORT_TABLE_ACCESS: Anchor = {
  label: "first direct export access",
  pattern: /\.(?:from|update|insert|delete)\(accountDeletionExports\)/,
};
const EXPORT_LOCK_HELPER: Anchor = {
  label: "export lock helper",
  pattern: /await lockAccountDeletionExport\(tx,\s*[^)]+\)/s,
};
const EXPORT_MUTATION: Anchor = {
  label: "first export mutation",
  pattern: /\.update\(accountDeletionExports\)/,
};
const EXPORT_ACCESS: Anchor = {
  label: "first export access",
  pattern:
    /(?:await lockAccountDeletionExport\(tx,\s*[^)]+\)|\.(?:from|update|insert|delete)\(accountDeletionExports\))/s,
};
const PHASE_ACCESS: Anchor = {
  label: "first phase access",
  pattern: /\.(?:from|update|insert|delete)\(accountDeletionPhaseReceipts\)/,
};
const SORTED_PHASES_LOCK: Anchor = {
  label: "phases ordered by phase order and id FOR UPDATE",
  pattern:
    /\.from\(accountDeletionPhaseReceipts\)[^;]*\.orderBy\(\s*asc\(accountDeletionPhaseReceipts\.phase_order\),\s*asc\(accountDeletionPhaseReceipts\.id\),?\s*\)[^;]*\.for\("update"\)/s,
};

function method(name: string): string {
  const start = repositorySource.indexOf(`  async ${name}(`);
  expect(start, `${name} must remain present`).toBeGreaterThanOrEqual(0);
  const end = repositorySource.indexOf("\n  async ", start + 1);
  return repositorySource.slice(start, end >= 0 ? end : undefined);
}

function transactionBody(name: string): string {
  const body = method(name);
  const marker = "transaction(async (tx) => {";
  const start = body.indexOf(marker);
  expect(start, `${name} must use an explicit transaction`).toBeGreaterThanOrEqual(0);
  return body.slice(start + marker.length);
}

function standaloneFunction(name: string): string {
  const start = repositorySource.indexOf(`async function ${name}(`);
  expect(start, `${name} helper must remain present`).toBeGreaterThanOrEqual(0);
  const end = repositorySource.indexOf("\n}\n", start);
  expect(end, `${name} helper must remain bounded`).toBeGreaterThan(start);
  return repositorySource.slice(start, end + 2);
}

function expectOrdered(name: string, anchors: readonly Anchor[]): void {
  const body = transactionBody(name);
  let previous = -1;
  for (const anchor of anchors) {
    const index = body.search(anchor.pattern);
    expect(index, `${name}: missing ${anchor.label}`).toBeGreaterThanOrEqual(0);
    expect(index, `${name}: ${anchor.label} is out of order`).toBeGreaterThan(previous);
    previous = index;
  }
}

function expectFirstAccessIs(name: string, access: Anchor, expected: Anchor): void {
  const body = transactionBody(name);
  const accessIndex = body.search(access.pattern);
  const expectedIndex = body.search(expected.pattern);
  expect(accessIndex, `${name}: missing ${access.label}`).toBeGreaterThanOrEqual(0);
  expect(expectedIndex, `${name}: missing ${expected.label}`).toBeGreaterThanOrEqual(0);
  expect(accessIndex, `${name}: ${access.label} must be ${expected.label}`).toBe(expectedIndex);
}

describe("account deletion global lock order", () => {
  test("request and export lock helpers retain real FOR UPDATE queries", () => {
    const requestHelper = standaloneFunction("lockAccountDeletionRequest");
    const requestAccessIndex = requestHelper.search(REQUEST_TABLE_ACCESS.pattern);
    const requestLockIndex = requestHelper.search(REQUEST_LOCK.pattern);
    expect(requestAccessIndex).toBeGreaterThanOrEqual(0);
    expect(requestLockIndex).toBeGreaterThanOrEqual(0);
    expect(requestAccessIndex).toBe(requestLockIndex);
    for (const forbidden of [
      ORGANIZATION_ACCESS,
      USERS_ACCESS,
      EXPORT_TABLE_ACCESS,
      PHASE_ACCESS,
    ]) {
      expect(requestHelper.search(forbidden.pattern), forbidden.label).toBe(-1);
    }

    const exportHelper = standaloneFunction("lockAccountDeletionExport");
    const exportAccessIndex = exportHelper.search(EXPORT_TABLE_ACCESS.pattern);
    const exportLockIndex = exportHelper.search(EXPORT_LOCK.pattern);
    expect(exportAccessIndex).toBeGreaterThanOrEqual(0);
    expect(exportLockIndex).toBeGreaterThanOrEqual(0);
    expect(exportAccessIndex).toBe(exportLockIndex);
    for (const forbidden of [
      ORGANIZATION_ACCESS,
      USERS_ACCESS,
      REQUEST_TABLE_ACCESS,
      PHASE_ACCESS,
    ]) {
      expect(exportHelper.search(forbidden.pattern), forbidden.label).toBe(-1);
    }
  });

  test("root lifecycle writers take deterministic organization, member, and request locks", () => {
    for (const name of [
      "reservePersonalAccountDeletion",
      "activateReservedPersonalAccountDeletion",
      "activateExpiredPersonalAccountDeletion",
      "finalizePersonalAccountDeletion",
      "cancelDuringRecovery",
      "finalizeCancellationIfComplete",
    ]) {
      expectOrdered(name, [ORGANIZATION_ACCESS, USERS_ACCESS, REQUEST_ACCESS]);
      expectFirstAccessIs(name, ORGANIZATION_ACCESS, ORGANIZATION_LOCK);
      expectFirstAccessIs(name, USERS_ACCESS, SORTED_USERS_LOCK);
      expectFirstAccessIs(name, REQUEST_ACCESS, REQUEST_LOCK);
    }
    expectOrdered("reservePersonalAccountDeletion", [REQUEST_ACCESS, PHASE_ACCESS]);
    expectOrdered("reservePersonalAccountDeletion", [REQUEST_ACCESS, EXPORT_ACCESS]);
    expectOrdered("activateReservedPersonalAccountDeletion", [REQUEST_ACCESS, PHASE_ACCESS]);
  });

  test("existing export rows precede every contended phase access", () => {
    expectOrdered("activateExpiredPersonalAccountDeletion", [
      REQUEST_ACCESS,
      EXPORT_ACCESS,
      PHASE_ACCESS,
    ]);
    expectFirstAccessIs("activateExpiredPersonalAccountDeletion", EXPORT_ACCESS, EXPORT_LOCK);
    expectFirstAccessIs("activateExpiredPersonalAccountDeletion", PHASE_ACCESS, SORTED_PHASES_LOCK);

    expectOrdered("finalizePersonalAccountDeletion", [REQUEST_ACCESS, EXPORT_ACCESS, PHASE_ACCESS]);
    expectFirstAccessIs("finalizePersonalAccountDeletion", EXPORT_ACCESS, EXPORT_LOCK_HELPER);
    expectFirstAccessIs("finalizePersonalAccountDeletion", PHASE_ACCESS, SORTED_PHASES_LOCK);

    expectOrdered("cancelDuringRecovery", [REQUEST_ACCESS, EXPORT_ACCESS, PHASE_ACCESS]);
    expectFirstAccessIs("cancelDuringRecovery", EXPORT_ACCESS, EXPORT_MUTATION);
    expectOrdered("finalizeCancellationIfComplete", [REQUEST_ACCESS, PHASE_ACCESS]);
    expectFirstAccessIs("finalizeCancellationIfComplete", PHASE_ACCESS, SORTED_PHASES_LOCK);
    expectOrdered("ensureExportRevocationPhase", [REQUEST_ACCESS, EXPORT_ACCESS, PHASE_ACCESS]);
    expectFirstAccessIs("ensureExportRevocationPhase", REQUEST_ACCESS, REQUEST_LOCK_HELPER);
    expectFirstAccessIs("ensureExportRevocationPhase", EXPORT_ACCESS, EXPORT_LOCK_HELPER);
  });

  test("phase completion helpers never take a child row before its parents", () => {
    for (const name of [
      "markPhaseActionRequired",
      "completeStewardDeactivationPhase",
      "completeStewardReactivationPhase",
    ]) {
      expectOrdered(name, [REQUEST_ACCESS, PHASE_ACCESS]);
      expectFirstAccessIs(name, REQUEST_ACCESS, REQUEST_LOCK_HELPER);
    }
    expectOrdered("completeExportPhase", [REQUEST_ACCESS, EXPORT_ACCESS, PHASE_ACCESS]);
    expectFirstAccessIs("completeExportPhase", REQUEST_ACCESS, REQUEST_LOCK_HELPER);
    expectFirstAccessIs("completeExportPhase", EXPORT_ACCESS, EXPORT_LOCK_HELPER);
    expectOrdered("markExportBuilding", [EXPORT_ACCESS, PHASE_ACCESS]);
    expectFirstAccessIs("markExportBuilding", EXPORT_ACCESS, EXPORT_LOCK_HELPER);
    expectOrdered("completeExportRevocation", [EXPORT_ACCESS, PHASE_ACCESS]);
    expectFirstAccessIs("completeExportRevocation", EXPORT_ACCESS, EXPORT_LOCK_HELPER);
  });

  test("keeps the required RealPG command and fail-closed env in one hosted step", () => {
    const workflow = readFileSync(
      join(import.meta.dir, "../../../../../../../.github/workflows/cloud-tests.yml"),
      "utf8",
    ).replace(/^\s*#.*$/gm, "");
    const stepName = "- name: Run PostgreSQL account deletion lock-order tests";
    const start = workflow.indexOf(stepName);
    expect(start, "required hosted step must remain present").toBeGreaterThanOrEqual(0);
    const end = workflow.indexOf("\n      - name:", start + stepName.length);
    const step = workflow.slice(start, end >= 0 ? end : undefined);

    expect(step).toContain('REQUIRE_REAL_POSTGRES_ACCOUNT_DELETION_LOCK_TESTS: "1"');
    expect(step).toContain("bun test --config=/dev/null --isolate");
    expect(step).toContain(
      "packages/cloud/shared/src/db/repositories/__tests__/account-deletion-cancel-expiry-postgres.integration.test.ts",
    );
  });
});
