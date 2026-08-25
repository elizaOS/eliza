import { describe, expect, it, vi } from "vitest";

const mockReact = vi.hoisted(() => ({
  Fragment: Symbol.for("react.fragment"),
  isValidElement: vi.fn((o: unknown) =>
    Boolean(
      o &&
        typeof o === "object" &&
        (o as { $$typeof?: unknown }).$$typeof ===
          Symbol.for("react.transitional.element"),
    ),
  ),
}));
vi.mock("react", () => mockReact);

import {
  isElement,
  isForwardRef,
  isFragment,
  isMemo,
  isPortal,
  typeOf,
} from "../react-is.ts";

describe("typeOf", () => {
  it("returns the type for elements", () => {
    const el = {
      $$typeof: Symbol.for("react.transitional.element"),
      type: "div",
    };
    expect(typeOf(el)).toBe("div");
  });

  it("returns $$typeof for non-elements", () => {
    const forwardRef = { $$typeof: Symbol.for("react.forward_ref") };
    expect(typeOf(forwardRef)).toBe(Symbol.for("react.forward_ref"));
  });

  it("returns undefined for primitives", () => {
    expect(typeOf(null)).toBeUndefined();
    expect(typeOf(5)).toBeUndefined();
  });
});

describe("guards", () => {
  it("isFragment matches fragments", () => {
    const frag = {
      $$typeof: Symbol.for("react.transitional.element"),
      type: Symbol.for("react.fragment"),
    };
    expect(isFragment(frag)).toBe(true);
  });

  it("isForwardRef / isMemo / isPortal match their types", () => {
    expect(isForwardRef({ $$typeof: Symbol.for("react.forward_ref") })).toBe(
      true,
    );
    expect(isMemo({ $$typeof: Symbol.for("react.memo") })).toBe(true);
    expect(isPortal({ $$typeof: Symbol.for("react.portal") })).toBe(true);
  });

  it("isElement delegates to isValidElement", () => {
    const el = { $$typeof: Symbol.for("react.transitional.element") };
    expect(isElement(el)).toBe(true);
    expect(isElement({})).toBe(false);
  });
});
