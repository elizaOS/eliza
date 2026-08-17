/** Verifies pairing-popup redirect guarding through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Regression coverage for the hosted-agent pairing flow: the pairing-token
 * endpoint's `redirectUrl` is a wire value assigned to the popup's top window,
 * so a non-http(s) value must close the popup with an error toast instead of
 * navigating. jsdom with stubbed `window.open` + `fetch`; no network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({
  toast: { error: toastError, success: vi.fn() },
}));

import { openWebUIWithPairing } from "./open-web-ui";

interface FakePopup {
  closed: boolean;
  close: () => void;
  location: { href: string };
  document: { title: string; body: { innerHTML: string } };
}

function makePopup(): FakePopup {
  const popup: FakePopup = {
    closed: false,
    close() {
      popup.closed = true;
    },
    location: { href: "about:blank" },
    document: { title: "", body: { innerHTML: "" } },
  };
  return popup;
}

function pairingResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  toastError.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("openWebUIWithPairing redirect guard", () => {
  it("redirects the popup to a valid https pairing URL", async () => {
    const popup = makePopup();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        pairingResponse({
          data: { redirectUrl: "https://agent.example.com/pair?token=abc" },
        }),
      ),
    );

    await openWebUIWithPairing("agent-1");

    expect(popup.location.href).toBe(
      "https://agent.example.com/pair?token=abc",
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("refuses a non-http(s) redirect URL instead of navigating the popup", async () => {
    const popup = makePopup();
    const closeSpy = vi.spyOn(popup, "close");
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        pairingResponse({ data: { redirectUrl: "javascript:alert(1)" } }),
      ),
    );

    await openWebUIWithPairing("agent-1");

    expect(popup.location.href).toBe("about:blank");
    expect(toastError).toHaveBeenCalledWith(
      "Pairing redirect URL is not a valid URL",
    );
    expect(closeSpy).toHaveBeenCalled();
  });
});
