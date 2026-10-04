// @vitest-environment jsdom
import "./AppWindowRenderer.routes";

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AppLaunchResult,
  type AppViewerConfig,
  client,
  type RegistryAppInfo,
} from "../../api";
import { AppWindowRenderer } from "./AppWindowRenderer";

const fixture = vi.hoisted(() => ({
  catalog: [
    {
      name: "@elizaos/app-window-catalog-fixture",
      displayName: "Catalog window",
    },
  ],
  t: (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));
vi.mock("../../state/useApp", () => ({ useApp: () => ({ t: fixture.t }) }));
vi.mock("./useRegistryCatalog", () => ({
  useRegistryCatalog: () => ({
    catalog: fixture.catalog as RegistryAppInfo[],
    error: null,
    loading: false,
  }),
}));
// Load the real lazy chunk during module setup rather than a timed DOM wait.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function launchResult(runId: string, viewer: AppViewerConfig): AppLaunchResult {
  const health = { state: "healthy" as const, message: null };
  return {
    pluginInstalled: true,
    needsRestart: false,
    displayName: "Catalog window",
    launchType: "viewer",
    launchUrl: null,
    viewer,
    session: null,
    run: {
      runId,
      appName: fixture.catalog[0].name,
      displayName: "Catalog window",
      pluginName: fixture.catalog[0].name,
      launchType: "viewer",
      launchUrl: null,
      viewer,
      session: null,
      characterId: null,
      agentId: null,
      status: "running",
      summary: null,
      startedAt: "2026-10-02T00:00:00Z",
      updatedAt: "2026-10-02T00:00:00Z",
      lastHeartbeatAt: null,
      supportsBackground: false,
      supportsViewerDetach: true,
      chatAvailability: "unavailable",
      controlAvailability: "unavailable",
      viewerAttachment: "attached",
      recentEvents: [],
      awaySummary: null,
      health,
      healthDetails: {
        checkedAt: null,
        auth: health,
        runtime: health,
        viewer: health,
        chat: health,
        control: health,
        message: null,
      },
    },
  };
}

describe("catalog app windows", () => {
  it("launches once under StrictMode and pins authentication to the viewer", async () => {
    const authMessage = {
      type: "FEED_AUTH",
      authToken: "synthetic-window-token",
    };
    const launch = vi.spyOn(client, "launchApp").mockResolvedValue(
      launchResult("window-run", {
        url: "https://viewer.example.test/app",
        postMessageAuth: true,
        authMessage,
        sandbox: "allow-scripts allow-same-origin",
      }),
    );
    const addWindowListener = vi.spyOn(window, "addEventListener");
    render(
      <StrictMode>
        <AppWindowRenderer slug="window-catalog-fixture" />
      </StrictMode>,
    );
    const iframe = (await screen.findByTitle(
      "Catalog window",
    )) as HTMLIFrameElement;
    // The iframe can be in the DOM before the viewer's passive effect arms its
    // handshake listener; dispatching earlier would make every check vacuous.
    await waitFor(() =>
      expect(addWindowListener).toHaveBeenCalledWith(
        "message",
        expect.any(Function),
      ),
    );
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith("@elizaos/app-window-catalog-fixture");
    const viewerWindow = iframe.contentWindow;
    if (!viewerWindow) throw new Error("Viewer window is unavailable");
    const post = vi.spyOn(viewerWindow, "postMessage");
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          origin: "https://attacker.example.test",
          data: { type: "FEED_READY" },
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          origin: "https://viewer.example.test",
          data: { type: "FEED_READY" },
        }),
      );
      expect(post).not.toHaveBeenCalled();
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          origin: "https://viewer.example.test",
          data: { type: "FEED_READY" },
        }),
      );
    });
    await waitFor(() =>
      expect(post).toHaveBeenCalledExactlyOnceWith(
        authMessage,
        "https://viewer.example.test",
      ),
    );
  });

  it("removes same-origin iframe privilege and shows launch errors", async () => {
    const launch = vi.spyOn(client, "launchApp").mockResolvedValue(
      launchResult("same-origin-run", {
        url: "/api/apps/viewer",
        sandbox: "allow-scripts allow-same-origin",
      }),
    );
    const rendered = render(
      <AppWindowRenderer slug="window-catalog-fixture" />,
    );
    const iframe = await screen.findByTitle("Catalog window");
    expect(iframe.getAttribute("sandbox")).toContain("allow-scripts");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    rendered.unmount();
    launch.mockRejectedValue(new Error("Catalog launch failed"));
    render(<AppWindowRenderer slug="window-catalog-fixture" />);
    expect(await screen.findByText("Catalog launch failed")).toBeTruthy();
    expect(screen.queryByTitle("Catalog window")).toBeNull();
  });

  it("reports a launch URL that could not be opened instead of claiming success", async () => {
    // No viewer, and a launch URL the navigation allowlist refuses, so
    // openExternalUrl resolves false and nothing opens.
    const result = launchResult("external-run", {
      url: "https://viewer.example.test/app",
    });
    vi.spyOn(client, "launchApp").mockResolvedValue({
      ...result,
      viewer: null,
      launchUrl: "javascript:alert(1)",
      run: result.run ? { ...result.run, viewer: null } : null,
    });
    render(<AppWindowRenderer slug="window-catalog-fixture" />);
    expect(
      await screen.findByText("Could not launch Catalog window"),
    ).toBeTruthy();
    expect(
      screen.getByText(/Could not open this app in your browser/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(/opened in your browser/)).toBeNull();
  });
});
