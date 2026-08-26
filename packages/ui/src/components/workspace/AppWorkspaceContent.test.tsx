/** Verifies the routed workspace content lifecycle boundary. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppWorkspaceContent } from "./AppWorkspaceContent";

vi.mock("../../hooks", () => ({
  useMediaQuery: () => false,
}));

const CHAT_CLEARANCE = "pb-[var(--eliza-chat-clearance,5.25rem)]";

function chatClearanceOwners(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("*")).filter(
    (element) => element.className.includes(CHAT_CLEARANCE),
  );
}

describe("AppWorkspaceContent", () => {
  afterEach(cleanup);

  it("keeps a fixed header inside the contained view boundary and reserves clearance once", () => {
    const { container } = render(
      <AppWorkspaceContent
        header={<div data-testid="workspace-header">Header</div>}
      >
        <div data-testid="workspace-body">Body</div>
      </AppWorkspaceContent>,
    );

    const region = container.querySelector<HTMLElement>(
      '[data-shell-content-region="true"]',
    );
    expect(region).not.toBeNull();
    expect(region?.contains(screen.getByTestId("workspace-header"))).toBe(true);
    expect(region?.contains(screen.getByTestId("workspace-body"))).toBe(true);
    expect(
      container.querySelector('[data-shell-scroll-region="true"]'),
    ).toBeNull();
    expect(chatClearanceOwners(container)).toEqual([region]);
  });

  it("keeps a fixed header outside the router-owned scroller and moves clearance onto that scroller", () => {
    const { container } = render(
      <AppWorkspaceContent
        header={<div data-testid="workspace-header">Header</div>}
        layout="scroll"
      >
        <div data-testid="workspace-body">Body</div>
      </AppWorkspaceContent>,
    );

    const scrollRegion = container.querySelector<HTMLElement>(
      '[data-shell-scroll-region="true"]',
    );
    expect(scrollRegion).not.toBeNull();
    expect(scrollRegion?.contains(screen.getByTestId("workspace-header"))).toBe(
      false,
    );
    expect(scrollRegion?.contains(screen.getByTestId("workspace-body"))).toBe(
      true,
    );
    expect(chatClearanceOwners(container)).toEqual([scrollRegion]);
  });

  it("lets fullscreen surfaces opt out of floating-chat clearance", () => {
    const { container } = render(
      <AppWorkspaceContent reserveChatClearance={false}>
        <div>Fullscreen content</div>
      </AppWorkspaceContent>,
    );

    expect(chatClearanceOwners(container)).toEqual([]);
  });
});
