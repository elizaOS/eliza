/**
 * Exercises the host-node JsRuntimeBridge (the `node:vm`-backed implementation)
 * through the real resolver: expression evaluation and JsValue marshalling,
 * `globalThis.process` sandbox isolation, `timeoutMs` enforcement, and importing
 * a real `.mjs` fixture from a temp dir. Deterministic; no mocks.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetJsRuntimeBridgeForTests,
  type JsRuntimeBridge,
  resolveJsRuntimeBridge,
} from "./js-runtime-bridge.ts";

describe("js-runtime-bridge (host-node)", () => {
  let bridge: JsRuntimeBridge;

  beforeEach(async () => {
    __resetJsRuntimeBridgeForTests();
    bridge = await resolveJsRuntimeBridge();
  });

  afterEach(async () => {
    await bridge.dispose();
    __resetJsRuntimeBridgeForTests();
  });

  it("evaluates a simple expression and returns a number JsValue", async () => {
    const result = await bridge.evaluate({ code: "(()=>1+2)()" });
    expect(result).toEqual({ kind: "number", value: 3 });
    expect(bridge.kind).toBe("host-node");
  });

  it("sandboxes globalThis.process so it does not leak into evaluated code", async () => {
    const result = await bridge.evaluate({
      code: "typeof globalThis.process === 'undefined' ? null : 'leaked'",
    });
    expect(result).toEqual({ kind: "null" });
  });

  it("enforces evaluate timeoutMs", async () => {
    await expect(
      bridge.evaluate({
        code: "while (true) {}",
        timeoutMs: 50,
      }),
    ).rejects.toThrow();
  });

  it("imports a real module file and returns its exports as a JsValue object", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js-runtime-bridge-"));
    const modulePath = join(dir, "fixture.mjs");
    writeFileSync(
      modulePath,
      "export const value = 42;\nexport const name = 'eliza';\n",
      "utf8",
    );

    const { exports } = await bridge.importModule({
      absolutePath: modulePath,
    });

    expect(exports.kind).toBe("object");
    if (exports.kind !== "object") return;
    const entries = new Map(exports.entries);
    expect(entries.get("value")).toEqual({ kind: "number", value: 42 });
    expect(entries.get("name")).toEqual({ kind: "string", value: "eliza" });
  });

  it("marshals shared (non-cyclic) references as full values, not as [cycle]", async () => {
    // A value graph that reuses one object from two places is a DAG, not a
    // cycle; every reference must marshal to the same full JsValue.
    const result = await bridge.evaluate({
      code: "(() => { const shared = { id: 'cfg', n: 1 }; return { a: shared, b: shared, list: [shared, shared] }; })()",
    });
    const sharedValue = {
      kind: "object",
      entries: [
        ["id", { kind: "string", value: "cfg" }],
        ["n", { kind: "number", value: 1 }],
      ],
    };
    expect(result).toEqual({
      kind: "object",
      entries: [
        ["a", sharedValue],
        ["b", sharedValue],
        ["list", { kind: "array", items: [sharedValue, sharedValue] }],
      ],
    });
  });

  it("still collapses a true cycle to [cycle] and marshals its siblings", async () => {
    const result = await bridge.evaluate({
      code: "(() => { const root = { name: 'root' }; root.self = root; root.child = { parent: root, tag: 't' }; return root; })()",
    });
    expect(result).toEqual({
      kind: "object",
      entries: [
        ["name", { kind: "string", value: "root" }],
        ["self", { kind: "string", value: "[cycle]" }],
        [
          "child",
          {
            kind: "object",
            entries: [
              ["parent", { kind: "string", value: "[cycle]" }],
              ["tag", { kind: "string", value: "t" }],
            ],
          },
        ],
      ],
    });
  });

  it("bounds a diamond-shaped shared graph instead of expanding it exponentially", async () => {
    // 21 distinct objects inside the depth cap, each holding the same next
    // level under two keys: 2^20 paths. The marshal must stop at the node
    // ceiling (100 000 emitted values), not at the heap.
    const started = performance.now();
    const result = await bridge.evaluate({
      code: "(() => { let level = { leaf: true }; for (let i = 0; i < 20; i++) level = { l: level, r: level }; return level; })()",
    });
    const elapsedMs = performance.now() - started;
    let budgeted = 0;
    let sizeLimits = 0;
    const walk = (value: unknown): void => {
      const node = value as {
        kind: string;
        value?: unknown;
        entries?: unknown[];
        items?: unknown[];
      };
      if (node.kind === "string" && node.value === "[size-limit]") {
        sizeLimits += 1;
        return;
      }
      budgeted += 1;
      for (const [, child] of (node.entries ?? []) as Array<[string, unknown]>)
        walk(child);
      for (const child of node.items ?? []) walk(child);
    };
    walk(result);
    expect(sizeLimits).toBeGreaterThan(0);
    expect(budgeted).toBeLessThanOrEqual(100_000);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it("does not mint one function id per path once the node ceiling is reached", async () => {
    const result = await bridge.evaluate({
      code: "(() => { const fn = () => 1; let level = { fn }; for (let i = 0; i < 20; i++) level = { l: level, r: level }; return level; })()",
    });
    const ids = new Set<string>();
    const walk = (value: unknown): void => {
      const node = value as {
        kind: string;
        functionId?: string;
        entries?: unknown[];
        items?: unknown[];
      };
      if (node.kind === "function" && node.functionId) ids.add(node.functionId);
      for (const [, child] of (node.entries ?? []) as Array<[string, unknown]>)
        walk(child);
      for (const child of node.items ?? []) walk(child);
    };
    walk(result);
    expect(ids.size).toBeGreaterThan(0);
    expect(ids.size).toBeLessThanOrEqual(100_000);
  });
});
