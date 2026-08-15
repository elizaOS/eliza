/** Verifies AgentCard share Switch through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * `AgentCard` public/private Switch: decorative (menu item is the control),
 * no green ON-track or dead thumb selectors, Public/Private + Globe/Lock
 * remain the non-color state. i18n, router, and toast are doubled.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCard } from "./agent-card";

vi.mock("../lib/i18n", () => ({
  useT:
    () =>
    (
      key: string,
      options?: Record<string, unknown> & { defaultValue?: string },
    ) =>
      (options?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) =>
        String(options?.[name] ?? ""),
      ),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function renderCard(isPublic = false) {
  return render(
    <MemoryRouter>
      <AgentCard
        viewMode="list"
        agent={{
          id: "agent_1",
          name: "Ada",
          bio: "A fixture agent",
          isOwned: true,
          isPublic,
        }}
      />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe("AgentCard share Switch", () => {
  it("keeps the share Switch decorative with default track colors", async () => {
    const user = userEvent.setup({ delay: null });
    renderCard(false);

    const openButtons = screen.getAllByRole("button");
    const moreButton = openButtons.find(
      (button) => button.getAttribute("aria-label") !== "Open agent: Ada",
    );
    expect(moreButton).toBeTruthy();
    await user.click(moreButton as HTMLElement);

    const menuItem = await screen.findByRole("menuitem", { name: /Private/ });
    expect(within(menuItem).getByText("Private")).toBeTruthy();

    const toggle = menuItem.querySelector('[role="switch"]');
    expect(toggle).toBeTruthy();
    expect(toggle?.getAttribute("aria-hidden")).toBe("true");
    expect(toggle?.getAttribute("tabindex")).toBe("-1");
    expect(toggle?.className).toContain("pointer-events-none");
    expect(toggle?.className).not.toMatch(/bg-green-500/);
    expect(toggle?.className).not.toMatch(/switch-thumb/);
    expect(toggle?.className).toMatch(/data-\[state=checked\]:bg-accent/);
    expect(toggle?.className).toMatch(/data-\[state=unchecked\]:bg-input/);
  });

  it("names the ON state Public with a Globe icon, not color alone", async () => {
    const user = userEvent.setup({ delay: null });
    renderCard(true);

    const openButtons = screen.getAllByRole("button");
    const moreButton = openButtons.find(
      (button) => button.getAttribute("aria-label") !== "Open agent: Ada",
    );
    await user.click(moreButton as HTMLElement);

    const menuItem = await screen.findByRole("menuitem", { name: /Public/ });
    expect(within(menuItem).getByText("Public")).toBeTruthy();
    expect(menuItem.querySelector("svg")).toBeTruthy();
    expect(
      menuItem.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
    ).toBe("true");
  });
});
