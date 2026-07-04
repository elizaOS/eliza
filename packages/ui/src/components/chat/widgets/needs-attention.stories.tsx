/**
 * Storybook states for the Needs Attention chat widget across populated,
 * empty, and interaction-focused render states.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { CHAT_PREFILL_EVENT } from "../../../events";
import {
  assert,
  waitForTestId,
  withSeededHomeWidget,
} from "../../../storybook/home-widget-decorator";
import { NeedsAttentionWidget } from "./needs-attention";

// The canonical "actions requiring your response" home card (#9449): shows the
// ONE oldest pending decision the agent is blocked on, with a count badge, and
// self-hides when nothing is pending. Seeded with the shared home-widget mock
// data (GET /api/approvals -> { pending: PendingUserAction[] }).

const meta = {
  title: "Shell/Home Widgets/Needs Attention",
  component: NeedsAttentionWidget,
  parameters: { layout: "centered" },
  decorators: [withSeededHomeWidget],
  args: { slot: "home" },
} satisfies Meta<typeof NeedsAttentionWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The oldest pending decision is the single datum; the mock's oldest is stale. */
export const NeedsAttention: Story = {
  play: async ({ canvasElement }) => {
    const card = await waitForTestId(
      canvasElement,
      "chat-widget-needs-attention",
    );
    assert(card instanceof HTMLButtonElement, "the whole card is a button");
    assert(
      /need your response/i.test(card.getAttribute("aria-label") ?? ""),
      "the aria-label carries the needs-response meaning",
    );
    assert(
      (card.getAttribute("aria-label") ?? "").includes(
        "Send the signed contract to Acme",
      ),
      "shows the OLDEST pending decision as the datum",
    );
  },
};

/**
 * Clicking the card routes back to the handler: it prefills the floating chat
 * composer with an approval message so the agent's RESOLVE_REQUEST action
 * resolves it — the single tap-to-resolve contract for this surface.
 */
export const ClickPrefillsChat: Story = {
  play: async ({ canvasElement }) => {
    const card = await waitForTestId(
      canvasElement,
      "chat-widget-needs-attention",
    );
    const prefilled: string[] = [];
    const onPrefill = (e: Event) => {
      const detail = (e as CustomEvent<{ text?: string }>).detail;
      if (detail?.text) prefilled.push(detail.text);
    };
    window.addEventListener(CHAT_PREFILL_EVENT, onPrefill);
    card.click();
    window.removeEventListener(CHAT_PREFILL_EVENT, onPrefill);
    assert(
      prefilled.some((text) => text.startsWith("Approve:")),
      `click prefills an approval (saw ${prefilled.join(",") || "nothing"})`,
    );
  },
};
