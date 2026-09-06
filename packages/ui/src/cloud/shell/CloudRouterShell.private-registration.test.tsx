/**
 * Mounted CloudRouterShell coverage for private registration UI states (#18056).
 */
// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useEffect } from "react";
import { Link } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { savePersistedActiveServer } from "../../state/persistence";
import { useSessionAuth } from "../lib/use-session-auth";
import {
  resetPrivateCloudRegistrationForTests,
  setPrivateCloudLoadForTests,
} from "../private-cloud-registration";
import {
  consumePendingOAuthReturnTo,
  resolveLoginReturnTo,
  storePendingOAuthReturnTo,
} from "../public-pages/lib/login-return-to";
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

function localStewardToken(
  userId = "local-cloud-user",
  email = "local@example.test",
): string {
  return [
    base64url({ alg: "none", typ: "JWT" }),
    base64url({
      userId,
      email,
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
        cloudManagementElement={<div data-testid="private-management" />}
      />,
    );

    await waitFor(() => {
      expect(`${window.location.pathname}${window.location.search}`).toBe(
        "/login?returnTo=%2Fcloud%2Fagents%2F565f9cb3-3836-4954-8ef5-cfa8d033dbc0%3Ffrom%3Dmanual%23status",
      );
    });
    expect(screen.queryByTestId("self-hosted-login-view")).toBeNull();
    expect(screen.queryByTestId("private-management")).toBeNull();
  });

  it("mounts hosted account management without starting the agent app after registration", async () => {
    setPrivateCloudLoadForTests(async () => undefined);
    render(
      <CloudRouterShell
        appElement={<div data-testid="agent-runtime" />}
        cloudManagementElement={<div>Independent app administration</div>}
      />,
    );
    await screen.findByText("Independent app administration");
    expect(screen.queryByTestId("agent-runtime")).toBeNull();
    expect(window.location.pathname).toBe("/cloud/unknown-surface");
  });

  it("keeps registered Cloud routes on the hosted management renderer", async () => {
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
    render(
      <CloudRouterShell
        appElement={<div data-testid="agent-runtime" />}
        cloudManagementElement={<div>Hosted account management</div>}
      />,
    );
    await screen.findByText("Hosted account management");
    expect(screen.queryByTestId("agent-runtime")).toBeNull();
    expect(
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    ).toBe("/cloud/billing/hosted-test?accountId=workspace#invoice");
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

function navigateManagement(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function ManagementIdentity(): React.JSX.Element {
  const { user } = useSessionAuth();
  return <p>Management identity: {user?.id}</p>;
}

describe("agentless Cloud management navigation", () => {
  let agentMounts = 0;

  function AgentRuntime(): React.JSX.Element {
    useEffect(() => {
      agentMounts += 1;
    }, []);
    return (
      <Link to="/settings?from=launcher#cloud-applications">
        Manage applications
      </Link>
    );
  }

  function mountShell(): void {
    render(
      <CloudRouterShell
        appElement={<AgentRuntime />}
        cloudManagementElement={<ManagedCloudPage />}
      />,
    );
  }

  beforeEach(() => {
    agentMounts = 0;
    setPrivateCloudLoadForTests(async () => undefined);
    for (const path of [
      "cloud/apps",
      "cloud/account",
      "cloud/billing",
      "cloud/api-keys",
    ]) {
      registerCloudRoute({ path, group: "cloud", element: ManagementIdentity });
    }
  });

  it.each([
    ["/cloud/apps", "/cloud/apps"],
    ["/settings?from=launcher#cloud-applications", "/cloud/apps?from=launcher"],
    ["/settings#cloud-account", "/cloud/account"],
    ["/settings#cloud-billing", "/cloud/billing"],
    ["/settings#cloud-api-keys", "/cloud/api-keys"],
  ])(
    "opens %s with only a Cloud identity and no agent or credits",
    async (entry, destination) => {
      window.history.replaceState({}, "", entry);
      mountShell();
      await screen.findByText("Management identity: local-cloud-user");
      expect(`${window.location.pathname}${window.location.search}`).toBe(
        destination,
      );
      expect(agentMounts).toBe(0);
      expect(
        screen.getByRole("button", {
          name: "Account menu for local@example.test",
        }),
      ).toBeTruthy();
    },
  );

  it("leaves a warm agent shell for managed applications without mounting it again", async () => {
    window.history.replaceState({}, "", "/chat");
    mountShell();
    expect(agentMounts).toBe(1);
    await act(async () => {
      screen.getByRole("link", { name: "Manage applications" }).click();
    });
    await screen.findByText("Management identity: local-cloud-user");
    expect(
      screen.queryByRole("link", { name: "Manage applications" }),
    ).toBeNull();
    expect(agentMounts).toBe(1);
  });

  it("preserves a signed-out management destination through the actual OAuth return store", async () => {
    localStorage.clear();
    window.history.replaceState(
      {},
      "",
      "/settings?from=launcher#cloud-applications",
    );
    mountShell();
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    storePendingOAuthReturnTo(new URLSearchParams(window.location.search));
    const returnTo = resolveLoginReturnTo(
      new URLSearchParams(),
      consumePendingOAuthReturnTo(),
    );
    expect(returnTo).toBe("/cloud/apps?from=launcher");
    expect(agentMounts).toBe(0);
    await act(async () => {
      localStorage.setItem(
        STEWARD_TOKEN_KEY,
        localStewardToken("new-owner", "owner@example.test"),
      );
      window.dispatchEvent(new Event("steward-token-sync"));
      navigateManagement(returnTo);
    });
    await screen.findByText("Management identity: new-owner");
    expect(
      screen.queryByText("Management identity: local-cloud-user"),
    ).toBeNull();
    expect(agentMounts).toBe(0);
  });

  it("drops managed content on sign-out and uses the next account on return", async () => {
    window.history.replaceState({}, "", "/cloud/apps");
    savePersistedActiveServer({
      id: "cloud:previous-agent",
      kind: "cloud",
      label: "Previous owner agent",
      apiBase: "https://api.eliza.app/api/v1/eliza/agents/previous-agent",
    });
    mountShell();
    await screen.findByText("Management identity: local-cloud-user");
    await act(async () => {
      localStorage.removeItem(STEWARD_TOKEN_KEY);
      window.dispatchEvent(new Event("steward-token-sync"));
    });
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    expect(
      screen.queryByText("Management identity: local-cloud-user"),
    ).toBeNull();
    await act(async () => {
      localStorage.setItem(
        STEWARD_TOKEN_KEY,
        localStewardToken("different-owner", "different@example.test"),
      );
      window.dispatchEvent(new Event("steward-token-sync"));
      navigateManagement("/cloud/apps");
    });
    await screen.findByText("Management identity: different-owner");
    expect(
      screen.getByRole("button", {
        name: "Account menu for different@example.test",
      }),
    ).toBeTruthy();
    expect(agentMounts).toBe(0);
  });

  it("keeps ordinary settings in the agent app", async () => {
    window.history.replaceState({}, "", "/settings#appearance");
    mountShell();
    await screen.findByRole("link", { name: "Manage applications" });
    expect(agentMounts).toBe(1);
    expect(window.location.hash).toBe("#appearance");
  });
});
