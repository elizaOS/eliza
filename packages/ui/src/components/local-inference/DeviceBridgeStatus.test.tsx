// @vitest-environment jsdom
import type { DeviceSummary } from "@elizaos/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { TranslationProvider } from "../../state/TranslationProvider";
import { DeviceBridgeStatusBar } from "./DeviceBridgeStatus";

afterEach(cleanup);

it("renders the selected primary device and clears its model on disconnect", () => {
  const device = (id: string): DeviceSummary => ({
    deviceId: id,
    capabilities: {
      platform: "desktop",
      deviceModel: id,
      totalRamGb: 16,
      cpuCores: 8,
      gpu: null,
    },
    loadedPath: `/models/${id}.gguf`,
    connectedSince: "2026-06-05T10:00:00Z",
    score: 1,
    activeRequests: 0,
  });
  const view = render(
    <TranslationProvider>
      <DeviceBridgeStatusBar
        status={{
          connected: true,
          devices: [device("first"), device("second")],
          primaryDeviceId: "second",
          pendingRequests: 0,
        }}
      />
    </TranslationProvider>,
  );
  expect(screen.getByText("second.gguf")).toBeTruthy();
  expect(screen.queryByText("first.gguf")).toBeNull();
  view.rerender(
    <TranslationProvider>
      <DeviceBridgeStatusBar
        status={{
          connected: false,
          devices: [],
          primaryDeviceId: null,
          pendingRequests: 2,
        }}
      />
    </TranslationProvider>,
  );
  expect(screen.queryByText("second.gguf")).toBeNull();
  expect(screen.getByText(/2 request\(s\) paused/)).toBeTruthy();
});
