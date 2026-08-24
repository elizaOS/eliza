/**
 * Unit coverage for the `@elizaos/ui/spatial` public barrel entry
 * (`src/spatial/index.ts`), driven through its runtime exports: padding
 * normalisation, container classification, and the primitive-kind branding
 * the evaluator dispatches on. Pure, no renderer, no mocks.
 */
import { describe, expect, it } from "vitest";
import type { SpatialNode } from "../index.ts";
import {
  Button,
  Divider,
  Escape,
  Field,
  getSpatialKind,
  Image,
  isContainer,
  resolvePadding,
  SPATIAL_KIND,
  Spacer,
  Stack,
  Text,
} from "../index.ts";

describe("resolvePadding — SpatialPadding normalisation", () => {
  it("defaults undefined to zero on every side", () => {
    expect(resolvePadding(undefined)).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });

  it("spreads a single number across all four sides", () => {
    expect(resolvePadding(2)).toEqual({
      top: 2,
      right: 2,
      bottom: 2,
      left: 2,
    });
  });

  it("maps [vertical, horizontal] tuples onto opposing side pairs", () => {
    expect(resolvePadding([1, 4])).toEqual({
      top: 1,
      right: 4,
      bottom: 1,
      left: 4,
    });
  });

  it("keeps explicit per-side values", () => {
    expect(resolvePadding({ top: 1, right: 2, bottom: 3, left: 4 })).toEqual({
      top: 1,
      right: 2,
      bottom: 3,
      left: 4,
    });
  });

  it("fills omitted sides of a partial object with zero", () => {
    expect(resolvePadding({ top: 2 })).toEqual({
      top: 2,
      right: 0,
      bottom: 0,
      left: 0,
    });
    expect(resolvePadding({ left: 3 })).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 3,
    });
    expect(resolvePadding({})).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });
});

describe("isContainer — box classification and guard narrowing", () => {
  it("accepts a box node and narrows it for children access", () => {
    const node: SpatialNode = {
      type: "box",
      direction: "row",
      gap: 0,
      children: [{ type: "text", value: "inside" }],
    };
    if (isContainer(node)) {
      expect(node.children).toEqual([{ type: "text", value: "inside" }]);
    } else {
      throw new Error("box node must satisfy the container guard");
    }
  });

  it("rejects every leaf node kind", () => {
    const leaves: SpatialNode[] = [
      { type: "text", value: "hi" },
      { type: "button", label: "Save" },
      { type: "field", label: "Name" },
      { type: "divider" },
      { type: "spacer", size: 1 },
      { type: "image", src: "logo.png" },
    ];
    for (const leaf of leaves) {
      expect(isContainer(leaf)).toBe(false);
    }
  });
});

describe("getSpatialKind — primitive branding read by the evaluator", () => {
  it("maps every authored primitive to its IR kind", () => {
    expect(getSpatialKind(Stack)).toBe("box");
    expect(getSpatialKind(Text)).toBe("text");
    expect(getSpatialKind(Button)).toBe("button");
    expect(getSpatialKind(Field)).toBe("field");
    expect(getSpatialKind(Divider)).toBe("divider");
    expect(getSpatialKind(Spacer)).toBe("spacer");
    expect(getSpatialKind(Image)).toBe("image");
    expect(getSpatialKind(Escape)).toBe("escape");
  });

  it("returns null for anything that is not a branded function", () => {
    expect(getSpatialKind(() => null)).toBeNull();
    expect(getSpatialKind("Text")).toBeNull();
    expect(getSpatialKind(null)).toBeNull();
    expect(getSpatialKind(undefined)).toBeNull();
    expect(getSpatialKind({})).toBeNull();
    expect(getSpatialKind(42)).toBeNull();
  });

  it("publishes the brand under the cross-realm registry symbol", () => {
    expect(SPATIAL_KIND).toBe(Symbol.for("elizaos.spatial.kind"));
  });
});
