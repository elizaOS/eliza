/**
 * Seals legacy auto-top-up charging while the durable processor is rolled out.
 */
import type { Organization } from "../../db/repositories";
import { autoTopUpAttemptsRepository, organizationsRepository } from "../../db/repositories";
import { logger } from "../utils/logger";

export const AUTO_TOP_UP_LIMITS = {
  MIN_AMOUNT: 1,
  MAX_AMOUNT: 1000,
  MIN_THRESHOLD: 0,
  MAX_THRESHOLD: 1000,
} as const;

/**
 * Thrown when an auto-top-up money-gate field read from a NUMERIC column
 * cannot be coerced to a finite number. Persisted corruption must fail closed.
 */
export class CorruptAutoTopUpNumberError extends Error {
  constructor(
    readonly field: string,
    readonly rawValue: unknown,
  ) {
    super(`Auto top-up ${field} is not a finite number: ${String(rawValue)}`);
    this.name = "CorruptAutoTopUpNumberError";
  }
}

/** Safe domain error for settings input that must be repaired explicitly. */
export class AutoTopUpSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoTopUpSettingsValidationError";
  }
}

export function parseAutoTopUpNumber(field: string, raw: unknown): number {
  if (raw === null || raw === undefined) {
    throw new CorruptAutoTopUpNumberError(field, raw);
  }
  if (typeof raw === "string" && raw.trim() === "") {
    throw new CorruptAutoTopUpNumberError(field, raw);
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    throw new CorruptAutoTopUpNumberError(field, raw);
  }
  return value;
}

function parseAutoTopUpNumberForSettingsRead(field: string, raw: unknown): number | null {
  // SQL NULL is the established unconfigured state exposed as 0 by this API.
  // Non-null malformed values are different: surface them honestly as null so
  // callers cannot mistake corruption for a configured monetary value.
  if (raw === null || raw === undefined) return 0;
  try {
    return parseAutoTopUpNumber(field, raw);
  } catch (error) {
    if (error instanceof CorruptAutoTopUpNumberError) return null;
    throw error;
  }
}

export interface AutoTopUpResult {
  organizationId: string;
  success: false;
  status: "cutover_paused";
  error: string;
}

export interface AutoTopUpCheckResult {
  timestamp: Date;
  cutoverPaused: true;
  controlMode: "paused" | "durable";
  organizationsChecked: 0;
  organizationsProcessed: 0;
  successful: 0;
  failed: 0;
  results: [];
}

const CUTOVER_PAUSED_MESSAGE =
  "Auto top-up charging is paused while the durable processor is rolled out";

/**
 * This release is deliberately unable to create a Stripe PaymentIntent.
 *
 * The database control row is still read so an unavailable authority fails
 * closed. Even when the row is moved to `durable`, this bridge binary remains
 * sealed: only the follow-up durable-processor release may start charging.
 */
export class AutoTopUpService {
  validateSettings(amount: number, threshold: number): void {
    if (!Number.isFinite(amount) || !Number.isFinite(threshold)) {
      throw new Error("Auto top-up settings must be valid numbers");
    }
    if (amount < AUTO_TOP_UP_LIMITS.MIN_AMOUNT) {
      throw new Error(`Auto top-up amount must be at least $${AUTO_TOP_UP_LIMITS.MIN_AMOUNT}`);
    }
    if (amount > AUTO_TOP_UP_LIMITS.MAX_AMOUNT) {
      throw new Error(`Auto top-up amount cannot exceed $${AUTO_TOP_UP_LIMITS.MAX_AMOUNT}`);
    }
    if (threshold < AUTO_TOP_UP_LIMITS.MIN_THRESHOLD) {
      throw new Error(
        `Auto top-up threshold must be at least $${AUTO_TOP_UP_LIMITS.MIN_THRESHOLD}`,
      );
    }
    if (threshold > AUTO_TOP_UP_LIMITS.MAX_THRESHOLD) {
      throw new Error(`Auto top-up threshold cannot exceed $${AUTO_TOP_UP_LIMITS.MAX_THRESHOLD}`);
    }
  }

  async checkAndExecuteAutoTopUps(): Promise<AutoTopUpCheckResult> {
    const control = await autoTopUpAttemptsRepository.getControl();
    logger.warn("[AutoTopUp] Charging sweep sealed during durable cutover", {
      controlMode: control.mode,
    });

    return {
      timestamp: new Date(),
      cutoverPaused: true,
      controlMode: control.mode,
      organizationsChecked: 0,
      organizationsProcessed: 0,
      successful: 0,
      failed: 0,
      results: [],
    };
  }

  async executeAutoTopUp(org: Organization): Promise<AutoTopUpResult> {
    return this.executeAutoTopUpForOrganization(org.id);
  }

  async executeAutoTopUpForOrganization(organizationId: string): Promise<AutoTopUpResult> {
    const control = await autoTopUpAttemptsRepository.getControl();
    logger.warn("[AutoTopUp] Charge request rejected by sealed cutover bridge", {
      organizationId,
      controlMode: control.mode,
    });

    return {
      organizationId,
      success: false,
      status: "cutover_paused",
      error: CUTOVER_PAUSED_MESSAGE,
    };
  }

  async getSettings(organizationId: string): Promise<{
    enabled: boolean;
    amount: number | null;
    threshold: number | null;
    hasPaymentMethod: boolean;
  }> {
    const organization = await organizationsRepository.findById(organizationId);
    if (!organization) {
      throw new Error("Organization not found");
    }

    return {
      enabled: organization.auto_top_up_enabled === true,
      amount: parseAutoTopUpNumberForSettingsRead(
        "auto_top_up_amount",
        organization.auto_top_up_amount,
      ),
      threshold: parseAutoTopUpNumberForSettingsRead(
        "auto_top_up_threshold",
        organization.auto_top_up_threshold,
      ),
      hasPaymentMethod: Boolean(organization.stripe_default_payment_method),
    };
  }

  async updateSettings(
    organizationId: string,
    settings: {
      enabled?: boolean;
      amount?: number;
      threshold?: number;
    },
  ): Promise<void> {
    const organization = await organizationsRepository.findById(organizationId);
    if (!organization) {
      throw new Error("Organization not found");
    }

    if (settings.enabled === true && !organization.stripe_default_payment_method) {
      throw new Error(
        "Cannot enable auto top-up without a default payment method. Please add a payment method first.",
      );
    }
    if (settings.enabled === true) {
      const [blockingAttempt, blockingLegacyPayment] = await Promise.all([
        autoTopUpAttemptsRepository.findBlockingByOrganization(organizationId),
        autoTopUpAttemptsRepository.findBlockingLegacyPaymentByOrganization(organizationId),
      ]);
      if (blockingAttempt || blockingLegacyPayment) {
        throw new Error(
          "Cannot enable auto top-up while an earlier card payment requires reconciliation.",
        );
      }
    }
    const mustValidateAmounts =
      settings.enabled === true ||
      settings.amount !== undefined ||
      settings.threshold !== undefined;
    if (mustValidateAmounts) {
      const persistedAmount = parseAutoTopUpNumberForSettingsRead(
        "auto_top_up_amount",
        organization.auto_top_up_amount,
      );
      const persistedThreshold = parseAutoTopUpNumberForSettingsRead(
        "auto_top_up_threshold",
        organization.auto_top_up_threshold,
      );
      if (
        (persistedAmount === null && settings.amount === undefined) ||
        (persistedThreshold === null && settings.threshold === undefined)
      ) {
        throw new AutoTopUpSettingsValidationError(
          "Valid auto top-up values are required to replace corrupt settings.",
        );
      }
      const amount = settings.amount ?? persistedAmount;
      const threshold = settings.threshold ?? persistedThreshold;
      if (amount === null || threshold === null) {
        throw new AutoTopUpSettingsValidationError(
          "Valid auto top-up values are required to replace corrupt settings.",
        );
      }
      this.validateSettings(amount, threshold);
    }

    const updates: Partial<Organization> = { updated_at: new Date() };
    if (settings.enabled !== undefined) updates.auto_top_up_enabled = settings.enabled;
    if (settings.amount !== undefined) updates.auto_top_up_amount = settings.amount.toFixed(2);
    if (settings.threshold !== undefined) {
      updates.auto_top_up_threshold = settings.threshold.toFixed(2);
    }
    if (
      settings.enabled === true &&
      settings.threshold === undefined &&
      (organization.auto_top_up_threshold === null ||
        organization.auto_top_up_threshold === undefined)
    ) {
      // Settings reads preserve the historical SQL NULL -> 0 contract. Persist
      // that normalized value when enabling so durable discovery and the locked
      // claim observe the same threshold instead of treating NULL as invalid.
      updates.auto_top_up_threshold = "0.00";
    }

    await organizationsRepository.update(organizationId, updates);
    logger.info("[AutoTopUp] Updated settings", {
      organizationId,
      enabled: settings.enabled,
      amount: settings.amount,
      threshold: settings.threshold,
    });
  }
}

export const autoTopUpService = new AutoTopUpService();
