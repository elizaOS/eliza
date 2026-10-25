/** Storybook + story-gate visual states for the shared HomeWidgetCard shell. */
import type { Meta, StoryObj } from "@storybook/react";
import {
  CalendarDays,
  Heart,
  Inbox,
  Moon,
  Target,
  TriangleAlert,
  Wallet,
} from "lucide-react";
import { assert } from "../../../storybook/home-widget-decorator";
import { HomeWidgetCard } from "./home-widget-card";

// Module-scoped capture for the activation play (no @storybook/test in repo).
let activateCount = 0;

// The icon-first home-widget primitive (#9304): an icon, a single high-priority
// datum, an optional tight meta + status badge — and the WHOLE card is one
// button. The visible text is intentionally minimal (no label eyebrow); the
// full meaning lives in `ariaLabel`. These stories cover every tone and the
// click → onActivate contract that drives navigation.

const meta = {
  title: "Shell/Home Widgets/Card",
  component: HomeWidgetCard,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      // Sits on the orange home wallpaper in the app; a tinted surface here so
      // the translucent glass tile reads the same way it does on the home.
      <div className="w-[360px] rounded-2xl bg-accent/20 p-4">
        <Story />
      </div>
    ),
  ],
  args: {
    onActivate: () => {},
  },
} satisfies Meta<typeof HomeWidgetCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Danger tone — the overdrawn balance, the highest-escalation home signal. */
export const Danger: Story = {
  args: {
    icon: <Wallet />,
    label: "Bills",
    value: "−$125.50",
    badge: "Overdrawn",
    tone: "danger",
    testId: "home-card-finances",
    ariaLabel: "Finances: account overdrawn by $125.50. Open finances.",
  },
};

/** Warn tone — an at-risk goal with a count badge. */
export const Warn: Story = {
  args: {
    icon: <Target />,
    label: "Goals",
    value: "Ship the release",
    badge: "At risk",
    tone: "warn",
    testId: "home-card-goals",
    ariaLabel: "Goals: 'Ship the release' is at risk. Open goals.",
  },
};

/** Default tone with a tight `meta` — the next calendar event. */
export const WithMeta: Story = {
  args: {
    icon: <CalendarDays />,
    label: "Calendar",
    value: "Design review",
    meta: "in 45m",
    testId: "home-card-calendar",
    ariaLabel: "Calendar: 'Design review' in 45 minutes. Open calendar.",
  },
};

/** Default tone with a count badge — unread inbox threads. */
export const WithBadge: Story = {
  args: {
    icon: <Inbox />,
    label: "Inbox",
    value: "Alex Rivera",
    badge: "2",
    testId: "home-card-inbox",
    ariaLabel: "Inbox: 2 unread threads, latest from Alex Rivera. Open inbox.",
  },
};

/** Value-and-badge, default tone — off-rhythm sleep. */
export const StatusOnly: Story = {
  args: {
    icon: <Moon />,
    label: "Sleep",
    value: "5h 45m",
    badge: "Irregular",
    testId: "home-card-health",
    ariaLabel: "Sleep: 5 hours 45 minutes last night, irregular. Open health.",
  },
};

/** Minimal — icon + a single datum, nothing else. */
export const IconAndValueOnly: Story = {
  args: {
    icon: <Heart />,
    label: "Health",
    value: "Resting HR 72",
    testId: "home-card-minimal",
    ariaLabel: "Health: resting heart rate 72. Open health.",
  },
};

/**
 * The interaction contract: the whole card is a button, and tapping it (or
 * pressing Enter) fires `onActivate` — the single path that navigates to the
 * full surface. Driven for real and asserted, so a regression that detaches the
 * click handler fails the story.
 */
export const ActivatesOnClick: Story = {
  args: {
    icon: <TriangleAlert />,
    label: "Alerts",
    value: "Payment failed",
    badge: "1",
    tone: "danger",
    testId: "home-card-activate",
    ariaLabel: "Alerts: a payment failed. Open alerts.",
    onActivate: () => {
      activateCount += 1;
    },
  },
  play: async ({ canvasElement }) => {
    activateCount = 0;
    const card = canvasElement.querySelector(
      '[data-testid="home-card-activate"]',
    );
    // It is a real button carrying the full meaning for screen readers.
    assert(card instanceof HTMLButtonElement, "card is a <button>");
    assert(card.getAttribute("aria-label"), "card has an aria-label");
    card.click();
    assert(
      activateCount === 1,
      `click fired onActivate once (got ${activateCount})`,
    );
  },
};
