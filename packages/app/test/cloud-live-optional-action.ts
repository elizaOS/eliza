/** Bounds optional Cloud onboarding actions without retaining DOM or account data. */

import type { Locator } from "@playwright/test";

export type CloudLiveOptionalActionPhase =
  | "pre-identity-runtime-choice"
  | "pre-identity-oauth-choice"
  | "personal-identity-retry"
  | "post-identity-tutorial-skip";

export type CloudLiveOptionalActionName =
  | "runtime-cloud"
  | "oauth-start"
  | "identity-retry"
  | "tutorial-skip";

export class CloudLiveOptionalActionDeadlineError extends Error {
  readonly code = "CLOUD_LIVE_OPTIONAL_ACTION_DEADLINE";

  constructor(
    readonly phase: CloudLiveOptionalActionPhase,
    readonly action: CloudLiveOptionalActionName,
  ) {
    super(`[cloud-live] ${phase} action deadline exceeded`);
    this.name = "CloudLiveOptionalActionDeadlineError";
  }
}

interface ClickCloudLiveOptionalActionOptions {
  phase: CloudLiveOptionalActionPhase;
  action: CloudLiveOptionalActionName;
  offerTimeoutMs: number;
  actionTimeoutMs: number;
}

interface PrepareCloudLivePersonalIdentityOptions {
  chooseRuntime: boolean;
  chatOverlay: Locator;
  chatOverlayTimeoutMs: number;
  chooseRuntimeAction: () => Promise<void>;
}

/**
 * The chat overlay is a pre-choice gate, not a post-choice invariant: a valid
 * Cloud choice may replace the first-run overlay while the account binding is
 * still resolving. Callers that already chose the runtime must proceed directly
 * to the bounded binding-or-retry predicate.
 */
export async function prepareCloudLivePersonalIdentity({
  chooseRuntime,
  chatOverlay,
  chatOverlayTimeoutMs,
  chooseRuntimeAction,
}: PrepareCloudLivePersonalIdentityOptions): Promise<void> {
  if (!chooseRuntime) return;
  await chatOverlay.waitFor({
    state: "visible",
    timeout: chatOverlayTimeoutMs,
  });
  await chooseRuntimeAction();
}

/**
 * Resolve the locator again while Playwright retries a detached/replaced node,
 * but never inherit the enclosing trajectory's multi-minute timeout. Absence is
 * an expected optional state; a continuously unstable offered action is a
 * closed, typed failure with no selector, text, URL, or DOM content attached.
 */
export async function clickCloudLiveOptionalAction(
  locator: Locator,
  options: ClickCloudLiveOptionalActionOptions,
): Promise<boolean> {
  const target = locator.first();
  const offered = await target
    .waitFor({ state: "visible", timeout: options.offerTimeoutMs })
    .then(
      () => true,
      // error-policy:J4 absence is the one expected optional-action failure.
      // Strict selector and browser failures remain fatal.
      (error: unknown) => {
        if (error instanceof Error && error.name === "TimeoutError") {
          return false;
        }
        throw error;
      },
    );
  if (!offered) return false;

  try {
    await target.click({ timeout: options.actionTimeoutMs });
  } catch (error) {
    // error-policy:J3 Playwright's timeout may contain private DOM/selector
    // context. Replace it with the closed phase/action classification only.
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new CloudLiveOptionalActionDeadlineError(
        options.phase,
        options.action,
      );
    }
    throw error;
  }
  return true;
}
