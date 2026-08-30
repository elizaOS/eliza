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

export type CloudLivePersonalIdentityRecovery = "runtime-cloud" | "retry";

export type CloudLiveDedicatedConfirmationRequiredReason =
  | "approval-required"
  | "quote-changed"
  | "cancelled"
  | "interaction-failed";

export type CloudLiveDedicatedConfirmationKind =
  | "none"
  | "adoption"
  | "activation";

export interface CloudLiveDedicatedConsentEnvironment {
  ELIZA_UI_SMOKE_APPROVE_BILLABLE_DEDICATED_CONFIRMATION?: string;
  ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV?: string;
  GITHUB_EVENT_NAME?: string;
}

export interface CloudLiveDedicatedConsentSnapshot {
  approvalGrantedCount: 0 | 1;
  confirmationOfferCount: number;
  confirmationClickCount: number;
  cancellationCount: number;
}

export interface CloudLiveDedicatedConsentGate {
  claimVisibleConfirmation():
    | "approved"
    | "approval-required"
    | "quote-changed";
  recordConfirmationClick(
    kind: Exclude<CloudLiveDedicatedConfirmationKind, "none">,
  ): void;
  recordCancellation(): void;
  confirmedKind(): CloudLiveDedicatedConfirmationKind;
  snapshot(): CloudLiveDedicatedConsentSnapshot;
}

export class CloudLiveDedicatedConfirmationRequiredError extends Error {
  readonly code = "CLOUD_LIVE_DEDICATED_CONFIRMATION_REQUIRED";

  constructor(readonly reason: CloudLiveDedicatedConfirmationRequiredReason) {
    super(`[cloud-live] Dedicated confirmation required (${reason})`);
    this.name = "CloudLiveDedicatedConfirmationRequiredError";
  }
}

class CloudLiveDedicatedConsentGateImpl
  implements CloudLiveDedicatedConsentGate
{
  private confirmationOfferCount = 0;
  private confirmationClickCount = 0;
  private cancellationCount = 0;
  private approvalConsumed = false;
  private confirmationKind: CloudLiveDedicatedConfirmationKind = "none";

  constructor(private readonly approvalGranted: boolean) {}

  claimVisibleConfirmation():
    | "approved"
    | "approval-required"
    | "quote-changed" {
    this.confirmationOfferCount += 1;
    if (!this.approvalGranted) return "approval-required";
    if (this.approvalConsumed) return "quote-changed";
    // Reserve the one dispatch approval before the browser action. A detached
    // or timed-out node must never cause an automatic second attempt.
    this.approvalConsumed = true;
    return "approved";
  }

  recordConfirmationClick(
    kind: Exclude<CloudLiveDedicatedConfirmationKind, "none">,
  ): void {
    if (this.confirmationClickCount !== 0 || this.confirmationKind !== "none") {
      throw new Error(
        "[cloud-live] Dedicated confirmation click was already recorded",
      );
    }
    this.confirmationClickCount += 1;
    this.confirmationKind = kind;
  }

  recordCancellation(): void {
    this.cancellationCount += 1;
  }

  confirmedKind(): CloudLiveDedicatedConfirmationKind {
    return this.confirmationKind;
  }

  snapshot(): CloudLiveDedicatedConsentSnapshot {
    return {
      approvalGrantedCount: this.approvalGranted ? 1 : 0,
      confirmationOfferCount: this.confirmationOfferCount,
      confirmationClickCount: this.confirmationClickCount,
      cancellationCount: this.cancellationCount,
    };
  }
}

/**
 * A paid confirmation can only be enabled by a GitHub workflow_dispatch that
 * is already hard-pinned to staging. Scheduled, release, local, and production
 * lanes remain fail-closed even if somebody copies the opt-in variable.
 */
export function createCloudLiveDedicatedConsentGate(
  env: CloudLiveDedicatedConsentEnvironment,
): CloudLiveDedicatedConsentGate {
  const approvalRequested =
    env.ELIZA_UI_SMOKE_APPROVE_BILLABLE_DEDICATED_CONFIRMATION === "1";
  if (
    approvalRequested &&
    (env.ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV !== "staging" ||
      env.GITHUB_EVENT_NAME !== "workflow_dispatch")
  ) {
    throw new Error(
      "[cloud-live] Dedicated confirmation approval requires an explicit staging workflow dispatch",
    );
  }
  return new CloudLiveDedicatedConsentGateImpl(approvalRequested);
}

export class CloudLivePersonalIdentityRecoveryError extends Error {
  readonly code = "CLOUD_LIVE_PERSONAL_IDENTITY_RECOVERY";

  constructor(readonly recovery: CloudLivePersonalIdentityRecovery) {
    super(`[cloud-live] Personal identity surfaced ${recovery} recovery`);
    this.name = "CloudLivePersonalIdentityRecoveryError";
  }
}

export class CloudLivePersonalIdentityDeadlineError extends Error {
  readonly code = "CLOUD_LIVE_PERSONAL_IDENTITY_DEADLINE";

  constructor() {
    super("[cloud-live] Personal identity resolution deadline exceeded");
    this.name = "CloudLivePersonalIdentityDeadlineError";
  }
}

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

interface WaitForCloudLivePersonalIdentityOptions<T> {
  readBinding: () => Promise<T | null>;
  runtimeCloudRecovery: Locator;
  retryRecovery: Locator;
  dedicatedConsent?: {
    gate: CloudLiveDedicatedConsentGate;
    /** All activation/adoption confirm choices in DOM order. */
    confirmationChoices: Locator;
    /** All activation/adoption cancel choices in DOM order. */
    cancellationChoices: Locator;
    /** Performs the one approved rendered-UI interaction. */
    performConfirmation: (
      confirmation: Locator,
    ) => Promise<Exclude<CloudLiveDedicatedConfirmationKind, "none">>;
  };
  timeoutMs: number;
  runtimeCloudGraceMs: number;
  pollIntervalMs?: number;
  onRecovery?: (
    recovery: CloudLivePersonalIdentityRecovery,
  ) => void | Promise<void>;
}

async function withinCloudLivePersonalIdentityDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new CloudLivePersonalIdentityDeadlineError();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (Date.now() >= deadline) {
          throw new CloudLivePersonalIdentityDeadlineError();
        }
        return operation();
      }),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(
          () => reject(new CloudLivePersonalIdentityDeadlineError()),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function lastVisibleEnabledChoice(
  choices: Locator,
  deadline: number,
): Promise<Locator | null> {
  const count = await withinCloudLivePersonalIdentityDeadline(
    () => choices.count(),
    deadline,
  );
  for (let index = count - 1; index >= 0; index -= 1) {
    const choice = choices.nth(index);
    const visible = await withinCloudLivePersonalIdentityDeadline(
      () => choice.isVisible(),
      deadline,
    );
    if (!visible) continue;
    const enabled = await withinCloudLivePersonalIdentityDeadline(
      () => choice.isEnabled(),
      deadline,
    );
    if (enabled) return choice;
  }
  return null;
}

async function hasSelectedCancellation(
  choices: Locator,
  deadline: number,
): Promise<boolean> {
  const count = await withinCloudLivePersonalIdentityDeadline(
    () => choices.count(),
    deadline,
  );
  for (let index = count - 1; index >= 0; index -= 1) {
    const choice = choices.nth(index);
    const visible = await withinCloudLivePersonalIdentityDeadline(
      () => choice.isVisible(),
      deadline,
    );
    if (!visible) continue;
    const pressed = await withinCloudLivePersonalIdentityDeadline(
      () => choice.getAttribute("aria-pressed"),
      deadline,
    );
    // Confirmation and cancellation buttons are emitted as one current pair.
    // Once the newest visible cancellation is found, older transcript turns
    // must not influence the current quote.
    return pressed === "true";
  }
  return false;
}

/**
 * Wait once for a real persisted binding. A recovery choice is an adjudicated
 * failure, never permission to replay an activation POST. Runtime Cloud is
 * eligible only after the initial choice disappeared or a short render grace
 * elapsed, so the just-clicked first-run button is not misclassified.
 */
export async function waitForCloudLivePersonalIdentity<T>({
  readBinding,
  runtimeCloudRecovery,
  retryRecovery,
  dedicatedConsent,
  timeoutMs,
  runtimeCloudGraceMs,
  pollIntervalMs = 250,
  onRecovery,
}: WaitForCloudLivePersonalIdentityOptions<T>): Promise<T> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let runtimeCloudWasAbsent = false;
  for (;;) {
    const binding = await withinCloudLivePersonalIdentityDeadline(
      readBinding,
      deadline,
    );
    if (binding) return binding;

    if (dedicatedConsent) {
      const confirmation = await lastVisibleEnabledChoice(
        dedicatedConsent.confirmationChoices,
        deadline,
      );
      if (confirmation) {
        const decision = dedicatedConsent.gate.claimVisibleConfirmation();
        if (decision !== "approved") {
          throw new CloudLiveDedicatedConfirmationRequiredError(decision);
        }
        try {
          const confirmationKind =
            await withinCloudLivePersonalIdentityDeadline(
              () => dedicatedConsent.performConfirmation(confirmation),
              deadline,
            );
          if (
            confirmationKind !== "adoption" &&
            confirmationKind !== "activation"
          ) {
            throw new Error(
              "[cloud-live] Dedicated confirmation kind was not recognized",
            );
          }
          dedicatedConsent.gate.recordConfirmationClick(confirmationKind);
        } catch (error) {
          if (error instanceof CloudLivePersonalIdentityDeadlineError) {
            throw error;
          }
          // Playwright failures can contain rendered quote text and selector
          // detail. Replace them with one closed classification.
          throw new CloudLiveDedicatedConfirmationRequiredError(
            "interaction-failed",
          );
        }
        continue;
      }

      // A newly rendered enabled quote supersedes an older cancelled transcript
      // turn, so cancellation is checked only after no current confirmation is
      // actionable. On the current turn both buttons lock after cancellation.
      const cancelled = await hasSelectedCancellation(
        dedicatedConsent.cancellationChoices,
        deadline,
      );
      if (cancelled) {
        dedicatedConsent.gate.recordCancellation();
        throw new CloudLiveDedicatedConfirmationRequiredError("cancelled");
      }
    }

    const retryVisible = await withinCloudLivePersonalIdentityDeadline(
      () => retryRecovery.isVisible(),
      deadline,
    );
    const runtimeCloudVisible = await withinCloudLivePersonalIdentityDeadline(
      () => runtimeCloudRecovery.isVisible(),
      deadline,
    );
    if (!runtimeCloudVisible) runtimeCloudWasAbsent = true;
    const recovery: CloudLivePersonalIdentityRecovery | null = retryVisible
      ? "retry"
      : runtimeCloudVisible &&
          (runtimeCloudWasAbsent ||
            Date.now() - startedAt >= runtimeCloudGraceMs)
        ? "runtime-cloud"
        : null;
    if (recovery) {
      try {
        if (onRecovery) {
          await withinCloudLivePersonalIdentityDeadline(
            () => Promise.resolve(onRecovery(recovery)),
            deadline,
          );
        }
      } catch (error) {
        if (error instanceof CloudLivePersonalIdentityDeadlineError) {
          throw error;
        }
        // error-policy:J7 recovery evidence is secondary to the typed live
        // identity failure. Report only a fixed, payload-free warning and
        // preserve the original recovery classification below.
        console.warn(
          "[cloud-live] Personal identity recovery diagnostic unavailable",
        );
      }
      throw new CloudLivePersonalIdentityRecoveryError(recovery);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new CloudLivePersonalIdentityDeadlineError();
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)),
    );
  }
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
