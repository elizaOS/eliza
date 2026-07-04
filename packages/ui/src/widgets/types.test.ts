/**
 * Type-level coverage asserting the UI WidgetSlot / declaration types stay
 * assignable to the core plugin-widget declaration.
 */
import type { PluginWidgetDeclaration as CorePluginWidgetDeclaration } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { WidgetSlot } from "./types";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type Expect<T extends true> = T;

const widgetSlotsMatchCore: Expect<
  Equal<WidgetSlot, CorePluginWidgetDeclaration["slot"]>
> = true;

describe("WidgetSlot contract", () => {
  it("stays aligned with core PluginWidgetDeclaration", () => {
    expect(widgetSlotsMatchCore).toBe(true);
  });
});
