// spec/cloud/returnPages.md, "Story: Tell a payer the checkout ended"
import type { ComponentMeta } from "vibestack/stories";
import type { CheckoutOutcomeProps } from "./CheckoutOutcome.tsx";

export const meta: ComponentMeta<CheckoutOutcomeProps> = {
  args: { deploymentName: "Example Cloud", outcome: "paid" },
  examples: { Canceled: { outcome: "canceled" } },
};
