/**
 * Validates production-derived operation discovery and deterministic failure
 * fixtures without letting a test-owned surface roster become authority.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { discoverPluginViewInventory } from "../lib/plugin-view-inventory.mjs";
import {
  __test,
  discoverRegisteredSurfaceInventory,
  discoverViewOperationLedger,
  renderViewOperationLedgerMarkdown,
} from "../lib/view-operation-ledger.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
let productionLedger: ReturnType<typeof discoverViewOperationLedger>;

function fixtureLedger(operations: Array<Record<string, unknown>>) {
  return {
    viewInventoryCount: 1,
    registeredSurfaceCount: 0,
    registrationOverlapCount: 0,
    surfaceCount: 1,
    surfaces: [{ id: "demo", kind: "plugin" }],
    operations,
  };
}

describe("view operation ledger", () => {
  beforeAll(() => {
    productionLedger = discoverViewOperationLedger({
      repoRoot: REPO_ROOT,
      validate: false,
    });
  }, 30_000);

  it("derives every surface and control from production registrations", () => {
    const ledger = productionLedger;
    const viewIds = new Set(
      discoverPluginViewInventory({ repoRoot: REPO_ROOT }).views.map(
        (view) => view.id,
      ),
    );
    const registeredIds = new Set(
      discoverRegisteredSurfaceInventory({ repoRoot: REPO_ROOT }).map(
        (surface) => surface.id,
      ),
    );
    const overlap = [...registeredIds].filter((id) => viewIds.has(id)).length;
    expect(ledger.viewInventoryCount).toBe(viewIds.size);
    expect(ledger.registeredSurfaceCount).toBe(registeredIds.size);
    expect(ledger.registrationOverlapCount).toBe(overlap);
    expect(
      ledger.viewInventoryCount +
        ledger.registeredSurfaceCount -
        ledger.registrationOverlapCount,
    ).toBe(ledger.surfaceCount);
    expect(ledger.operationCount).toBeGreaterThan(0);
    expect(ledger.channelCounts.chat).toBeGreaterThan(0);
    expect(ledger.channelCounts.voice).toBe(ledger.channelCounts.chat);
    expect(ledger.operations.every((operation) => operation.source.file)).toBe(
      true,
    );
    expect(ledger.unresolvedControls).toEqual([]);
  });

  it("renders deterministic reviewer-readable markdown", () => {
    const ledger = productionLedger;
    const first = renderViewOperationLedgerMarkdown(ledger);
    const second = renderViewOperationLedgerMarkdown(ledger);
    expect(first).toBe(second);
    expect(first).toContain("# Runtime view operation ledger");
    expect(first).toContain("| Operation | Surface | Classification |");
  });

  it("fails on duplicate operation ids", () => {
    const operation = {
      operationId: "demo.control.save",
      surfaceId: "demo",
      owner: "demo-owner",
      useCase: "Save demo",
      classification: "agent-operation",
      input: {},
      output: {},
      errors: [],
      authorization: "authenticated-owner",
      idempotency: "idempotent-set",
      confirmation: "none",
      channels: { view: true, widget: true, chat: true, voice: true },
      sensitive: false,
      source: { file: "fixture.tsx", line: 1 },
    };
    expect(() =>
      __test.assertLedger(fixtureLedger([operation, { ...operation }])),
    ).toThrow(/duplicate-operation-id/);
  });

  it("fails on sensitive chat or voice projection", () => {
    const operation = {
      operationId: "demo.control.password",
      surfaceId: "demo",
      owner: "demo-owner",
      useCase: "Enter password",
      classification: "secure-sensitive",
      input: {},
      output: {},
      errors: [],
      authorization: "native-sensitive-boundary",
      idempotency: "idempotent-set",
      confirmation: "none",
      channels: { view: true, widget: false, chat: true, voice: true },
      sensitive: true,
      source: { file: "fixture.tsx", line: 1 },
    };
    expect(() => __test.assertLedger(fixtureLedger([operation]))).toThrow(
      /sensitive-channel-leak/,
    );
  });

  it("fails when a semantic mutation is mislabeled view-only", () => {
    const operation = {
      operationId: "demo.view-only.save.onClick",
      surfaceId: "demo",
      owner: "demo-owner",
      useCase: "Local save",
      classification: "view-only",
      input: {},
      output: {},
      errors: [],
      authorization: "view-session",
      idempotency: "presentation-local",
      confirmation: "none",
      channels: { view: true, widget: false, chat: false, voice: false },
      sensitive: false,
      mutationRisk: true,
      source: { file: "fixture.tsx", line: 1 },
    };
    expect(() => __test.assertLedger(fixtureLedger([operation]))).toThrow(
      /direct-view-only-business-mutation/,
    );
  });

  it("fails arbitrary view-only justification text", () => {
    const operation = {
      operationId: "demo.view-only.filter.onChange",
      surfaceId: "demo",
      owner: "demo-owner",
      useCase: "Local filter",
      classification: "view-only",
      input: {},
      output: {},
      errors: [],
      authorization: "view-session",
      idempotency: "presentation-local",
      confirmation: "none",
      channels: { view: true, widget: false, chat: false, voice: false },
      sensitive: false,
      semanticMutation: false,
      mutationRisk: false,
      justificationCode: "local-selection",
      viewOnlyReason: "This arbitrary prose must not become policy.",
      source: { file: "fixture.tsx", line: 1 },
    };
    expect(() => __test.assertLedger(fixtureLedger([operation]))).toThrow(
      /invalid-view-only-justification/,
    );
  });

  it("fails a generic-indirection mutation without canonical linkage", () => {
    const operation = {
      operationId: "demo.view-only.handle-action.onClick",
      surfaceId: "demo",
      owner: "demo-owner",
      useCase: "Delegate action",
      classification: "view-only",
      input: {},
      output: {},
      errors: [],
      authorization: "view-session",
      idempotency: "presentation-local",
      confirmation: "none",
      channels: { view: true, widget: false, chat: false, voice: false },
      sensitive: false,
      semanticMutation: false,
      mutationRisk: false,
      unresolvedMutation: true,
      justificationCode: "ast-proven-local",
      viewOnlyReason: __test.VIEW_ONLY_JUSTIFICATIONS["ast-proven-local"],
      source: { file: "fixture.tsx", line: 1 },
    };
    expect(() => __test.assertLedger(fixtureLedger([operation]))).toThrow(
      /unresolved-semantic-mutation/,
    );
  });

  it("does not let ambiguous same-verb capabilities excuse a mutation", () => {
    const mutation = {
      operationId: "demo.view-only.save.onClick",
      surfaceId: "demo",
      owner: "demo-owner",
      useCase: "Save demo",
      classification: "view-only",
      input: {},
      output: {},
      errors: [],
      authorization: "view-session",
      idempotency: "presentation-local",
      confirmation: "none",
      channels: { view: true, widget: false, chat: false, voice: false },
      sensitive: false,
      semanticMutation: true,
      mutationRisk: true,
      justificationCode: "ast-proven-local",
      viewOnlyReason: __test.VIEW_ONLY_JUSTIFICATIONS["ast-proven-local"],
      source: { file: "fixture.tsx", line: 1 },
    };
    expect(() =>
      __test.assertLedger(
        fixtureLedger([
          mutation,
          ...["save-draft", "save-published"].map((id) => ({
            ...mutation,
            operationId: `demo.capability.${id}`,
            classification: "view-capability",
            channels: { view: true, widget: true, chat: true, voice: true },
            mutationRisk: false,
            justificationCode: undefined,
            viewOnlyReason: undefined,
          })),
        ]),
      ),
    ).toThrow(/direct-view-only-business-mutation/);
  });

  it("fails registration arithmetic drift", () => {
    expect(() =>
      __test.assertLedger({
        ...fixtureLedger([]),
        registeredSurfaceCount: 1,
        registrationOverlapCount: 0,
      }),
    ).toThrow(/surface-inventory-drift/);
  });

  it("fails when a registered surface has no operation", () => {
    expect(() =>
      __test.assertLedger({
        viewInventoryCount: 0,
        registeredSurfaceCount: 1,
        registrationOverlapCount: 0,
        surfaceCount: 1,
        surfaces: [{ id: "orphan", kind: "overlay" }],
        operations: [],
      }),
    ).toThrow(/surface-without-operation/);
  });
});
