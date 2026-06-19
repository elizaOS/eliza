// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavState, PairingPayload, ViewName } from "../services";

// Controllable navigation + intent stubs so we can route renderView() by
// (view, ready) without driving the real persistence/haptics hook.
const navState = vi.hoisted(
  () =>
    ({ view: "chat", ready: true, push: vi.fn(), pop: vi.fn() }) as {
      view: ViewName;
      ready: boolean;
      push: ReturnType<typeof vi.fn>;
      pop: ReturnType<typeof vi.fn>;
    },
);
const getPairingStatus = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{
      paired: boolean;
      agentUrl: string | null;
      deviceId: string | null;
    }> => ({ paired: false, agentUrl: null, deviceId: null }),
  ),
);

vi.mock("../services", async () => {
  const actual =
    await vi.importActual<typeof import("../services")>("../services");
  return {
    ...actual,
    useNavigation: (): NavState => ({
      view: navState.view,
      ready: navState.ready,
      push: navState.push as NavState["push"],
      pop: navState.pop as NavState["pop"],
    }),
    ElizaIntent: { getPairingStatus, setPairingStatus: vi.fn() },
    registerPush: vi.fn(async () => ({ unregister: async () => {} })),
    apnsEnabled: () => false,
    agentUrl: () => null,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

import { PhoneCompanionApp } from "./PhoneCompanionApp";

const validPayload: PairingPayload = {
  agentId: "agent-1",
  pairingCode: "code-1",
  ingressUrl: "wss://relay.example/input",
  sessionToken: "tok-1",
};

beforeEach(() => {
  navState.view = "chat";
  navState.ready = true;
  navState.push = vi.fn();
  navState.pop = vi.fn();
  getPairingStatus.mockResolvedValue({
    paired: false,
    agentUrl: null,
    deviceId: null,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PhoneCompanionApp routing", () => {
  it("shows the loading panel until navigation is ready", async () => {
    navState.ready = false;
    render(<PhoneCompanionApp />);
    expect(screen.getByText("Starting")).toBeTruthy();
    // No view chrome while loading.
    expect(screen.queryByText("Companion")).toBeNull();
  });

  it("renders the Chat view when ready and view is 'chat'", async () => {
    render(<PhoneCompanionApp />);
    await screen.findByText("Companion");
    expect(screen.getByText("Offline")).toBeTruthy();
    // Not yet paired -> remote-session unavailable.
    const remote = screen
      .getByText("Remote")
      .closest("button") as HTMLButtonElement;
    expect(remote.disabled).toBe(true);
  });

  it("renders the Pairing view when view is 'pairing'", async () => {
    navState.view = "pairing";
    render(<PhoneCompanionApp />);
    expect(await screen.findByText("Pair with Eliza")).toBeTruthy();
  });

  it("falls back to Chat for 'remote-session' without a pairing payload", async () => {
    navState.view = "remote-session";
    render(<PhoneCompanionApp />);
    // No payload captured yet -> Chat, with remote-session marked unavailable.
    await screen.findByText("Companion");
    expect(screen.queryByText("Remote desktop")).toBeNull();
    expect(screen.queryByRole("button", { name: "Exit" })).toBeNull();
  });

  it("hydrates the agent URL from a paired native status", async () => {
    getPairingStatus.mockResolvedValue({
      paired: true,
      agentUrl: "wss://saved.example/input",
      deviceId: "dev-1",
    });
    render(<PhoneCompanionApp />);
    await waitFor(() =>
      expect(screen.getByText("wss://saved.example/input")).toBeTruthy(),
    );
    expect(screen.getByText("Paired")).toBeTruthy();
  });

  it("pushes 'remote-session' and renders RemoteSession after onPaired", async () => {
    // Start on the pairing screen so onPaired is wired to the Pairing form.
    navState.view = "pairing";
    // push() should be invoked with "remote-session"; emulate the host applying
    // it by flipping the controlled nav view and re-rendering.
    navState.push = vi.fn((next: ViewName) => {
      navState.view = next;
    });
    const { rerender } = render(<PhoneCompanionApp />);
    await screen.findByText("Pair with Eliza");

    const encoded = Buffer.from(JSON.stringify(validPayload), "utf8").toString(
      "base64",
    );
    fireEvent.change(screen.getByLabelText("Or paste payload"), {
      target: { value: encoded },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pair device" }));
    });

    await waitFor(() =>
      expect(navState.push).toHaveBeenCalledWith("remote-session"),
    );
    rerender(<PhoneCompanionApp />);
    // RemoteSession header carries the Exit + Reconnect controls.
    await screen.findByRole("button", { name: "Exit" });
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });
});
