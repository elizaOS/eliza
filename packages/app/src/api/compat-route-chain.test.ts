/**
 * Unit tests for the ordered compat-route registry primitives (#12089 item 5).
 *
 * The compat HTTP dispatcher (`handleCompatRouteInner` in server.ts) used to be
 * a ~30-branch order-dependent if-chain where each branch was
 * `if (await handleX(...)) return true`. That ordering + short-circuit contract
 * was implicit in source line order and impossible to assert directly. It is
 * now an explicit ordered array walked by `runCompatRouteChain`, so these tests
 * pin the exact semantics the old if-chain relied on:
 *   - entries run in ARRAY ORDER,
 *   - the FIRST entry that returns truthy wins and STOPS the chain (no later
 *     entry runs — matching the old `return true`),
 *   - an all-declining chain returns false so the caller falls through to its
 *     terminal handler (matching the old final `return handleDatabaseRows...`).
 */
import { describe, expect, it, vi } from "vitest";
import {
  type CompatRouteChainEntry,
  type CompatRouteContext,
  type CompatRuntimeState,
  runCompatRouteChain,
} from "./compat-route-shared.js";

// A minimal fake context. The chain iterator never touches these fields — it
// only threads them to handlers — so opaque stand-ins are sufficient here.
function makeCtx(): CompatRouteContext {
  const state: CompatRuntimeState = {
    current: null,
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
  return {
    req: {} as CompatRouteContext["req"],
    res: {} as CompatRouteContext["res"],
    state,
    method: "GET",
    url: new URL("http://localhost/api/anything"),
  };
}

function entry(
  id: string,
  handler: CompatRouteChainEntry["handler"],
): CompatRouteChainEntry {
  return { id, handler };
}

describe("runCompatRouteChain", () => {
  it("runs entries in array order and stops at the first that handles", async () => {
    const calls: string[] = [];
    const chain: CompatRouteChainEntry[] = [
      entry("a", () => {
        calls.push("a");
        return false;
      }),
      entry("b", () => {
        calls.push("b");
        return true; // handles — chain must stop here
      }),
      entry("c", () => {
        calls.push("c");
        return true;
      }),
    ];

    const handled = await runCompatRouteChain(chain, makeCtx());

    expect(handled).toBe(true);
    // "c" must NOT run: short-circuit is the whole point of the old `return true`.
    expect(calls).toEqual(["a", "b"]);
  });

  it("returns false and runs every entry when none handle the request", async () => {
    const calls: string[] = [];
    const chain: CompatRouteChainEntry[] = [
      entry("a", () => {
        calls.push("a");
        return false;
      }),
      entry("b", () => {
        calls.push("b");
        return false;
      }),
    ];

    const handled = await runCompatRouteChain(chain, makeCtx());

    // false => the dispatcher falls through to its terminal db-rows handler.
    expect(handled).toBe(false);
    expect(calls).toEqual(["a", "b"]);
  });

  it("awaits async handlers and honours a later async truthy result", async () => {
    const calls: string[] = [];
    const chain: CompatRouteChainEntry[] = [
      entry("a", async () => {
        await Promise.resolve();
        calls.push("a");
        return false;
      }),
      entry("b", async () => {
        await Promise.resolve();
        calls.push("b");
        return true;
      }),
      entry("c", () => {
        calls.push("c");
        return true;
      }),
    ];

    const handled = await runCompatRouteChain(chain, makeCtx());

    expect(handled).toBe(true);
    expect(calls).toEqual(["a", "b"]);
  });

  it("threads the same context object to every entry it runs", async () => {
    const ctx = makeCtx();
    const seen: CompatRouteContext[] = [];
    const chain: CompatRouteChainEntry[] = [
      entry("a", (c) => {
        seen.push(c);
        return false;
      }),
      entry("b", (c) => {
        seen.push(c);
        return false;
      }),
    ];

    await runCompatRouteChain(chain, ctx);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(ctx);
    expect(seen[1]).toBe(ctx);
  });

  it("does not run any entry for an empty chain", async () => {
    const spy = vi.fn();
    const handled = await runCompatRouteChain([], makeCtx());
    expect(handled).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
