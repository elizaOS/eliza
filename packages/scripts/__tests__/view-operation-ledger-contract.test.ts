/**
 * Exercises source-derived view control evidence with deterministic TSX
 * fixtures; no runtime operation registry or renderer is mocked as proven.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __test } from "../lib/view-operation-ledger.mjs";

function scanFixture(sourceText: string) {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "view-ledger-contract-"));
  const source = "Fixture.tsx";
  writeFileSync(path.join(repoRoot, source), sourceText, "utf8");
  try {
    return __test.scanControlsForSurface(
      { id: "fixture", owner: "fixture-owner" },
      [source],
      repoRoot,
      new Map(),
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function expectUnverified(operation: Record<string, unknown> | undefined) {
  expect(operation).toMatchObject({
    contractStatus: "dom-handler-only",
    authorization: "unverified-dom-handler",
    idempotency: "unverified-dom-handler",
    confirmation: "unverified-dom-handler",
    channels: { view: true, widget: false, chat: false, voice: false },
    output: {
      type: "UnverifiedDomInteractionResult",
      fields: "unknown",
    },
  });
}

function ledgerFor(operations: Array<Record<string, unknown>>) {
  return {
    viewInventoryCount: 1,
    registeredSurfaceCount: 0,
    registrationOverlapCount: 0,
    surfaceCount: 1,
    surfaces: [{ id: "fixture", kind: "plugin" }],
    operations: operations.map((operation) => ({
      ...operation,
      delivery: {},
      evidence: { contractProven: false, tests: [] },
    })),
  };
}

describe("view operation ledger contract provenance", () => {
  it("does not promote an ordinary clickable handler into a runtime contract", () => {
    const { operations } = scanFixture(`
      export function Fixture() {
        return <button data-agent-id="save" onClick={() => save()}>Save</button>;
      }
    `);
    expect(operations).toHaveLength(1);
    expect(operations[0].semanticEvidence).toHaveLength(1);
    expectUnverified(operations[0]);
    expect(() => __test.assertLedger(ledgerFor(operations))).toThrow(
      /unverified-runtime-operation-contract/,
    );
  });

  it("keeps delegated human-authority handlers unverified", () => {
    const { operations } = scanFixture(`
      export function Fixture(props) {
        return <button data-agent-id="approve" onClick={props.onApprove}>Approve</button>;
      }
    `);
    expect(operations[0]).toMatchObject({
      semanticMutation: true,
      semanticEvidence: [{ text: "props.onApprove" }],
    });
    expectUnverified(operations[0]);
  });

  it("uses the exact hook binding when wrapper controls have similar names", () => {
    const { operations } = scanFixture(`
      export function Fixture(props) {
        const { agentProps: archiveAgentProps } = useAgentElement({
          id: "archive",
          label: "Archive",
          role: "button",
        });
        const { agentProps: saveAgentProps } = useAgentElement({
          id: "save",
          label: "Save",
          role: "button",
        });
        return <>
          <Wrapper {...archiveAgentProps} onClick={props.onArchive} />
          <Wrapper {...saveAgentProps} onClick={props.onSave} />
        </>;
      }
    `);
    const archive = operations.find(
      (operation) => operation.control.id === "archive",
    );
    const save = operations.find(
      (operation) => operation.control.id === "save",
    );
    expect(archive?.semanticEvidence[0].text).toBe("props.onArchive");
    expect(save?.semanticEvidence[0].text).toBe("props.onSave");
    expectUnverified(archive);
    expectUnverified(save);
  });

  it("fails closed when source controls collide on one semantic identity", () => {
    const { operations } = scanFixture(`
      export function Fixture() {
        return <>
          <button data-agent-id="save" onClick={() => saveDraft()}>Draft</button>
          <button data-agent-id="save" onClick={() => saveFinal()}>Final</button>
        </>;
      }
    `);
    expect(operations.map((operation) => operation.operationId)).toEqual([
      "fixture.control.Fixture.save",
      "fixture.control.Fixture.save",
    ]);
    expect(() => __test.assertLedger(ledgerFor(operations))).toThrow(
      /duplicate-operation-id/,
    );
  });

  it("never invents confirmation or receipts for dangerous controls", () => {
    const { operations } = scanFixture(`
      export function Fixture({ deleteAccount }) {
        return (
          <button data-agent-id="delete-account" onClick={deleteAccount}>
            Delete account
          </button>
        );
      }
    `);
    expect(operations[0].semanticMutation).toBe(true);
    expect(operations[0].errors).toEqual([
      "UNVERIFIED_RUNTIME_OPERATION_CONTRACT",
    ]);
    expectUnverified(operations[0]);
  });
});
