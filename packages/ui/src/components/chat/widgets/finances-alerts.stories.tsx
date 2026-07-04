/**
 * Storybook states for the Finances Alerts chat widget across populated,
 * empty, and interaction-focused render states.
 */
import type { Meta, StoryObj } from "@storybook/react";
import {
  assert,
  waitForTestId,
  withSeededHomeWidget,
} from "../../../storybook/home-widget-decorator";
import { FinancesAlertsWidget } from "./finances-alerts";

// The icon-first home Finances widget (#9304): shows ONE high-priority datum —
// the overdrawn balance (danger) or the soonest bill — and self-hides when
// nothing is attention-worthy. Seeded with the shared home-widget mock data.

const meta = {
  title: "Shell/Home Widgets/Finances",
  component: FinancesAlertsWidget,
  parameters: { layout: "centered" },
  decorators: [withSeededHomeWidget],
  args: { slot: "home" },
} satisfies Meta<typeof FinancesAlertsWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Overdrawn — the highest-escalation finances signal (danger tone). */
export const NeedsAttention: Story = {
  play: async ({ canvasElement }) => {
    const card = await waitForTestId(
      canvasElement,
      "chat-widget-finances-alerts",
    );
    assert(card instanceof HTMLButtonElement, "the whole card is a button");
    assert(
      /overdrawn/i.test(card.getAttribute("aria-label") ?? ""),
      "the aria-label carries the overdrawn meaning",
    );
  },
};

/**
 * Clicking the card navigates to the full Finances view via the shared
 * `eliza:navigate:view` rail — the single tap-to-open contract for every home
 * widget, proven here once.
 */
export const ClickNavigatesToView: Story = {
  play: async ({ canvasElement }) => {
    const card = await waitForTestId(
      canvasElement,
      "chat-widget-finances-alerts",
    );
    const navigated: string[] = [];
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ viewPath?: string }>).detail;
      if (detail?.viewPath) navigated.push(detail.viewPath);
    };
    window.addEventListener("eliza:navigate:view", onNav);
    card.click();
    window.removeEventListener("eliza:navigate:view", onNav);
    assert(
      navigated.includes("/finances"),
      `click navigates to /finances (saw ${navigated.join(",") || "nothing"})`,
    );
  },
};
