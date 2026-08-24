/**
 * Render-boundary coverage for the phone-picker country flag glyph.
 *
 * Mounts the real CountryFlag component in jsdom and asserts the markup a
 * caller observes: regional-indicator rendering, invalid-code passthrough,
 * and the accessibility attributes the picker relies on. Deterministic —
 * no network, storage, or provider involvement.
 */
import { afterEach, describe, expect, test } from "bun:test";

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { JSDOM } = await import("jsdom");
const { CountryFlag } = await import("../src/components/login/country-flag");

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);
const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "document",
);
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);

function restoreProperty(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, property, descriptor);
  else Reflect.deleteProperty(target, property);
}

function setupDom(): Window {
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', {
    url: "http://localhost/get-started",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = window;
  g.document = window.document;
  g.navigator = window.navigator;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  return window as unknown as Window;
}

async function renderCountryFlag(props: {
  countryCode: string;
  className?: string;
  title?: string;
}): Promise<Element> {
  const window = setupDom();
  const container = window.document.getElementById("root");
  if (!container) throw new Error("root element not found");
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(CountryFlag, props));
  });
  return container;
}

afterEach(() => {
  restoreProperty(globalThis, "window", originalWindowDescriptor);
  restoreProperty(globalThis, "document", originalDocumentDescriptor);
  restoreProperty(globalThis, "navigator", originalNavigatorDescriptor);
});

describe("CountryFlag", () => {
  test("renders the regional indicator pair for an uppercase ISO code", async () => {
    const container = await renderCountryFlag({ countryCode: "US" });
    expect(container.querySelector("span")?.textContent).toBe(
      "\u{1F1FA}\u{1F1F8}",
    );
  });

  test("maps a second code independently of the first", async () => {
    const container = await renderCountryFlag({ countryCode: "FR" });
    expect(container.querySelector("span")?.textContent).toBe(
      "\u{1F1EB}\u{1F1F7}",
    );
  });

  test("normalizes lowercase codes to uppercase before mapping", async () => {
    const container = await renderCountryFlag({ countryCode: "br" });
    expect(container.querySelector("span")?.textContent).toBe(
      "\u{1F1E7}\u{1F1F7}",
    );
  });

  test("passes a three-letter code through in its original case", async () => {
    const container = await renderCountryFlag({ countryCode: "usa" });
    expect(container.querySelector("span")?.textContent).toBe("usa");
  });

  test("passes a code containing a digit through unchanged", async () => {
    const container = await renderCountryFlag({ countryCode: "U1" });
    expect(container.querySelector("span")?.textContent).toBe("U1");
  });

  test("passes non-ASCII letters through unchanged", async () => {
    const container = await renderCountryFlag({ countryCode: "Éa" });
    expect(container.querySelector("span")?.textContent).toBe("Éa");
  });

  test("renders an empty glyph for an empty country code", async () => {
    const container = await renderCountryFlag({ countryCode: "" });
    const span = container.querySelector("span");
    expect(span?.textContent).toBe("");
    expect(span?.getAttribute("aria-label")).toBe("");
  });

  test("exposes role img with the raw code as the accessible name", async () => {
    const container = await renderCountryFlag({ countryCode: "JP" });
    const span = container.querySelector('span[role="img"]');
    expect(span).not.toBeNull();
    expect(span?.getAttribute("aria-label")).toBe("JP");
  });

  test("defaults both title attribute and accessible name to the raw code", async () => {
    const container = await renderCountryFlag({ countryCode: "DE" });
    const span = container.querySelector("span");
    expect(span?.getAttribute("title")).toBe("DE");
    expect(span?.getAttribute("aria-label")).toBe("DE");
  });

  test("an explicit title overrides both the title attribute and aria-label", async () => {
    const container = await renderCountryFlag({
      countryCode: "US",
      title: "United States",
    });
    const span = container.querySelector("span");
    expect(span?.getAttribute("title")).toBe("United States");
    expect(span?.getAttribute("aria-label")).toBe("United States");
  });

  test("keeps caller classes ahead of the fixed utility classes", async () => {
    const container = await renderCountryFlag({
      countryCode: "US",
      className: "my-flag h-8 w-8",
    });
    const className = container.querySelector("span")?.className ?? "";
    expect(className.startsWith("my-flag h-8 w-8")).toBe(true);
    expect(className).toContain(
      "inline-flex items-center justify-center text-base leading-none",
    );
  });

  test("renders the fixed utilities when no className is provided", async () => {
    const container = await renderCountryFlag({ countryCode: "US" });
    expect(container.querySelector("span")?.className).toContain(
      "inline-flex items-center justify-center text-base leading-none",
    );
  });
});
