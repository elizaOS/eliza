/**
 * Workspace package `@elizaos/billing` — ambient types when the package is
 * not linked in the current install graph. Mirrors `packages/services/billing`.
 */
declare module "@elizaos/billing" {
  export interface MarkupBreakdown {
    rawCost: number;
    markup: number;
    billedCost: number;
    markupRate: number;
  }

  export interface TwilioSmsBillingBreakdown extends MarkupBreakdown {
    segments: number;
    costPerSegment: number;
  }

  export function applyMarkup(cost: number, markupRate?: number): MarkupBreakdown;

  export function calculateTwilioSmsBilling(
    body: string,
    costPerSegment: number,
    markupRate?: number,
  ): TwilioSmsBillingBreakdown;
}
