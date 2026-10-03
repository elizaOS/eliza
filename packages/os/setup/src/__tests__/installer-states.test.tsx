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

it("waits for verified unlock, then rechecks stock Android before installation", async () => {
  const { FIXTURE_BUILDS } = await import("./fixtures");
  const build = FIXTURE_BUILDS[0];
  if (!build) throw new Error("Missing fixture build");
  const device = {
    serial: "fixture",
    model: "Fixture phone",
    codename: "tegu",
    state: "device" as const,
    bootloaderUnlocked: false,
  };
  let finishUnlock: (() => void) | undefined;
  const backend: AospFlasherBackend = {
    listConnectedDevices: vi.fn(async () => [device]),
    listBuilds: vi.fn(async () => [build]),
    getDeviceSpecs: vi.fn(async () => ({
      storageAvailableBytes: 100 * 1024 ** 3,
      storageTotalBytes: 128 * 1024 ** 3,
      androidVersion: "17",
      abi: "arm64-v8a",
      bootloaderLocked: true,
      supportedByElizaOs: true,
      supportedBuildCodename: "tegu",
    })),
    createFlashPlan: vi.fn(async (request) => ({
      device,
      build,
      request,
      artifactDir: null,
      steps: [],
    })),
    executeFlashPlan: vi.fn(async (plan) => {
      if (plan.request.stopAfter === "unlock-bootloader")
        await new Promise<void>((resolve) => {
          finishUnlock = resolve;
        });
    }),
  };
  await act(async () => root.render(<FlasherApp backend={backend} />));
  const click = async (text: string) => {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === text,
    );
    if (!button) throw new Error(`Missing button: ${text}`);
    await act(async () => button.click());
  };
  for (const text of [
    "Select this device",
    "Continue to build selection →",
    `Continue with ${build.label} →`,
    "Continue to bootloader unlock →",
    "Done — I enabled Developer Options",
    "Done — OEM Unlocking is enabled",
    "Done — I've backed up my data",
    "Reboot to Bootloader",
    "Unlock Bootloader",
  ])
    await click(text);
  expect(container.textContent).toContain(
    "Waiting for you to confirm on device",
  );
  expect(container.textContent).not.toContain("I confirmed on device");
  expect(container.textContent).not.toContain("Bootloader unlock verified");
  if (!finishUnlock) throw new Error("Unlock was not requested");
  await act(async () => finishUnlock?.());
  expect(container.textContent).toContain("Bootloader unlock verified");
  expect(container.textContent).toContain("Start stock Android");
  expect(backend.createFlashPlan).toHaveBeenCalledTimes(2);
  const previousScans = vi.mocked(backend.listConnectedDevices).mock.calls
    .length;
  await click("Check reconnected phone");
  expect(container.textContent).toContain("Connect your device");
  expect(
    vi.mocked(backend.listConnectedDevices).mock.calls.length,
  ).toBeGreaterThan(previousScans);
  expect(backend.createFlashPlan).toHaveBeenCalledTimes(2);
});
