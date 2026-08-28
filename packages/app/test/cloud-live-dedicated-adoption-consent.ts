/**
 * Certifies the existing-Dedicated consent shown by the real renderer.
 *
 * The proof only observes the quote response already requested by the product
 * and clicks the visible confirmation control. It never calls a Cloud endpoint
 * itself, so the user's consent boundary remains the only way forward.
 */

import type { Locator, Page, Response } from "@playwright/test";

type DedicatedAdoptionStateDisposition =
  | "fresh_boot_no_verified_backup"
  | "verified_backup_present"
  | "unreviewed_existing_target";

interface VisibleDedicatedAdoptionQuote {
  status: string;
  startsCompute: boolean;
  hourlyRateUsd: number;
  dailyRateUsd: number;
  minimumBalanceUsd: number;
  minimumRunwayDays: number;
  balanceUsd: number;
  deficitUsd: number;
  stateDisposition: DedicatedAdoptionStateDisposition;
}

export interface DedicatedAdoptionConsentProof {
  confirmVisibleConsent(confirm: Locator): Promise<void>;
  dispose(): void;
}

class CloudLiveDedicatedAdoptionConsentProofError extends Error {
  readonly code = "CLOUD_LIVE_DEDICATED_ADOPTION_CONSENT_PROOF";

  constructor(readonly phase: "quote" | "copy" | "control") {
    super(`[cloud-live] Dedicated adoption consent ${phase} proof failed`);
    this.name = "CloudLiveDedicatedAdoptionConsentProofError";
  }
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function projectVisibleQuote(
  value: unknown,
): VisibleDedicatedAdoptionQuote | null {
  const root = recordOrNull(value);
  const quote = recordOrNull(root?.data);
  const status = typeof quote?.status === "string" ? quote.status.trim() : "";
  const hourlyRateUsd = finiteNumber(quote?.hourlyRateUsd);
  const dailyRateUsd = finiteNumber(quote?.dailyRateUsd);
  const minimumBalanceUsd = finiteNumber(quote?.minimumBalanceUsd);
  const minimumRunwayDays = finiteNumber(quote?.minimumRunwayDays);
  const balanceUsd = finiteNumber(quote?.balanceUsd);
  const deficitUsd = finiteNumber(quote?.deficitUsd);
  const stateDisposition = quote?.stateDisposition;
  if (
    root?.success !== true ||
    !status ||
    typeof quote?.startsCompute !== "boolean" ||
    hourlyRateUsd === null ||
    dailyRateUsd === null ||
    minimumBalanceUsd === null ||
    minimumRunwayDays === null ||
    balanceUsd === null ||
    deficitUsd === null ||
    (stateDisposition !== "fresh_boot_no_verified_backup" &&
      stateDisposition !== "verified_backup_present" &&
      stateDisposition !== "unreviewed_existing_target") ||
    quote?.requiresConfirmation !== true ||
    quote?.action !== "adopt_existing_dedicated"
  ) {
    return null;
  }
  return {
    status,
    startsCompute: quote.startsCompute,
    hourlyRateUsd,
    dailyRateUsd,
    minimumBalanceUsd,
    minimumRunwayDays,
    balanceUsd,
    deficitUsd,
    stateDisposition,
  };
}

function exactVisibleConsentLines(
  quote: VisibleDedicatedAdoptionQuote,
): string[] {
  const disposition =
    quote.stateDisposition === "verified_backup_present"
      ? "restore its reviewed backup"
      : quote.stateDisposition === "fresh_boot_no_verified_backup"
        ? "start fresh because no verified backup is available"
        : "keep its current state without a reviewed restore";
  return [
    "Use your existing Dedicated agent?",
    `Current status: ${quote.status}.`,
    `Hosting: $${quote.hourlyRateUsd.toFixed(2)}/hour ($${quote.dailyRateUsd.toFixed(2)}/day).`,
    `Balance: $${quote.balanceUsd.toFixed(2)}; minimum required: $${quote.minimumBalanceUsd.toFixed(2)} (${quote.minimumRunwayDays} days of runway); deficit: $${quote.deficitUsd.toFixed(2)}.`,
    `This action ${quote.startsCompute ? "starts Dedicated compute" : "does not start new compute"} and will ${disposition}.`,
  ];
}

function isDedicatedAdoptionQuoteResponse(response: Response): boolean {
  if (response.request().method() !== "GET" || response.status() !== 200) {
    return false;
  }
  try {
    return new URL(response.url()).pathname.endsWith(
      "/upgrade-tier/adopt-existing",
    );
  } catch {
    return false;
  }
}

/**
 * Observe the product's own quote request and certify the exact consent copy
 * before performing the same visible click a human uses.
 */
export function installDedicatedAdoptionConsentProof(
  page: Page,
): DedicatedAdoptionConsentProof {
  let latestQuoteAttempt: Promise<VisibleDedicatedAdoptionQuote | null> | null =
    null;
  let confirmationInFlight = false;
  const observeResponse = (response: Response): void => {
    if (!isDedicatedAdoptionQuoteResponse(response)) return;
    latestQuoteAttempt = response
      .json()
      .then(projectVisibleQuote)
      .catch(() => null);
  };
  page.on("response", observeResponse);

  return {
    async confirmVisibleConsent(confirm) {
      if (confirmationInFlight) return;
      confirmationInFlight = true;
      try {
        const quoteAttempt = latestQuoteAttempt;
        if (!quoteAttempt) {
          throw new CloudLiveDedicatedAdoptionConsentProofError("quote");
        }
        const quote = await quoteAttempt;
        if (!quote) {
          throw new CloudLiveDedicatedAdoptionConsentProofError("quote");
        }

        const consentTurn = confirm.locator(
          "xpath=ancestor::*[@data-testid='thread-line'][1]",
        );
        if (!(await consentTurn.isVisible())) {
          throw new CloudLiveDedicatedAdoptionConsentProofError("copy");
        }
        const copyMatches = await consentTurn.evaluate(
          (element, expectedLines) => {
            const normalize = (line: string) =>
              line.replace(/\s+/g, " ").trim();
            const visibleLines = (element as HTMLElement).innerText
              .split("\n")
              .map(normalize)
              .filter(Boolean);
            return expectedLines
              .map(normalize)
              .every((line) => visibleLines.includes(line));
          },
          exactVisibleConsentLines(quote),
        );
        if (!copyMatches) {
          throw new CloudLiveDedicatedAdoptionConsentProofError("copy");
        }
        const confirmationControlMatches = await confirm.evaluate(
          (element) =>
            (element as HTMLElement).innerText.replace(/\s+/g, " ").trim() ===
            "Confirm and continue",
        );
        if (!confirmationControlMatches || !(await confirm.isEnabled())) {
          throw new CloudLiveDedicatedAdoptionConsentProofError("control");
        }
        try {
          await confirm.click({ timeout: 15_000 });
        } catch {
          throw new CloudLiveDedicatedAdoptionConsentProofError("control");
        }
      } finally {
        confirmationInFlight = false;
      }
    },
    dispose() {
      page.off("response", observeResponse);
    },
  };
}
