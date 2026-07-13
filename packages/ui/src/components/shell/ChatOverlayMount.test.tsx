// @vitest-environment jsdom

/**
 * The shared ChatOverlayMount host-gate + the DockedChatOverlay wrapper
 * (#16200): the singular overlay renders only when this window is the active
 * chat host (so the chat lives in exactly one window), and DockedChatOverlay
 * provides the ShellControllerProvider a detached view window lacks.
 */
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockController = {
  messages: [],
  phase: "idle",
  isOpen: false,
} as unknown;

let isChatHost = true;
let firstRunComplete: boolean = true;

vi.mock("./ShellControllerContext.hooks", () => ({
  useShellControllerContext: () => mockController,
}));
vi.mock("./ShellControllerContext", () => ({
  ShellControllerProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="shell-controller-provider">{children}</div>
  ),
}));
vi.mock("../../state/app-store", () => ({
  useAppSelectorShallow: () => ({
    characterData: { name: "Eliza" },
    agentStatus: null,
    firstRunComplete,
  }),
}));
vi.mock("../../hooks/useRole", () => ({
  useRole: () => ({ isOwner: false, atLeast: () => true }),
}));
vi.mock("../../chat/useSlashCommandController", () => ({
  useSlashCommandController: () => ({}),
}));
vi.mock("../../state/useDesktopChatHost", () => ({
  useIsChatHostWindow: () => isChatHost,
}));
vi.mock("./ChatOverlay", () => ({
  ChatOverlay: () => <div data-testid="continuous-chat-overlay" />,
}));

import { ChatOverlayMount, DockedChatOverlay } from "./ChatOverlayMount";

afterEach(() => {
  cleanup();
  isChatHost = true;
  firstRunComplete = true;
});

describe("ChatOverlayMount host gate", () => {
  it("renders the singular overlay when this window is the chat host", () => {
    isChatHost = true;
    render(<ChatOverlayMount />);
    expect(screen.getByTestId("continuous-chat-overlay")).toBeTruthy();
  });

  it("renders nothing when this window is NOT the host (chat lives elsewhere)", () => {
    isChatHost = false;
    const { container } = render(<ChatOverlayMount />);
    expect(screen.queryByTestId("continuous-chat-overlay")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("always renders during first-run onboarding, even when not host", () => {
    // The first-run conductor lives inside the overlay; a focus change must
    // never hide it.
    isChatHost = false;
    firstRunComplete = false;
    render(<ChatOverlayMount />);
    expect(screen.getByTestId("continuous-chat-overlay")).toBeTruthy();
  });
});

describe("DockedChatOverlay", () => {
  it("wraps the mount in its own ShellControllerProvider for detached windows", () => {
    isChatHost = true;
    render(<DockedChatOverlay />);
    expect(screen.getByTestId("shell-controller-provider")).toBeTruthy();
    expect(screen.getByTestId("continuous-chat-overlay")).toBeTruthy();
  });

  it("stays hidden in a detached window that is not the focused host", () => {
    isChatHost = false;
    render(<DockedChatOverlay />);
    // The provider still mounts (cheap), but the overlay inside is gated off.
    expect(screen.getByTestId("shell-controller-provider")).toBeTruthy();
    expect(screen.queryByTestId("continuous-chat-overlay")).toBeNull();
  });
});
