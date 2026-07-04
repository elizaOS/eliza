// @vitest-environment jsdom
//
// Interaction tests for MyRuntimesSection: it lists the runtimes, marks the
// active one, and fires switch/add-remote callbacks. Deterministic RTL/jsdom,
// no network.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../state/agent-profile-types";
import { MyRuntimesSection } from "./MyRuntimesSection";

afterEach(cleanup);

const RUNTIMES: AgentProfile[] = [
  {
    id: "local-1",
    label: "This device",
    kind: "local",
    createdAt: "2026-06-01T00:00:00.000Z",
  },
  {
    id: "cloud-1",
    label: "Cloud agent",
    kind: "cloud",
    apiBase: "https://x.agent.elizacloud.ai",
    createdAt: "2026-06-02T00:00:00.000Z",
  },
  {
    id: "vps-1",
    label: "My VPS",
    kind: "remote",
    apiBase: "http://100.72.1.4:3000",
    createdAt: "2026-06-03T00:00:00.000Z",
  },
];

describe("MyRuntimesSection", () => {
  it("lists every runtime and marks the active one", () => {
    render(
      <MyRuntimesSection
        runtimes={RUNTIMES}
        activeId="local-1"
        onSwitch={vi.fn()}
      />,
    );
    expect(screen.getByTestId("runtime-local-1")).toBeTruthy();
    expect(screen.getByTestId("runtime-cloud-1")).toBeTruthy();
    expect(screen.getByTestId("runtime-vps-1")).toBeTruthy();
    expect(screen.getByTestId("runtime-local-1-active")).toBeTruthy();
    // the active one has no "Use" button; the others do
    expect(screen.queryByTestId("runtime-local-1-use")).toBeNull();
    expect(screen.getByTestId("runtime-cloud-1-use")).toBeTruthy();
  });

  it("switching a runtime calls onSwitch with its id", async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn();
    render(
      <MyRuntimesSection
        runtimes={RUNTIMES}
        activeId="local-1"
        onSwitch={onSwitch}
      />,
    );
    await user.click(screen.getByTestId("runtime-vps-1-use"));
    expect(onSwitch).toHaveBeenCalledWith("vps-1");
  });

  it("the add-remote form is hidden without onAddRemote", () => {
    render(
      <MyRuntimesSection
        runtimes={RUNTIMES}
        activeId="local-1"
        onSwitch={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("add-remote-runtime")).toBeNull();
  });

  it("adding a remote requires a label + url, then emits the entry", async () => {
    const user = userEvent.setup();
    const onAddRemote = vi.fn();
    render(
      <MyRuntimesSection
        runtimes={RUNTIMES}
        activeId="local-1"
        onSwitch={vi.fn()}
        onAddRemote={onAddRemote}
      />,
    );
    const submit = screen.getByTestId("add-remote-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByTestId("add-remote-label"), "Laptop");
    await user.type(
      screen.getByTestId("add-remote-url"),
      "http://100.72.1.9:3000",
    );
    expect(submit.disabled).toBe(false);
    await user.click(submit);
    expect(onAddRemote).toHaveBeenCalledWith({
      label: "Laptop",
      apiBase: "http://100.72.1.9:3000",
      accessToken: undefined,
    });
  });
});
