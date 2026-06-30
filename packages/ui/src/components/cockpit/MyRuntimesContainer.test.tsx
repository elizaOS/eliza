// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../state/agent-profile-types";
import type { SwitchRuntimeResult } from "../../state/switch-runtime";

const mocks = vi.hoisted(() => ({
  loadAgentProfileRegistry: vi.fn(),
  addAgentProfile: vi.fn(),
  switchRuntimeNonDestructive: vi.fn(
    (_id: string): SwitchRuntimeResult => ({
      ok: true,
      profile: { id: _id } as AgentProfile,
    }),
  ),
}));

vi.mock("../../state", () => ({
  loadAgentProfileRegistry: mocks.loadAgentProfileRegistry,
  addAgentProfile: mocks.addAgentProfile,
  switchRuntimeNonDestructive: mocks.switchRuntimeNonDestructive,
}));

import { MyRuntimesContainer } from "./MyRuntimesContainer";

const PROFILES: AgentProfile[] = [
  {
    id: "local-1",
    label: "This device",
    kind: "local",
    createdAt: "2026-06-01T00:00:00.000Z",
  },
  {
    id: "vps-1",
    label: "My VPS",
    kind: "remote",
    apiBase: "http://100.72.1.4:3000",
    createdAt: "2026-06-03T00:00:00.000Z",
  },
];
const REG = {
  version: 1 as const,
  activeProfileId: "local-1",
  profiles: PROFILES,
};

afterEach(cleanup);

describe("MyRuntimesContainer", () => {
  beforeEach(() => {
    for (const f of Object.values(mocks)) f.mockClear();
    mocks.loadAgentProfileRegistry.mockReturnValue(REG);
    mocks.switchRuntimeNonDestructive.mockReturnValue({
      ok: true,
      profile: PROFILES[1],
    });
  });

  it("renders the runtimes from the registry", () => {
    render(<MyRuntimesContainer />);
    expect(screen.getByTestId("runtime-local-1")).toBeTruthy();
    expect(screen.getByTestId("runtime-vps-1")).toBeTruthy();
    expect(screen.getByTestId("runtime-local-1-active")).toBeTruthy();
  });

  it("switching a runtime calls switchRuntimeNonDestructive", async () => {
    const user = userEvent.setup();
    render(<MyRuntimesContainer />);
    await user.click(screen.getByTestId("runtime-vps-1-use"));
    expect(mocks.switchRuntimeNonDestructive).toHaveBeenCalledWith("vps-1");
  });

  it("surfaces an error when switching to an untrusted remote", async () => {
    const user = userEvent.setup();
    mocks.switchRuntimeNonDestructive.mockReturnValue({
      ok: false,
      reason: "untrusted-remote",
    });
    render(<MyRuntimesContainer />);
    await user.click(screen.getByTestId("runtime-vps-1-use"));
    expect(screen.getByTestId("my-runtimes-error").textContent).toMatch(
      /trusted/i,
    );
  });

  it("adding a remote calls addAgentProfile with kind=remote", async () => {
    const user = userEvent.setup();
    render(<MyRuntimesContainer />);
    await user.type(screen.getByTestId("add-remote-label"), "Laptop");
    await user.type(
      screen.getByTestId("add-remote-url"),
      "http://100.72.1.9:3000",
    );
    await user.click(screen.getByTestId("add-remote-submit"));
    expect(mocks.addAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "remote",
        label: "Laptop",
        apiBase: "http://100.72.1.9:3000",
      }),
    );
  });
});
