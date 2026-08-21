/**
 * Verifies that a real registered overlay mounts through the app-window
 * renderer's generated agent surface and answers list/click interactions.
 */

// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentButton } from "../../agent-surface";
import { invokeViewInteract } from "../views/view-interact-registry";
import { AppWindowRenderer } from "./AppWindowRenderer";
import { registerOverlayApp } from "./overlay-app-registry";

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
    expect(onStop).toHaveBeenCalledOnce();
  });
});
