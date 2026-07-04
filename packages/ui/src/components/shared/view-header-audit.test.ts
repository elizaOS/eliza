// @vitest-environment jsdom

/**
 * The uniform-top-bar audit assertion (#13586, #13451 acceptance): a `normal`
 * view MUST render the shared `ViewHeader`, and the audit FAILS on a synthetic
 * headerless `normal` view. Exempt policies (fullscreen/modal/immersive) never
 * require it.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSharedViewHeader,
  hasSharedViewHeader,
  VIEW_HEADER_TESTID,
  viewRequiresSharedHeader,
} from "./view-header-audit";

afterEach(() => {
  document.body.innerHTML = "";
});

function withHeader(): HTMLElement {
  const root = document.createElement("div");
  const header = document.createElement("header");
  header.setAttribute("data-testid", VIEW_HEADER_TESTID);
  root.appendChild(header);
  return root;
}

function withoutHeader(): HTMLElement {
  const root = document.createElement("div");
  root.appendChild(document.createElement("main"));
  return root;
}

describe("viewRequiresSharedHeader", () => {
  it("requires the header for normal (and undefined-default) views", () => {
    expect(viewRequiresSharedHeader("normal")).toBe(true);
    expect(viewRequiresSharedHeader(undefined)).toBe(true);
  });

  it("exempts fullscreen/modal/immersive views", () => {
    expect(viewRequiresSharedHeader("fullscreen")).toBe(false);
    expect(viewRequiresSharedHeader("modal")).toBe(false);
    expect(viewRequiresSharedHeader("immersive")).toBe(false);
  });
});

describe("hasSharedViewHeader", () => {
  it("detects the shared header marker in a subtree", () => {
    expect(hasSharedViewHeader(withHeader())).toBe(true);
    expect(hasSharedViewHeader(withoutHeader())).toBe(false);
    expect(hasSharedViewHeader(null)).toBe(false);
  });
});

describe("assertSharedViewHeader", () => {
  it("passes a normal view that renders the shared header", () => {
    expect(() =>
      assertSharedViewHeader({
        viewId: "wallet",
        headerPolicy: "normal",
        root: withHeader(),
      }),
    ).not.toThrow();
  });

  it("FAILS a normal view missing the shared header", () => {
    expect(() =>
      assertSharedViewHeader({
        viewId: "synthetic-headerless",
        headerPolicy: "normal",
        root: withoutHeader(),
      }),
    ).toThrowError(/synthetic-headerless/);
  });

  it("FAILS a default-policy (undefined) view missing the header", () => {
    expect(() =>
      assertSharedViewHeader({
        viewId: "defaulted",
        headerPolicy: undefined,
        root: withoutHeader(),
      }),
    ).toThrowError(/uniform top-bar audit failed/i);
  });

  it("is a no-op for exempt views even without a header", () => {
    for (const headerPolicy of ["fullscreen", "modal", "immersive"] as const) {
      expect(() =>
        assertSharedViewHeader({
          viewId: `exempt-${headerPolicy}`,
          headerPolicy,
          root: withoutHeader(),
        }),
      ).not.toThrow();
    }
  });
});
