/** Pins the GenUI barrel surface (@elizaos/ui/genui) to its member modules. */
// @vitest-environment jsdom

/**
 * index.ts is pure `export *` wiring over actions, catalog, renderer,
 * starter-pack-demo, streaming, types, use-ui-stream, and validator. Every
 * member runtime export must resolve through the barrel by identity (no
 * shadowing), the namespace must equal exactly the union of member runtime
 * exports (`export *` silently drops ambiguous collisions, so any drift here
 * is a deliberate public-surface change), the type-only member types.ts must
 * contribute no runtime keys, and re-exported bindings must stay live when
 * driven through the barrel alone.
 */

import { describe, expect, it } from "vitest";
import * as actions from "./actions";
import * as catalog from "./catalog";
import * as genui from "./index";
import * as renderer from "./renderer";
import * as starterPackDemo from "./starter-pack-demo";
import * as streaming from "./streaming";
import type { ElizaGenUiAction } from "./types";
import * as uiStream from "./use-ui-stream";
import * as validator from "./validator";

type RuntimeExports = Record<string, unknown>;

const memberModules = [
  ["./actions", actions],
  ["./catalog", catalog],
  ["./renderer", renderer],
  ["./starter-pack-demo", starterPackDemo],
  ["./streaming", streaming],
  ["./use-ui-stream", uiStream],
  ["./validator", validator],
] as const;

const derivedRuntimeNames = memberModules
  .flatMap(([, member]) => Object.keys(member as RuntimeExports))
  .sort();

const pinnedRuntimeNames = [
  "ELIZA_GENUI_ALLOWED_ACTION_PREFIXES",
  "ELIZA_GENUI_ALLOWED_COMPONENTS",
  "ELIZA_GENUI_DOMAIN_COMPONENTS",
  "ELIZA_GENUI_PRIMITIVE_COMPONENTS",
  "ELIZA_STARTER_PACK_SETUP_SPEC",
  "MAX_GENUI_UNSAFE_FIELD_DEPTH",
  "MAX_GENUI_UNSAFE_FIELD_NODES",
  "ElizaGenUiActionError",
  "ElizaGenUiRenderer",
  "abortElizaGenUiStream",
  "applyElizaGenUiPatch",
  "assertValidElizaGenUiSpec",
  "createElizaGenUiPrefixActionHandler",
  "isElizaGenUiActionNameAllowed",
  "isElizaGenUiKnownComponent",
  "isElizaGenUiPrimitiveComponent",
  "officialSpecToEliza",
  "resetElizaGenUiSpec",
  "routeElizaGenUiAction",
  "useUIStream",
  "validateElizaGenUiSpec",
];

const validPrimitiveSpec = {
  version: "0.1",
  a2uiVersion: "0.9",
  root: "card",
  components: [
    { id: "card", component: "Card" },
    { id: "title", component: "Text", text: "Hello", variant: "h2" },
  ],
} as const;

describe("genui barrel surface", () => {
  it("re-exports every member runtime symbol by identity", () => {
    for (const [specifier, member] of memberModules) {
      const exports = member as RuntimeExports;
      for (const name of Object.keys(exports)) {
        expect(
          name in genui,
          `${specifier} exports "${name}" but the barrel does not`,
        ).toBe(true);
        expect(
          (genui as RuntimeExports)[name],
          `barrel binding for ${specifier}:${name} diverged from its module`,
        ).toBe(exports[name]);
      }
    }
  });

  it("exposes exactly the union of member runtime exports", () => {
    expect(Object.keys(genui).sort()).toEqual(derivedRuntimeNames);
  });

  it("pins the public runtime surface; types.ts stays type-only", () => {
    expect(Object.keys(genui)).toHaveLength(pinnedRuntimeNames.length);
    expect(Object.keys(genui).sort()).toEqual([...pinnedRuntimeNames].sort());
    expect(derivedRuntimeNames).toEqual([...pinnedRuntimeNames].sort());
  });

  it("keeps catalog bindings live through the barrel alone", () => {
    expect(genui.isElizaGenUiKnownComponent("Card")).toBe(true);
    expect(genui.isElizaGenUiKnownComponent("ProviderSetupCard")).toBe(true);
    expect(genui.isElizaGenUiKnownComponent("NoSuchWidget")).toBe(false);
    expect(genui.isElizaGenUiPrimitiveComponent("Card")).toBe(true);
    expect(genui.isElizaGenUiPrimitiveComponent("ProviderSetupCard")).toBe(
      false,
    );
    expect(genui.isElizaGenUiActionNameAllowed("setup.dismiss")).toBe(true);
    expect(genui.isElizaGenUiActionNameAllowed("system.shutdown")).toBe(false);
  });

  it("keeps validator bindings live through the barrel alone", () => {
    expect(genui.validateElizaGenUiSpec(validPrimitiveSpec).ok).toBe(true);

    const rejected = genui.validateElizaGenUiSpec({
      ...validPrimitiveSpec,
      components: [{ id: "root", component: "Shell" }],
      root: "root",
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(
        rejected.errors.some((error) => error.code === "unknown_component"),
      ).toBe(true);
    }
  });

  it("keeps action dispatch bindings live through the barrel alone", async () => {
    const action: ElizaGenUiAction = { event: { name: "setup.dismiss" } };
    const error = new genui.ElizaGenUiActionError("blocked", action);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ElizaGenUiActionError");
    expect(error.message).toBe("blocked");
    expect(error.action).toBe(action);

    await expect(
      genui.routeElizaGenUiAction(action, {}, []),
    ).rejects.toBeInstanceOf(genui.ElizaGenUiActionError);
  });
});
