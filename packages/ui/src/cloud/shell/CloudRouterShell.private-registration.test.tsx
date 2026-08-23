/**
 * Mounted CloudRouterShell coverage for private registration UI states (#18056).
 */
// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetPrivateCloudRegistrationForTests,
  setPrivateCloudLoadForTests,
} from "../private-cloud-registration";
import { registerPublicCloudSurfaces } from "../register-public";
import { CloudRouterShell } from "./CloudRouterShell";

vi.mock("./StewardProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./StewardProvider")>();
  return {
    ...actual,
    StewardAuthProvider: ({ children }: { children: ReactNode }) => (
      <>{children}</>
    ),
  };
});

function base64url(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function localStewardToken(): string {
  return [
    base64url({ alg: "none", typ: "JWT" }),
    base64url({
      userId: "local-cloud-user",
      email: "local@example.test",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    "test-signature",
  ].join(".");
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetPrivateCloudRegistrationForTests();
});

beforeEach(() => {
  registerPublicCloudSurfaces();
  localStorage.setItem(STEWARD_TOKEN_KEY, localStewardToken());
  window.history.pushState({}, "", "/cloud/unknown-surface");
});

describe("CloudRouterShell private Cloud registration UI", () => {
  it("redirects a cold signed-out local Cloud detail route to canonical login with return intent", async () => {
    localStorage.removeItem(STEWARD_TOKEN_KEY);
    window.history.replaceState(
      {},
      "",
      "/cloud/agents/565f9cb3-3836-4954-8ef5-cfa8d033dbc0?from=manual#status",
    );
    setPrivateCloudLoadForTests(() => new Promise<void>(() => undefined));

    render(
      <CloudRouterShell
        appElement={<div data-testid="self-hosted-login-view" />}
      />,
    );

    await waitFor(() => {
      expect(`${window.location.pathname}${window.location.search}`).toBe(
        "/login?returnTo=%2Fcloud%2Fagents%2F565f9cb3-3836-4954-8ef5-cfa8d033dbc0%3Ffrom%3Dmanual%23status",
      );
    });
    expect(screen.queryByTestId("self-hosted-login-view")).toBeNull();
  });

  it("shows pending then mounts the app after ready (idle → pending → ready)", async () => {
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
      expect(screen.getByTestId("app-probe")).toBeTruthy();
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
      expect(screen.getByTestId("app-probe")).toBeTruthy();
    });
    expect(attempts).toBe(2);
  });
});
