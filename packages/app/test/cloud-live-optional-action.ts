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
