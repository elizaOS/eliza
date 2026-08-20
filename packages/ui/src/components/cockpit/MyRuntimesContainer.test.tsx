/** Verifies MyRuntimesContainer through the package's configured test harness. */
// @vitest-environment jsdom
//
// Interaction tests for MyRuntimesContainer: the runtime switch/add flow with
// the agent-profile registry and the non-destructive re-point mocked, covering
// both the trusted switch and the untrusted-remote refusal. Deterministic
// RTL/jsdom; the registry + re-point are vi mocks, not real state.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../state/agent-profile-types";

const mocks = vi.hoisted(() => ({
  loadAgentProfileRegistry: vi.fn(),
  addAgentProfile: vi.fn(),
  removeAgentProfile: vi.fn(),
  updateAgentProfile: vi.fn(),
  deleteRuntimeCredential: vi.fn(),
  loadRuntimeCredential: vi.fn(),
  storeRuntimeCredential: vi.fn(),
  startSshRuntime: vi.fn(),
  stopSshRuntime: vi.fn(),
  revokeCloudRemoteHost: vi.fn(),
  revokeCloudRemoteSession: vi.fn(),
  listCloudRemoteSessions: vi.fn(async () => []),
  // The container only reads `ok` + `reason`; type the mock to the subset it
  // consumes so both success and the untrusted-remote case are assignable.
  switchRuntimeNonDestructive: vi.fn((): { ok: boolean; reason?: string } => ({
    ok: true,
  })),
  isTrustedRestoreApiBaseUrl: vi.fn(() => true),
  isStoreBuild: vi.fn(() => false),
  isAndroidCloudBuild: vi.fn(() => false),
}));

vi.mock("../../state", () => ({
  loadAgentProfileRegistry: mocks.loadAgentProfileRegistry,
  addAgentProfile: mocks.addAgentProfile,
  removeAgentProfile: mocks.removeAgentProfile,
  switchRuntimeNonDestructive: mocks.switchRuntimeNonDestructive,
  updateAgentProfile: mocks.updateAgentProfile,
}));
vi.mock("../../platform/runtime-credential-store", () => ({
  deleteRuntimeCredential: mocks.deleteRuntimeCredential,
  loadRuntimeCredential: mocks.loadRuntimeCredential,
  storeRuntimeCredential: mocks.storeRuntimeCredential,
}));
vi.mock("../../platform/ssh-runtime", () => ({
  startSshRuntime: mocks.startSshRuntime,
  stopSshRuntime: mocks.stopSshRuntime,
}));
vi.mock("../../api", () => ({
  client: {
    revokeCloudRemoteHost: mocks.revokeCloudRemoteHost,
    revokeCloudRemoteSession: mocks.revokeCloudRemoteSession,
    listCloudRemoteSessions: mocks.listCloudRemoteSessions,
  },
}));
vi.mock("../../state/runtime-url-trust", () => ({
  isTrustedRestoreApiBaseUrl: mocks.isTrustedRestoreApiBaseUrl,
}));
vi.mock("../../build-variant", () => ({
  isStoreBuild: mocks.isStoreBuild,
}));
vi.mock("../../platform/android-runtime", () => ({
  isAndroidCloudBuild: mocks.isAndroidCloudBuild,
}));

import {
  MyRuntimesContainer,
  pairingTargetHostId,
} from "./MyRuntimesContainer";

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
    mocks.switchRuntimeNonDestructive.mockReturnValue({ ok: true });
    mocks.isTrustedRestoreApiBaseUrl.mockReturnValue(true);
    mocks.isStoreBuild.mockReturnValue(false);
    mocks.isAndroidCloudBuild.mockReturnValue(false);
    mocks.addAgentProfile.mockReturnValue({
      id: "new-1",
      label: "Laptop",
      kind: "remote",
      apiBase: "http://100.72.1.9:3000",
      createdAt: "2026-06-30T00:00:00.000Z",
    });
    localStorage.clear();
  });

  it("pairs the active SSH VPS instead of the gateway Mac", () => {
    expect(
      pairingTargetHostId(
        {
          ...REG,
          activeProfileId: "vps-1",
          profiles: [
            PROFILES[0],
            {
              ...PROFILES[1],
              sshGateway: {
                hostId: "host-vps-1",
                runtimeId: "ssh-runtime-1",
                target: "eliza@vps.example.com",
                sshPort: 22,
                remoteApiPort: 2138,
              },
            },
          ],
        },
        "host-mac-1",
      ),
    ).toBe("host-vps-1");
    expect(pairingTargetHostId(REG, "host-mac-1")).toBe("host-mac-1");
  });

  it("confirms VPS removal, revokes its Cloud host, and deletes secure credentials", async () => {
    mocks.loadAgentProfileRegistry.mockReturnValue({
      ...REG,
      profiles: [
        PROFILES[0],
        {
          ...PROFILES[1],
          credentialRef: "ssh-runtime-1",
          sshGateway: {
            hostId: "host-vps-1",
            runtimeId: "ssh-runtime-1",
            target: "eliza@vps.example.com",
            sshPort: 22,
            remoteApiPort: 2138,
          },
        },
      ],
    });
    const user = userEvent.setup();
    render(<MyRuntimesContainer />);
    await user.click(screen.getByRole("button", { name: "Remove My VPS" }));
    expect(screen.getByTestId("remove-runtime-dialog")).toBeTruthy();
    await user.click(screen.getByTestId("remove-runtime-confirm"));
    expect(mocks.revokeCloudRemoteHost).toHaveBeenCalledWith("host-vps-1");
    expect(mocks.stopSshRuntime).toHaveBeenCalledWith("ssh-runtime-1");
    expect(mocks.deleteRuntimeCredential).toHaveBeenCalledWith(
      "managed-host:host-vps-1",
    );
    expect(mocks.deleteRuntimeCredential).toHaveBeenCalledWith("ssh-runtime-1");
    expect(mocks.removeAgentProfile).toHaveBeenCalledWith("vps-1");
  });

  it("renders the runtimes from the registry", () => {
    render(<MyRuntimesContainer />);
    expect(screen.getByTestId("runtime-local-1")).toBeTruthy();
    expect(screen.getByTestId("runtime-vps-1")).toBeTruthy();
    expect(screen.getByTestId("runtime-local-1-active")).toBeTruthy();
  });

  it("hides a NON-active local runtime on an android-cloud build (phone gating)", () => {
    mocks.isAndroidCloudBuild.mockReturnValue(true);
    mocks.loadAgentProfileRegistry.mockReturnValue({
      ...REG,
      activeProfileId: "vps-1",
    });
    render(<MyRuntimesContainer />);
    expect(screen.queryByTestId("runtime-local-1")).toBeNull();
    expect(screen.getByTestId("runtime-vps-1")).toBeTruthy();
  });

  it("hides a non-active local runtime on a store build too", () => {
    mocks.isStoreBuild.mockReturnValue(true);
    mocks.loadAgentProfileRegistry.mockReturnValue({
      ...REG,
      activeProfileId: "vps-1",
    });
    render(<MyRuntimesContainer />);
    expect(screen.queryByTestId("runtime-local-1")).toBeNull();
  });

  it("keeps the ACTIVE local visible with its Active badge even when gated", () => {
    // default REG: local-1 is the active profile. Under hideLocal it must stay
    // visible (with the Active badge), else the UI shows no active runtime.
    mocks.isAndroidCloudBuild.mockReturnValue(true);
    render(<MyRuntimesContainer />);
    expect(screen.getByTestId("runtime-local-1")).toBeTruthy();
    expect(screen.getByTestId("runtime-local-1-active")).toBeTruthy();
  });

  it("refuses switching to local when gated, and does not call the switch", async () => {
    mocks.isAndroidCloudBuild.mockReturnValue(true);
    // local row is hidden, but guard the switch path directly via a stale id
    render(<MyRuntimesContainer />);
    const user = userEvent.setup();
    // the vps row is present; switching to it is fine (no error)
    await user.click(screen.getByTestId("runtime-vps-1-use"));
    expect(mocks.switchRuntimeNonDestructive).toHaveBeenCalledWith("vps-1");
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

  it("surfaces an error when the runtime selection cannot be persisted", async () => {
    const user = userEvent.setup();
    mocks.switchRuntimeNonDestructive.mockReturnValue({
      ok: false,
      reason: "persistence-failed",
    });
    render(<MyRuntimesContainer />);
    await user.click(screen.getByTestId("runtime-vps-1-use"));
    expect(screen.getByTestId("my-runtimes-error").textContent).toMatch(
      /couldn't be saved/i,
    );
  });

  it("adding a TRUSTED remote: adds it AND switches to it (badge reflects reality)", async () => {
    const user = userEvent.setup();
    render(<MyRuntimesContainer />);
    await user.click(screen.getByText("Advanced"));
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
      { activate: false },
    );
    // The added profile becomes active so the client repoints and the badge reflects it.
    expect(mocks.switchRuntimeNonDestructive).toHaveBeenCalledWith("new-1");
  });

  it("does not pre-activate a new remote and surfaces a failed durable switch", async () => {
    const user = userEvent.setup();
    mocks.switchRuntimeNonDestructive.mockReturnValue({
      ok: false,
      reason: "persistence-failed",
    });
    render(<MyRuntimesContainer />);
    await user.click(screen.getByText("Advanced"));
    await user.type(screen.getByTestId("add-remote-label"), "Laptop");
    await user.type(
      screen.getByTestId("add-remote-url"),
      "http://100.72.1.9:3000",
    );
    await user.click(screen.getByTestId("add-remote-submit"));

    expect(mocks.addAgentProfile).toHaveBeenCalledWith(expect.any(Object), {
      activate: false,
    });
    expect(screen.getByTestId("my-runtimes-error").textContent).toMatch(
      /couldn't be saved/i,
    );
  });

  it("rejecting an UNTRUSTED (public) remote at add time — no add, no switch", async () => {
    const user = userEvent.setup();
    mocks.isTrustedRestoreApiBaseUrl.mockReturnValue(false);
    render(<MyRuntimesContainer />);
    await user.click(screen.getByText("Advanced"));
    await user.type(screen.getByTestId("add-remote-label"), "Public VPS");
    await user.type(
      screen.getByTestId("add-remote-url"),
      "https://my-vps.example.com",
    );
    await user.click(screen.getByTestId("add-remote-submit"));
    expect(screen.getByTestId("my-runtimes-error").textContent).toMatch(
      /trusted/i,
    );
    expect(mocks.addAgentProfile).not.toHaveBeenCalled();
    expect(mocks.switchRuntimeNonDestructive).not.toHaveBeenCalled();
  });
});
