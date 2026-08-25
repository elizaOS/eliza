/**
 * Verifies that a real registered overlay mounts through the app-window
 * renderer's generated agent surface and answers list/click interactions.
 */

// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentButton } from "../../agent-surface";
import { invokeViewInteract } from "../views/view-interact-registry";
import { AppWindowRenderer, OverlayAppSurface } from "./AppWindowRenderer";
import { registerOverlayApp } from "./overlay-app-registry";

const reportRendererDiagnostic = vi.hoisted(() => vi.fn());
vi.mock("../../utils/renderer-diagnostics", () => ({
  reportRendererDiagnostic,
}));

afterEach(cleanup);

describe("AppWindowRenderer agent bridge", () => {
  it("derives the overlay view id and drives its registered control", async () => {
    const onClick = vi.fn();
    const onLaunch = vi.fn();
    const onStop = vi.fn();
    registerOverlayApp({
      name: "@elizaos/plugin-bridge-window-test",
      displayName: "Bridge Window Test",
      description: "Agent bridge fixture",
      category: "test",
      icon: null,
      Component: () => (
        <AgentButton agentId="confirm" onClick={onClick}>
          Confirm
        </AgentButton>
      ),
      onLaunch,
      onStop,
    });

    const rendered = render(<AppWindowRenderer slug="bridge-window-test" />);
    await screen.findByRole("button", { name: "Confirm" });
    await waitFor(() => expect(onLaunch).toHaveBeenCalledOnce());

    const marker = rendered.container.querySelector(
      '[data-agent-surface-view-id="bridge-window-test"]',
    );
    expect(marker?.getAttribute("data-agent-surface-kind")).toBe("overlay");

    const elements = (await invokeViewInteract(
      "bridge-window-test",
      "gui",
      "list-elements",
    )) as Array<{ id: string }>;
    expect(elements.map(({ id }) => id)).toContain("confirm");

    expect(
      await invokeViewInteract("bridge-window-test", "gui", "agent-click", {
        id: "confirm",
      }),
    ).toMatchObject({ ok: true, id: "confirm" });
    expect(onClick).toHaveBeenCalledOnce();

    rendered.unmount();
    await waitFor(() => expect(onStop).toHaveBeenCalledOnce());
  });

  it("waits for an in-flight launch before stopping an unmounted app", async () => {
    let finishLaunch: (() => void) | undefined;
    const launchBarrier = new Promise<void>((resolve) => {
      finishLaunch = resolve;
    });
    const onLaunch = vi.fn(() => launchBarrier);
    const onStop = vi.fn();
    registerOverlayApp({
      name: "@elizaos/plugin-bridge-lifecycle-barrier-test",
      displayName: "Bridge lifecycle barrier test",
      description: "Agent bridge lifecycle fixture",
      category: "test",
      icon: null,
      Component: () => <div>Lifecycle fixture</div>,
      onLaunch,
      onStop,
    });

    const rendered = render(
      <AppWindowRenderer slug="bridge-lifecycle-barrier-test" />,
    );
    await waitFor(() => expect(onLaunch).toHaveBeenCalledOnce());
    rendered.unmount();
    await Promise.resolve();
    expect(onStop).not.toHaveBeenCalled();

    finishLaunch?.();
    await waitFor(() => expect(onStop).toHaveBeenCalledOnce());
  });

  it("reports a rejected launch and still runs ordered teardown", async () => {
    reportRendererDiagnostic.mockClear();
    const failure = new Error("launch failed");
    const onStop = vi.fn();
    registerOverlayApp({
      name: "@elizaos/plugin-bridge-lifecycle-failure-test",
      displayName: "Bridge lifecycle failure test",
      description: "Agent bridge lifecycle failure fixture",
      category: "test",
      icon: null,
      Component: () => <div>Lifecycle failure fixture</div>,
      onLaunch: async () => {
        throw failure;
      },
      onStop,
    });

    const rendered = render(
      <AppWindowRenderer slug="bridge-lifecycle-failure-test" />,
    );
    await waitFor(() =>
      expect(reportRendererDiagnostic).toHaveBeenCalledWith({
        scope: "overlay-app.launch",
        error: failure,
        context: {
          appName: "@elizaos/plugin-bridge-lifecycle-failure-test",
        },
      }),
    );
    rendered.unmount();
    await waitFor(() => expect(onStop).toHaveBeenCalledOnce());
  });

  it("serializes Strict Mode lifecycle replay without overlapping owners", async () => {
    const phases: string[] = [];
    const app = {
      name: "@elizaos/plugin-bridge-strict-lifecycle-test",
      displayName: "Bridge strict lifecycle test",
      description: "Agent bridge Strict Mode lifecycle fixture",
      category: "test",
      icon: null,
      Component: () => <div>Strict lifecycle fixture</div>,
      onLaunch: async () => {
        phases.push("launch");
      },
      onStop: async () => {
        phases.push("stop");
      },
    };
    registerOverlayApp(app);

    const rendered = render(
      <StrictMode>
        <OverlayAppSurface
          app={app}
          exitToApps={() => {}}
          uiTheme="light"
          t={(key) => key}
        />
      </StrictMode>,
    );
    await waitFor(() => expect(phases).toEqual(["launch", "stop", "launch"]));

    rendered.unmount();
    await waitFor(() =>
      expect(phases).toEqual(["launch", "stop", "launch", "stop"]),
    );
  });
});
