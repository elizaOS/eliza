/**
 * Mounted CloudRouterShell coverage for private registration UI states (#18056).
 */
// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetPrivateCloudRegistrationForTests,
  setPrivateCloudLoadForTests,
} from "../private-cloud-registration";
import { registerPublicCloudSurfaces } from "../register-public";
import { CloudRouterShell } from "./CloudRouterShell";
import { registerCloudRoute } from "./cloud-route-registry";
import { ManagedCloudPage } from "./ManagedCloudPage";

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

describe("hosted Cloud management without the agent runtime", () => {
  let agentMounts = 0;

  function AgentRuntime(): React.JSX.Element {
    useEffect(() => {
      agentMounts += 1;
    }, []);
    return <div data-testid="agent-chat-shell">Message Eliza</div>;
  }

  function mountShell(): void {
    render(
      <CloudRouterShell
        appElement={<AgentRuntime />}
        cloudManagementElement={<div>Hosted account management</div>}
      />,
    );
  }

  beforeEach(() => {
    agentMounts = 0;
  });

  it("mounts hosted account management without starting the agent app after registration", async () => {
    setPrivateCloudLoadForTests(async () => undefined);
    mountShell();
    await screen.findByText("Hosted account management");
    expect(screen.queryByTestId("agent-chat-shell")).toBeNull();
    expect(agentMounts).toBe(0);
    expect(window.location.pathname).toBe("/cloud/unknown-surface");
  });

  it("keeps registered Cloud routes on the hosted management renderer", async () => {
    setPrivateCloudLoadForTests(async () => undefined);
    registerCloudRoute({
      path: "cloud/billing/hosted-test",
      group: "cloud",
      element: () => <div>Route body</div>,
    });
    window.history.replaceState(
      {},
      "",
      "/cloud/billing/hosted-test?accountId=workspace#invoice",
    );
    mountShell();
    await screen.findByText("Hosted account management");
    expect(screen.queryByTestId("agent-chat-shell")).toBeNull();
    expect(
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    ).toBe("/cloud/billing/hosted-test?accountId=workspace#invoice");
  });

  it("holds the pending registration barrier before the management renderer mounts", async () => {
    let resolveLoad!: () => void;
    setPrivateCloudLoadForTests(
      () =>
        new Promise<void>((res) => {
          resolveLoad = res;
        }),
    );
    mountShell();
    expect(document.querySelector("[aria-busy='true']")).toBeTruthy();
    expect(screen.queryByText("Hosted account management")).toBeNull();
    expect(screen.queryByTestId("agent-chat-shell")).toBeNull();

    await act(async () => {
      resolveLoad();
      await Promise.resolve();
    });
    await screen.findByText("Hosted account management");
    expect(agentMounts).toBe(0);
  });

  it("keeps failure and retry intact before the management renderer mounts", async () => {
    let attempts = 0;
    setPrivateCloudLoadForTests(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("load failed");
      }
    });

    await act(async () => {
      mountShell();
      // Flush the rejected ensurePrivateCloudSurfaces microtasks inside act.
      await Promise.resolve();
      await Promise.resolve();
    });
    await screen.findByText("Console unavailable");
    expect(screen.queryByText("Hosted account management")).toBeNull();
    expect(screen.queryByTestId("agent-chat-shell")).toBeNull();

    await act(async () => {
      screen.getByRole("button", { name: "Retry" }).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await screen.findByText("Hosted account management");
    expect(attempts).toBe(2);
    expect(agentMounts).toBe(0);
  });

  it("keeps the unauthenticated management redirect to login with return intent", async () => {
    localStorage.removeItem(STEWARD_TOKEN_KEY);
    window.history.replaceState({}, "", "/cloud/account");
    setPrivateCloudLoadForTests(() => new Promise<void>(() => undefined));
    mountShell();
    await waitFor(() => {
      expect(`${window.location.pathname}${window.location.search}`).toBe(
        "/login?returnTo=%2Fcloud%2Faccount",
      );
    });
    expect(screen.queryByText("Hosted account management")).toBeNull();
    expect(screen.queryByTestId("agent-chat-shell")).toBeNull();
    expect(agentMounts).toBe(0);
  });

  it("renders the real ManagedCloudPage for account and billing with zero agent mounts", async () => {
    setPrivateCloudLoadForTests(async () => undefined);
    for (const path of ["cloud/account", "cloud/billing"]) {
      registerCloudRoute({
        path,
        group: "cloud",
        element: () => <div>Account body</div>,
      });
    }
    window.history.replaceState({}, "", "/cloud/account");
    render(
      <CloudRouterShell
        appElement={<AgentRuntime />}
        cloudManagementElement={<ManagedCloudPage />}
      />,
    );
    await screen.findByText("Account body");
    expect(
      screen.getByRole("button", {
        name: "Account menu for local@example.test",
      }),
    ).toBeTruthy();
    expect(screen.queryByTestId("agent-chat-shell")).toBeNull();
    expect(agentMounts).toBe(0);
  });
});
