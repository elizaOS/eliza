/** Renders confirmed quote fields; the Cloud service owns pricing and readiness. */
import type {
  DedicatedActivationConfirmationQuote,
  DedicatedAdoptionConfirmationQuote,
} from "@elizaos/ui";

export function dedicatedHostingReadinessText(
  quote:
    | DedicatedActivationConfirmationQuote
    | DedicatedAdoptionConfirmationQuote,
): string[] {
  return [
    ...(quote.action === "adopt_existing_dedicated"
      ? [`Current status: ${quote.status.replaceAll(/[_-]+/g, " ")}.`]
      : []),
    `The required balance covers ${quote.minimumRunwayDays} days of hosting.`,
    quote.action === "activate_dedicated" || quote.startsCompute
      ? "Confirming starts Dedicated compute."
      : "Confirming does not start new Dedicated compute.",
  ];
}
