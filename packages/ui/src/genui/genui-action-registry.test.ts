/**
 * Unit coverage for GenUI action routing and the prefix-handler factory. Pure
 * functions, no live agent.
 */
import { describe, expect, it } from "vitest";
import {
  createElizaGenUiPrefixActionHandler,
  ElizaGenUiActionError,
  routeElizaGenUiAction,
} from "./actions";
import {
  isElizaGenUiActionAllowed,
  listElizaGenUiActionPrefixes,
  registerElizaGenUiActionName,
  registerElizaGenUiActionPrefix,
} from "./genui-action-registry";
import type { ElizaGenUiAction } from "./types";

/**
 * Boot-time genui-action registry (#12087 Item 26). The gate reads the registry
 * (built-in prefixes + names/prefixes plugin modules register); an unregistered
 * name still throws. Uses unique plugin ids per case so the process-global store
 * stays deterministic.
 */

const act = (name: string): ElizaGenUiAction => ({ event: { name } });
const okHandler = createElizaGenUiPrefixActionHandler([""], async () => ({
  ok: true,
}));

describe("genui-action-registry", () => {
  it("seeds the built-in action prefixes so default families stay allowed", () => {
    expect(listElizaGenUiActionPrefixes()).toEqual(
      expect.arrayContaining(["model.", "connector.", "setup."]),
    );
    expect(isElizaGenUiActionAllowed("model.pick")).toBe(true);
    expect(isElizaGenUiActionAllowed("connector.setup")).toBe(true);
  });

  it("rejects a name outside every registered name/prefix", () => {
    expect(isElizaGenUiActionAllowed("regtest_plugin_a.doThing")).toBe(false);
  });

  it("allows an exact name once its module registers it", () => {
    registerElizaGenUiActionName("regtest_plugin_b.launch");
    expect(isElizaGenUiActionAllowed("regtest_plugin_b.launch")).toBe(true);
    // A sibling name under the same non-prefixed family is still rejected.
    expect(isElizaGenUiActionAllowed("regtest_plugin_b.other")).toBe(false);
  });

  it("allows a whole family once its module registers a prefix", () => {
    registerElizaGenUiActionPrefix("regtest_plugin_c.");
    expect(isElizaGenUiActionAllowed("regtest_plugin_c.a")).toBe(true);
    expect(isElizaGenUiActionAllowed("regtest_plugin_c.b")).toBe(true);
  });
});

describe("routeElizaGenUiAction gate reads the registry", () => {
  it("throws for an unregistered action name", async () => {
    await expect(
      routeElizaGenUiAction(act("regtest_plugin_d.nope"), {}, [okHandler]),
    ).rejects.toBeInstanceOf(ElizaGenUiActionError);
  });

  it("routes a registered action name to a matching handler", async () => {
    registerElizaGenUiActionPrefix("regtest_plugin_e.");
    const seen: string[] = [];
    const handler = createElizaGenUiPrefixActionHandler(
      ["regtest_plugin_e."],
      async (action) => {
        seen.push(action.event.name);
        return { ok: true };
      },
    );
    const result = await routeElizaGenUiAction(act("regtest_plugin_e.go"), {}, [
      handler,
    ]);
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual(["regtest_plugin_e.go"]);
  });
});
