/**
 * Mounted CloudRouterShell coverage for private registration UI states (#18056).
 */
// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetPrivateCloudRegistrationForTests,
  setPrivateCloudLoadForTests,
} from "../private-cloud-registration";
import { registerPublicCloudSurfaces } from "../register-public";
import { CloudRouterShell } from "./CloudRouterShell";

afterEach(() => {
  cleanup();
  resetPrivateCloudRegistrationForTests();
});

beforeEach(() => {
  registerPublicCloudSurfaces();
  window.history.pushState({}, "", "/dashboard/unknown-surface");
});

describe("CloudRouterShell dashboard private registration UI", () => {
  it("shows pending then Not found after ready (idle → pending → ready)", async () => {
    let resolveLoad!: () => void;
    setPrivateCloudLoadForTests(
      () =>
        new Promise<void>((res) => {
          resolveLoad = res;
        }),
    );

    render(<CloudRouterShell appElement={<div data-testid="app-probe" />} />);

    expect(document.querySelector("[aria-busy='true']")).toBeTruthy();
    expect(screen.queryByText("Not found")).toBeNull();
    expect(screen.queryByText("Console unavailable")).toBeNull();

    await act(async () => {
      resolveLoad();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByText("Not found")).toBeTruthy();
    });
  });

  it("shows Console unavailable on error and recovers after Retry", async () => {
    let attempts = 0;
    setPrivateCloudLoadForTests(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("load failed");
      }
    });

    await act(async () => {
      render(<CloudRouterShell appElement={<div data-testid="app-probe" />} />);
      // Flush the rejected ensurePrivateCloudSurfaces microtasks inside act.
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText("Console unavailable")).toBeTruthy();
    });

    await act(async () => {
      screen.getByRole("button", { name: "Retry" }).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText("Not found")).toBeTruthy();
    });
    expect(attempts).toBe(2);
  });
});
