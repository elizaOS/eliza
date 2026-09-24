import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AospFlasherBackend } from "../backend/types";
import { FlasherApp } from "../components/FlasherApp";
import { IosFlasher } from "../components/IosFlasher";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.__ELIZA_SERVER_TOKEN__;
  vi.unstubAllGlobals();
});

describe("normal-user installer states", () => {
  it("explains how to recover when an explicit iOS scan finds no device", async () => {
    window.__ELIZA_SERVER_TOKEN__ = "test-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([])),
    );
    await act(async () => root.render(<IosFlasher serverUrl="/api" />));

    const checkButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Check for my device",
    );
    if (!checkButton) throw new Error("missing iOS device check button");
    await act(async () => checkButton.click());

    expect(container.textContent).toContain("No iPhone or iPad found yet");
    expect(container.textContent).toContain("unlock it, and tap Trust");
  });

  it.each([
    [
      "packaged direct injection",
      "http://127.0.0.1:4242",
      "http://127.0.0.1:4242/ios/devices",
    ],
    ["browser development proxy", "/api", "/api/ios/devices"],
  ])(
    "keeps iOS device checks on the backend for %s",
    async (_mode, base, expected) => {
      window.__ELIZA_SERVER_TOKEN__ = "route-test-token";
      const fetchMock = vi.fn<
        (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
      >(async () => Response.json([]));
      vi.stubGlobal("fetch", fetchMock);

      await act(async () => root.render(<IosFlasher serverUrl={base} />));

      expect(fetchMock).toHaveBeenCalled();
      expect(fetchMock.mock.calls[0]?.[0]).toBe(expected);
      expect(fetchMock.mock.calls[0]?.[0]).not.toBe(
        `${window.location.origin}/ios/devices`,
      );
    },
  );

  it("hides raw Android transport errors behind recovery guidance", async () => {
    const backend = {
      listConnectedDevices: vi.fn(async () => {
        throw new TypeError("GET /devices failed: HTTP 404");
      }),
      listBuilds: vi.fn(async () => []),
    } as unknown as AospFlasherBackend;

    await act(async () =>
      root.render(<FlasherApp backend={backend} embedded />),
    );

    expect(container.textContent).toContain(
      "The installer could not reach its device service",
    );
    expect(container.textContent).not.toContain("HTTP 404");
  });

  it("does not discover releases before an Android device is present", async () => {
    const backend = {
      listConnectedDevices: vi.fn(async () => []),
      listBuilds: vi.fn(async () => {
        throw new Error("No published manifests");
      }),
    } as unknown as AospFlasherBackend;

    await act(async () =>
      root.render(<FlasherApp backend={backend} embedded />),
    );

    expect(container.textContent).toContain("No Android devices found");
    expect(backend.listBuilds).not.toHaveBeenCalled();
  });
});
