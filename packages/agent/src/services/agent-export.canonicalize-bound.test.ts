/**
 * Fail-closed canonicalize walk for agent export integrity digests.
 *
 * Origin develop JSON.parse'd a 20k-deep nest (legal, ~120 KiB, under the
 * 16 MiB gunzip cap) then RangeError'd in canonicalize during
 * verifyExportManifest. Cyclic graphs and enumerable getters did the same.
 * Depth/node/cycle fail-closed replaces that with AgentExportError
 * AGENT_EXPORT_CANONICALIZE_UNBOUNDED.
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_EXPORT_CANONICALIZE_UNBOUNDED,
  AgentExportError,
  canonicalize,
  MAX_AGENT_EXPORT_CANONICALIZE_DEPTH,
  verifyExportManifest,
} from "./agent-export.ts";

function nest(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i += 1) value = { a: value };
  return value;
}

function expectUnbounded(fn: () => unknown): void {
  try {
    fn();
    throw new Error("expected AGENT_EXPORT_CANONICALIZE_UNBOUNDED");
  } catch (error) {
    expect(error).toBeInstanceOf(AgentExportError);
    expect((error as AgentExportError).code).toBe(
      AGENT_EXPORT_CANONICALIZE_UNBOUNDED,
    );
    expect(error).not.toBeInstanceOf(RangeError);
  }
}

describe("canonicalize fail-closed walk", () => {
  it("still sorts keys and drops undefined (stable across key order)", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
    expect(canonicalize({ z: { b: 1, a: 2 } })).toBe('{"z":{"a":2,"b":1}}');
  });

  it("fail-closed on a cyclic export graph instead of RangeError", () => {
    const cyclic: Record<string, unknown> = { id: "mem-1", text: "hi" };
    cyclic.self = cyclic;
    expectUnbounded(() => canonicalize(cyclic));
  });

  it("fail-closed on over-deep nests before the walk RangeErrors", () => {
    expectUnbounded(() =>
      canonicalize(nest(MAX_AGENT_EXPORT_CANONICALIZE_DEPTH + 8)),
    );
  });

  it("fail-closed after JSON.parse accepts a 20k-deep import nest", () => {
    const raw = `${'{"a":'.repeat(20_000)}1${"}".repeat(20_000)}`;
    const parsed = JSON.parse(raw) as unknown;
    expect(typeof parsed).toBe("object");
    expectUnbounded(() => canonicalize(parsed));
  });

  it("does not invoke enumerable getters while canonicalizing", () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "secret", {
      enumerable: true,
      get() {
        throw new Error("GETTER_INVOKED");
      },
    });
    try {
      canonicalize({ id: "mem-1", content: hostile });
      throw new Error("expected AGENT_EXPORT_CANONICALIZE_UNBOUNDED");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentExportError);
      expect((error as AgentExportError).code).toBe(
        AGENT_EXPORT_CANONICALIZE_UNBOUNDED,
      );
      expect(String(error)).not.toContain("GETTER_INVOKED");
    }
  });

  it("verifyExportManifest fail-closed on a cyclic memory collection", () => {
    const cyclic: Record<string, unknown> = { id: "mem-1", text: "hi" };
    cyclic.self = cyclic;
    expectUnbounded(() =>
      verifyExportManifest({
        version: 1,
        exportedAt: "2026-08-21T00:00:00.000Z",
        sourceAgentId: "agent-1",
        agent: { name: "Ada" },
        entities: [],
        memories: [cyclic as never],
        components: [],
        rooms: [],
        participants: [],
        relationships: [],
        worlds: [],
        tasks: [],
        logs: [],
        manifest: {
          algorithm: "sha256",
          components: {
            memories: { sha256: "abc", count: 1 },
          },
        },
      }),
    );
  });
});
