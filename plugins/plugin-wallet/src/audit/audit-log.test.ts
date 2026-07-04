/**
 * Wallet audit log integrity (#8801 — shipped untested). Each row is a SHA-256
 * over its canonical fields, chained via `prevHash`, so the log is tamper-
 * evident: `verifyAuditLogRow` must accept an untouched row and REJECT any row
 * whose content, prevHash, or stored hash was altered after the fact. That
 * tamper-detection is the whole point of the log, so it is pinned here.
 */
import { describe, expect, it } from "vitest";
import {
  type AuditLogRow,
  type AuditLogRowInput,
  createAuditLogRow,
  verifyAuditLogRow,
} from "./audit-log.ts";

const input = (over: Partial<AuditLogRowInput> = {}): AuditLogRowInput =>
  ({
    actor: "agent",
    kind: "sign",
    scope: null,
    actionName: "transfer",
    paramsHash: "deadbeef",
    approvalId: null,
    outcome: "allowed",
    failureCode: null,
    detail: "send 1.0 ETH",
    ts: 1_000,
    id: 1n,
    ...over,
  }) as AuditLogRowInput;

describe("createAuditLogRow / verifyAuditLogRow", () => {
  it("verifies an untouched row", () => {
    expect(verifyAuditLogRow(createAuditLogRow(input()))).toBe(true);
  });

  it("defaults prevHash to the genesis hash", () => {
    const row = createAuditLogRow(input());
    expect(row.prevHash).toBe("0".repeat(64));
  });

  it("REJECTS a row whose content was altered after hashing", () => {
    const row = createAuditLogRow(input());
    for (const tamper of [
      { outcome: "denied" },
      { detail: "send 1000 ETH" },
      { actionName: "drain" },
      { prevHash: "f".repeat(64) },
      { rowHash: "0".repeat(64) },
    ] as Partial<AuditLogRow>[]) {
      expect(verifyAuditLogRow({ ...row, ...tamper })).toBe(false);
    }
  });

  it("chains rows so tampering an earlier row is detectable", () => {
    const row1 = createAuditLogRow(input({ id: 1n }));
    const row2 = createAuditLogRow(input({ id: 2n, prevHash: row1.rowHash }));
    expect(verifyAuditLogRow(row2)).toBe(true);
    expect(row2.prevHash).toBe(row1.rowHash); // links to the previous row
    // tampering row1's content invalidates row1 (and its hash no longer matches
    // what row2 committed to via prevHash)
    const tamperedRow1 = { ...row1, detail: "forged" };
    expect(verifyAuditLogRow(tamperedRow1)).toBe(false);
    expect(row2.prevHash).not.toBe(
      createAuditLogRow(input({ id: 1n, detail: "forged" })).rowHash,
    );
  });
});
