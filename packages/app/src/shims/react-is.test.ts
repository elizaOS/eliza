/**
 * Unit tests for the browser `react-is` shim. The suite drives the real
 * module (not a mock of `react`) and records `typeOf`'s primitive /
 * non-element vs element-tag branches, the five type-guards against real
 * `createElement` / `forwardRef` / `memo` / `createPortal` values, legacy vs
 * transitional `$$typeof`, missing-field objects, and default-export identity.
 * There is no queue, capacity, or comparator — only `$$typeof`/`type` matching
 * as implemented.
 */
import { createElement, Fragment, forwardRef, memo } from "react";
import { createPortal } from "react-dom";
import { describe, expect, it } from "vitest";

import reactIs, {
  isElement,
  isForwardRef,
  isFragment,
  isMemo,
  isPortal,
  typeOf,
} from "./react-is.js";

const REACT_ELEMENT_TYPE = Symbol.for("react.transitional.element");
const REACT_LEGACY_ELEMENT_TYPE = Symbol.for("react.element");
const REACT_FRAGMENT_TYPE = Symbol.for("react.fragment");
const REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref");
const REACT_MEMO_TYPE = Symbol.for("react.memo");
const REACT_PORTAL_TYPE = Symbol.for("react.portal");

function Comp(): null {
  return null;
}

const Fwd = forwardRef(function Fwd(_props: unknown, _ref: unknown) {
  return null;
});

const Mem = memo(function Mem() {
  return null;
});

describe("react-is exports", () => {
  it("exposes the same functions on the default object and as named exports", () => {
    expect(reactIs.isElement).toBe(isElement);
    expect(reactIs.isForwardRef).toBe(isForwardRef);
    expect(reactIs.isFragment).toBe(isFragment);
    expect(reactIs.isMemo).toBe(isMemo);
    expect(reactIs.isPortal).toBe(isPortal);
    expect(reactIs.typeOf).toBe(typeOf);
    expect(Object.keys(reactIs)).toEqual([
      "isElement",
      "isForwardRef",
      "isFragment",
      "isMemo",
      "isPortal",
      "typeOf",
    ]);
  });
});

describe("typeOf primitives and empty values", () => {
  it("returns undefined for falsy non-objects and every primitive typeof", () => {
    expect(typeOf(undefined)).toBeUndefined();
    expect(typeOf(null)).toBeUndefined();
    expect(typeOf(false)).toBeUndefined();
    expect(typeOf(0)).toBeUndefined();
    expect(typeOf(Number.NaN)).toBeUndefined();
    expect(typeOf("")).toBeUndefined();
    expect(typeOf(1)).toBeUndefined();
    expect(typeOf("div")).toBeUndefined();
    expect(typeOf(true)).toBeUndefined();
    expect(typeOf(1n)).toBeUndefined();
    expect(typeOf(Symbol.for("react.element"))).toBeUndefined();
    expect(typeOf(Fragment)).toBeUndefined();
    expect(typeOf(Comp)).toBeUndefined();
  });

  it("returns undefined for an empty object, array, and object without $$typeof", () => {
    expect(typeOf({})).toBeUndefined();
    expect(typeOf([])).toBeUndefined();
    expect(typeOf({ type: "div" })).toBeUndefined();
  });
});

describe("typeOf element vs non-element $$typeof", () => {
  it("returns type for a real createElement node and a transitional tag", () => {
    const el = createElement("div");
    expect(typeOf(el)).toBe("div");
    expect(typeOf({ $$typeof: REACT_ELEMENT_TYPE, type: "span" })).toBe("span");
  });

  it("returns type for the legacy element tag even when React rejects it", () => {
    const legacy = { $$typeof: REACT_LEGACY_ELEMENT_TYPE, type: "p" };
    expect(typeOf(legacy)).toBe("p");
    expect(isElement(legacy)).toBe(false);
  });

  it("returns the missing type as-is when the tag matches an element symbol", () => {
    expect(typeOf({ $$typeof: REACT_ELEMENT_TYPE })).toBeUndefined();
    expect(typeOf({ $$typeof: REACT_ELEMENT_TYPE, type: 0 })).toBe(0);
    expect(typeOf({ $$typeof: REACT_ELEMENT_TYPE, type: null })).toBeNull();
  });

  it("returns $$typeof unchanged when it is not a React element tag", () => {
    expect(typeOf({ $$typeof: REACT_FORWARD_REF_TYPE })).toBe(
      REACT_FORWARD_REF_TYPE,
    );
    expect(typeOf({ $$typeof: REACT_MEMO_TYPE })).toBe(REACT_MEMO_TYPE);
    expect(typeOf({ $$typeof: REACT_PORTAL_TYPE })).toBe(REACT_PORTAL_TYPE);
    expect(typeOf({ $$typeof: REACT_FRAGMENT_TYPE })).toBe(REACT_FRAGMENT_TYPE);
    const other = Symbol.for("react.context");
    expect(typeOf({ $$typeof: other })).toBe(other);
    expect(typeOf({ $$typeof: "not-a-symbol" })).toBe("not-a-symbol");
  });

  it("returns the component object as type for forwardRef and memo elements", () => {
    const fwdEl = createElement(Fwd);
    const memEl = createElement(Mem);
    expect(typeOf(fwdEl)).toBe(Fwd);
    expect(typeOf(memEl)).toBe(Mem);
    expect(typeOf(Fwd)).toBe(REACT_FORWARD_REF_TYPE);
    expect(typeOf(Mem)).toBe(REACT_MEMO_TYPE);
  });
});

describe("isElement", () => {
  it("is true only for values React itself accepts as elements", () => {
    expect(isElement(createElement("div"))).toBe(true);
    expect(isElement(createElement(Fragment))).toBe(true);
    expect(isElement(createElement(Comp))).toBe(true);
    expect(isElement(createElement(Fwd))).toBe(true);
    expect(isElement({ $$typeof: REACT_ELEMENT_TYPE, type: "div" })).toBe(true);
  });

  it("is false for primitives, empty objects, components, and portals", () => {
    expect(isElement(undefined)).toBe(false);
    expect(isElement(null)).toBe(false);
    expect(isElement("div")).toBe(false);
    expect(isElement({})).toBe(false);
    expect(isElement([])).toBe(false);
    expect(isElement(Comp)).toBe(false);
    expect(isElement(Fwd)).toBe(false);
    expect(isElement(Mem)).toBe(false);
    expect(isElement(Fragment)).toBe(false);
    const host = document.createElement("div");
    expect(isElement(createPortal(createElement("span"), host))).toBe(false);
    expect(
      isElement({ $$typeof: REACT_LEGACY_ELEMENT_TYPE, type: "div" }),
    ).toBe(false);
  });
});

describe("isFragment", () => {
  it("is true for a real Fragment element and for either fragment type tag", () => {
    expect(Fragment).toBe(REACT_FRAGMENT_TYPE);
    expect(isFragment(createElement(Fragment))).toBe(true);
    expect(isFragment({ $$typeof: REACT_ELEMENT_TYPE, type: Fragment })).toBe(
      true,
    );
    expect(
      isFragment({ $$typeof: REACT_ELEMENT_TYPE, type: REACT_FRAGMENT_TYPE }),
    ).toBe(true);
    expect(isFragment({ $$typeof: REACT_FRAGMENT_TYPE })).toBe(true);
  });

  it("is false for non-fragments, the Fragment symbol itself, and missing items", () => {
    expect(isFragment(undefined)).toBe(false);
    expect(isFragment(null)).toBe(false);
    expect(isFragment(Fragment)).toBe(false);
    expect(isFragment(createElement("div"))).toBe(false);
    expect(isFragment(createElement(Comp))).toBe(false);
    expect(isFragment({})).toBe(false);
    expect(isFragment({ $$typeof: REACT_ELEMENT_TYPE, type: "div" })).toBe(
      false,
    );
  });
});

describe("isForwardRef", () => {
  it("is true for a forwardRef type object, not for an element of that type", () => {
    expect(isForwardRef(Fwd)).toBe(true);
    expect(isForwardRef({ $$typeof: REACT_FORWARD_REF_TYPE })).toBe(true);
    expect(isForwardRef(createElement(Fwd))).toBe(false);
  });

  it("is false for missing items, memo, portals, and host elements", () => {
    expect(isForwardRef(undefined)).toBe(false);
    expect(isForwardRef(null)).toBe(false);
    expect(isForwardRef({})).toBe(false);
    expect(isForwardRef(Mem)).toBe(false);
    expect(isForwardRef(createElement("div"))).toBe(false);
  });
});

describe("isMemo", () => {
  it("is true for a memo type object, not for an element of that type", () => {
    expect(isMemo(Mem)).toBe(true);
    expect(isMemo({ $$typeof: REACT_MEMO_TYPE })).toBe(true);
    expect(isMemo(createElement(Mem))).toBe(false);
  });

  it("is false for missing items, forwardRef, and host elements", () => {
    expect(isMemo(undefined)).toBe(false);
    expect(isMemo(null)).toBe(false);
    expect(isMemo({})).toBe(false);
    expect(isMemo(Fwd)).toBe(false);
    expect(isMemo(createElement("div"))).toBe(false);
  });
});

describe("isPortal", () => {
  it("is true for a real createPortal value and a portal $$typeof object", () => {
    const host = document.createElement("div");
    const portal = createPortal(createElement("span"), host);
    expect(typeOf(portal)).toBe(REACT_PORTAL_TYPE);
    expect(isPortal(portal)).toBe(true);
    expect(isPortal({ $$typeof: REACT_PORTAL_TYPE })).toBe(true);
  });

  it("is false for missing items, elements, and the other type-guards' matches", () => {
    expect(isPortal(undefined)).toBe(false);
    expect(isPortal(null)).toBe(false);
    expect(isPortal({})).toBe(false);
    expect(isPortal(createElement("div"))).toBe(false);
    expect(isPortal(Fwd)).toBe(false);
    expect(isPortal(Mem)).toBe(false);
  });
});
