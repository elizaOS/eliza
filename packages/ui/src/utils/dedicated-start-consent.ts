/**
 * Owner consent for a paid Dedicated start. The Cloud API starts Dedicated
 * compute only for a request that carries the price the owner accepted, so
 * every in-app start shows the current price first and sends that acceptance.
 */
import {
  AGENT_PRICING,
  formatHourlyRate,
  formatUSD,
  getDedicatedComputePriceAcceptance,
} from "@elizaos/cloud-sdk/browser-contracts";
import { confirmDesktopAction } from "./desktop-dialogs";

/**
 * Show the current Dedicated price and return the acceptance value to send
 * with the start request, or null when the owner cancels.
 */
export async function confirmDedicatedComputeStart(
  agentLabel: string,
): Promise<string | null> {
  const confirmed = await confirmDesktopAction({
    title: "Start Dedicated agent",
    message: `Start ${agentLabel} on Dedicated compute?`,
    detail: [
      `Running costs ${formatHourlyRate(AGENT_PRICING.RUNNING_HOURLY_RATE)}. Starting requires at least ${formatUSD(AGENT_PRICING.MINIMUM_DEPOSIT)} in available funds.`,
      `Minimum charge per successful start: ${formatUSD(AGENT_PRICING.MINIMUM_ACTIVATION_CHARGE)}. Applies again after stopping and restarting.`,
      "Running charges count toward this minimum.",
    ].join("\n"),
    confirmLabel: "Start Dedicated",
    cancelLabel: "Cancel",
  });
  return confirmed ? getDedicatedComputePriceAcceptance() : null;
}
