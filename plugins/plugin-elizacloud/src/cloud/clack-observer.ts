/**
 * `@clack/prompts`-backed implementation of `CloudOnboardingObserver`.
 *
 * Used by the CLI first-time-setup flow. Wraps a lazily-loaded clack module
 * (so packaged desktop builds that never run interactive onboarding don't
 * pay the dep cost) and renders every observer event as a spinner update,
 * `log.info` / `log.warn`, or `confirm` / `select` prompt.
 *
 * @module cloud/clack-observer
 */
import { logger } from "@elizaos/core";
import type {
  CloudOnboardingObserver,
  ConfirmPrompt,
  ProvisionSuccessInfo,
  SelectChoicePrompt,
} from "./onboarding-observer.js";

/** Lazy-loaded @clack/prompts module type. */
type ClackModule = typeof import("@clack/prompts");

interface ClackSpinner {
  start(message?: string): void;
  stop(message?: string): void;
  message(message?: string): void;
}

/**
 * Observer that drives a clack CLI session. One instance per onboarding run
 * — internal spinner state is reused across the auth + provisioning phases
 * so we don't stack overlapping spinners.
 */
export class ClackObserver implements CloudOnboardingObserver {
  private spinner: ClackSpinner | null = null;

  constructor(private readonly clack: ClackModule) {}

  // ── Spinner helpers ──────────────────────────────────────────────────
  private ensureSpinner(): ClackSpinner {
    if (!this.spinner) {
      this.spinner = this.clack.spinner();
    }
    return this.spinner;
  }

  private stopSpinner(message: string): void {
    if (this.spinner) {
      this.spinner.stop(message);
      this.spinner = null;
    } else {
      // No active spinner — render the line as a log.info so the
      // message isn't lost.
      this.clack.log.info(message);
    }
  }

  // ── Availability ─────────────────────────────────────────────────────
  onAvailabilityChecked(result: { ok: boolean; reason?: string }): void {
    if (!result.ok && result.reason) {
      this.clack.log.warn(result.reason);
    }
  }

  // ── Auth ─────────────────────────────────────────────────────────────
  onAuthStart(loginUrl: string): void {
    const spinner = this.ensureSpinner();
    spinner.start("Connecting to Eliza Cloud...");
    // The auth flow's first callback fires when we have the login URL.
    spinner.stop("Opening your browser to log in...");
    this.spinner = null;
    this.clack.log.info(`If the browser didn't open, visit:\n  ${loginUrl}`);
    const polling = this.ensureSpinner();
    polling.start("Waiting for login in browser...");
  }

  onAuthBrowserOpenFailed(loginUrl: string, error: Error): void {
    // Previously swallowed at debug-level. Now visible: the user may have
    // missed the URL printed by onAuthStart, so re-emit it here with the
    // explicit "couldn't open browser" framing.
    this.clack.log.warn(
      `Could not open browser automatically (${error.message}). Visit this URL to continue:\n  ${loginUrl}`,
    );
  }

  onAuthPollStatus(status: string): void {
    if (status === "pending") {
      this.ensureSpinner().message("Waiting for login in browser...");
    }
  }

  onAuthSuccess(): void {
    this.stopSpinner("✓ Logged in to Eliza Cloud!");
  }

  onAuthFailure(message: string): void {
    this.stopSpinner(message);
  }

  // ── Provisioning ─────────────────────────────────────────────────────
  onProvisionStart(_agentName: string): void {
    const spinner = this.ensureSpinner();
    spinner.start("Creating your cloud agent...");
  }

  onProvisionStatus(status: string): void {
    const spinner = this.ensureSpinner();
    switch (status) {
      case "created":
        spinner.message("Agent created! Provisioning cloud environment...");
        break;
      case "queued":
        spinner.message("Queued — waiting for available slot...");
        break;
      case "provisioning":
        spinner.message("Provisioning cloud environment...");
        break;
      default:
        spinner.message(`Status: ${status}...`);
    }
  }

  onProvisionTimeout(_agentId: string, lastStatus: string): void {
    this.stopSpinner(
      `Provisioning timed out (last status: ${lastStatus}). The agent may still be starting up.`,
    );
  }

  onProvisionFailure(reason: string): void {
    this.stopSpinner(reason);
  }

  onProvisionSuccess(result: ProvisionSuccessInfo): void {
    this.stopSpinner(`☁️  Cloud agent "${result.agentId}" is running!`);
  }

  // ── Generic ──────────────────────────────────────────────────────────
  onNotice(message: string): void {
    this.clack.log.warn(message);
  }

  onFatalError(error: Error, context: string): void {
    logger.error(`[cloud-onboarding] ${context}: ${error.message}`);
    this.clack.log.error(`${context}: ${error.message}`);
  }

  // ── Prompts ──────────────────────────────────────────────────────────
  async confirm(prompt: ConfirmPrompt): Promise<boolean | null> {
    const args: {
      message: string;
      initialValue?: boolean;
      active?: string;
      inactive?: string;
    } = { message: prompt.message };

    if (prompt.defaultValue !== undefined) args.initialValue = prompt.defaultValue;
    if (prompt.activeLabel !== undefined) args.active = prompt.activeLabel;
    if (prompt.inactiveLabel !== undefined) args.inactive = prompt.inactiveLabel;

    const result = await this.clack.confirm(args);
    if (this.clack.isCancel(result)) return null;
    return result;
  }

  async selectChoice<T extends string>(
    prompt: SelectChoicePrompt<T>,
  ): Promise<T | null> {
    // Clack's `Option<Value>` is a conditional type that for `Value extends
    // Primitive` makes `label` optional. TS can't narrow the conditional
    // for an unresolved generic `T extends string`, so we describe the
    // option shape via Parameters of clack's `select` and let inference
    // pick it up. No `as unknown as` escape — the parameter type IS the
    // right type, we just have to address it positionally.
    type SelectOpts = Parameters<typeof this.clack.select<T>>[0];
    const options = prompt.options.map((option) => {
      const out = {
        label: option.label,
        value: option.value,
        ...(option.hint !== undefined ? { hint: option.hint } : {}),
      };
      return out;
    }) as SelectOpts["options"];
    const result = await this.clack.select<T>({
      message: prompt.message,
      options,
    });
    if (this.clack.isCancel(result)) return null;
    return result;
  }
}
