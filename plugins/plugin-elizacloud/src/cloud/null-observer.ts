/**
 * No-op `CloudOnboardingObserver` for tests and headless runs.
 *
 * - All event methods are no-ops.
 * - All prompt methods resolve to `null` (i.e. "user cancelled"), which
 *   lets the orchestrator exercise its cancel branches without surfacing
 *   any UI.
 *
 * Tests that want to assert observer calls should use a capturing
 * observer instead.
 *
 * @module cloud/null-observer
 */
import type {
  CloudOnboardingObserver,
  ConfirmPrompt,
  ProvisionSuccessInfo,
  SelectChoicePrompt,
} from "./onboarding-observer.js";

export class NullCloudOnboardingObserver implements CloudOnboardingObserver {
  onAvailabilityChecked(_result: { ok: boolean; reason?: string }): void {}
  onAuthStart(_loginUrl: string): void {}
  onAuthBrowserOpenFailed(_loginUrl: string, _error: Error): void {}
  onAuthPollStatus(_status: string): void {}
  onAuthSuccess(): void {}
  onAuthFailure(_message: string): void {}
  onProvisionStart(_agentName: string): void {}
  onProvisionStatus(_status: string): void {}
  onProvisionTimeout(_agentId: string, _lastStatus: string): void {}
  onProvisionFailure(_reason: string): void {}
  onProvisionSuccess(_result: ProvisionSuccessInfo): void {}
  onNotice(_message: string): void {}
  onFatalError(_error: Error, _context: string): void {}

  async confirm(_prompt: ConfirmPrompt): Promise<boolean | null> {
    return null;
  }

  async selectChoice<T extends string>(
    _prompt: SelectChoicePrompt<T>,
  ): Promise<T | null> {
    return null;
  }
}
