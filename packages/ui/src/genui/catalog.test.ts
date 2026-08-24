/**
 * Unit coverage for the GenUI catalog: frozen component/action-prefix
 * membership and the three pure guards over it. Real module, no harness.
 */
import { describe, expect, it } from "vitest";
import {
  ELIZA_GENUI_ALLOWED_ACTION_PREFIXES,
  ELIZA_GENUI_ALLOWED_COMPONENTS,
  ELIZA_GENUI_DOMAIN_COMPONENTS,
  ELIZA_GENUI_PRIMITIVE_COMPONENTS,
  isElizaGenUiActionNameAllowed,
  isElizaGenUiKnownComponent,
  isElizaGenUiPrimitiveComponent,
} from "./catalog";

describe("catalog structure", () => {
  it("composes allowed components as primitives then domain, without overlap", () => {
    expect(ELIZA_GENUI_ALLOWED_COMPONENTS).toStrictEqual([
      ...ELIZA_GENUI_PRIMITIVE_COMPONENTS,
      ...ELIZA_GENUI_DOMAIN_COMPONENTS,
    ]);
    const unique = new Set<string>(ELIZA_GENUI_ALLOWED_COMPONENTS);
    expect(unique.size).toBe(ELIZA_GENUI_ALLOWED_COMPONENTS.length);
    // A primitive name must never double as a domain component: the two
    // catalogs partition the allowed set.
    const domains = new Set<string>(ELIZA_GENUI_DOMAIN_COMPONENTS);
    for (const primitive of ELIZA_GENUI_PRIMITIVE_COMPONENTS) {
      expect(domains.has(primitive)).toBe(false);
    }
  });

  it("ships unique, dot-terminated action prefixes", () => {
    expect(ELIZA_GENUI_ALLOWED_ACTION_PREFIXES.length).toBeGreaterThan(0);
    for (const prefix of ELIZA_GENUI_ALLOWED_ACTION_PREFIXES) {
      expect(prefix.length).toBeGreaterThan(1);
      expect(prefix.endsWith(".")).toBe(true);
    }
    expect(new Set<string>(ELIZA_GENUI_ALLOWED_ACTION_PREFIXES).size).toBe(
      ELIZA_GENUI_ALLOWED_ACTION_PREFIXES.length,
    );
  });
});

describe("isElizaGenUiKnownComponent", () => {
  it("accepts every primitive and every domain component", () => {
    for (const name of ELIZA_GENUI_PRIMITIVE_COMPONENTS) {
      expect(isElizaGenUiKnownComponent(name)).toBe(true);
    }
    for (const name of ELIZA_GENUI_DOMAIN_COMPONENTS) {
      expect(isElizaGenUiKnownComponent(name)).toBe(true);
    }
  });

  it("rejects unknown, case-variant, and empty values", () => {
    expect(isElizaGenUiKnownComponent("Grid")).toBe(false);
    expect(isElizaGenUiKnownComponent("row")).toBe(false);
    expect(isElizaGenUiKnownComponent("TEXT")).toBe(false);
    expect(isElizaGenUiKnownComponent("providersetupcard")).toBe(false);
    expect(isElizaGenUiKnownComponent("")).toBe(false);
    expect(isElizaGenUiKnownComponent("Row ")).toBe(false);
  });
});

describe("isElizaGenUiPrimitiveComponent", () => {
  it("accepts primitive names but not domain-only names", () => {
    expect(isElizaGenUiPrimitiveComponent("Row")).toBe(true);
    expect(isElizaGenUiPrimitiveComponent("ChoicePicker")).toBe(true);
    // Known overall, yet outside the primitive subset — the A2UI-compatible
    // core must not absorb eliza domain cards.
    expect(isElizaGenUiPrimitiveComponent("ProviderSetupCard")).toBe(false);
    expect(isElizaGenUiPrimitiveComponent("TraceTimeline")).toBe(false);
    expect(isElizaGenUiPrimitiveComponent("ModelDownloadStatus")).toBe(false);
  });

  it("rejects unknown, case-variant, and empty values", () => {
    expect(isElizaGenUiPrimitiveComponent("Stack")).toBe(false);
    expect(isElizaGenUiPrimitiveComponent("button")).toBe(false);
    expect(isElizaGenUiPrimitiveComponent("")).toBe(false);
  });
});

describe("isElizaGenUiActionNameAllowed", () => {
  it("allows events under any shipped default prefix", () => {
    for (const prefix of ELIZA_GENUI_ALLOWED_ACTION_PREFIXES) {
      expect(isElizaGenUiActionNameAllowed(`${prefix}doIt`)).toBe(true);
    }
  });

  it("rejects events that match no default prefix", () => {
    expect(isElizaGenUiActionNameAllowed("random.event")).toBe(false);
    expect(isElizaGenUiActionNameAllowed("")).toBe(false);
    // startsWith semantics: the prefix text must open the event name.
    expect(isElizaGenUiActionNameAllowed("notsetup.later")).toBe(false);
    expect(isElizaGenUiActionNameAllowed("setup")).toBe(false);
    expect(isElizaGenUiActionNameAllowed("SETUP.x")).toBe(false);
  });

  it("custom prefixes replace the defaults entirely", () => {
    expect(isElizaGenUiActionNameAllowed("foo.bar", ["foo."])).toBe(true);
    // A default prefix no longer rescues an event once prefixes are supplied.
    expect(isElizaGenUiActionNameAllowed("setup.x", ["foo."])).toBe(false);
    expect(isElizaGenUiActionNameAllowed("anything", [])).toBe(false);
  });

  it("the explicit names list allows by exact equality", () => {
    expect(
      isElizaGenUiActionNameAllowed("named.event", [], ["named.event"]),
    ).toBe(true);
    // Containment is not enough — names match whole strings only.
    expect(
      isElizaGenUiActionNameAllowed("pre-named.event", [], ["named.event"]),
    ).toBe(false);
    expect(isElizaGenUiActionNameAllowed("named.ev", [], ["named.event"])).toBe(
      false,
    );
  });

  it("names and prefixes are independent OR channels", () => {
    expect(isElizaGenUiActionNameAllowed("p.hit", ["p."], ["named"])).toBe(
      true,
    );
    expect(isElizaGenUiActionNameAllowed("named", ["p."], ["named"])).toBe(
      true,
    );
    expect(isElizaGenUiActionNameAllowed("neither", ["p."], ["named"])).toBe(
      false,
    );
    expect(isElizaGenUiActionNameAllowed("", [], [""])).toBe(true);
  });
});
