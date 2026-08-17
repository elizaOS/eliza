/**
 * Proves the cutover bridge cannot create charges before the durable processor ships.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const getControl = mock();
const findBlockingByOrganization = mock();
const findBlockingLegacyPaymentByOrganization = mock();
const findOrganizationById = mock();
const updateOrganization = mock();

mock.module("../../../db/repositories", () => ({
  autoTopUpAttemptsRepository: {
    getControl,
    findBlockingByOrganization,
    findBlockingLegacyPaymentByOrganization,
  },
  organizationsRepository: {
    findById: findOrganizationById,
    update: updateOrganization,
  },
}));

const requireStripe = mock(() => {
  throw new Error("Stripe must not be loaded by the sealed cutover bridge");
});

mock.module("../../stripe", () => ({ requireStripe }));

mock.module("../../utils/logger", () => ({
  logger: {
    debug: mock(),
    error: mock(),
    info: mock(),
    warn: mock(),
  },
}));

const { AutoTopUpService, CorruptAutoTopUpNumberError, parseAutoTopUpNumber } = await import(
  "../auto-top-up"
);

type AutoTopUpOrganization = Parameters<AutoTopUpService["executeAutoTopUp"]>[0];

function makeOrganization(overrides: Partial<AutoTopUpOrganization> = {}): AutoTopUpOrganization {
  return {
    id: "org-1",
    name: "Acme Cloud",
    auto_top_up_enabled: true,
    auto_top_up_amount: "10.00",
    auto_top_up_threshold: "5.00",
    stripe_default_payment_method: "pm_123",
    ...overrides,
  } as AutoTopUpOrganization;
}

beforeEach(() => {
  getControl.mockReset();
  getControl.mockResolvedValue({
    mode: "paused",
    pausedAt: new Date("2026-08-17T00:00:00.000Z"),
    legacyReconciledThrough: null,
  });
  findBlockingByOrganization.mockReset();
  findBlockingByOrganization.mockResolvedValue(null);
  findBlockingLegacyPaymentByOrganization.mockReset();
  findBlockingLegacyPaymentByOrganization.mockResolvedValue(null);
  findOrganizationById.mockReset();
  findOrganizationById.mockResolvedValue(makeOrganization());
  updateOrganization.mockReset();
  updateOrganization.mockResolvedValue(makeOrganization());
  requireStripe.mockClear();
});

describe("AutoTopUpService sealed cutover bridge", () => {
  test("rejects a direct organization charge while control is paused", async () => {
    const result = await new AutoTopUpService().executeAutoTopUp(makeOrganization());

    expect(result).toEqual({
      organizationId: "org-1",
      success: false,
      status: "cutover_paused",
      error: "Auto top-up charging is paused while the durable processor is rolled out",
    });
    expect(requireStripe).not.toHaveBeenCalled();
  });

  test("stays sealed even if control is moved to durable before the processor binary ships", async () => {
    getControl.mockResolvedValue({
      mode: "durable",
      pausedAt: new Date("2026-08-17T00:00:00.000Z"),
      legacyReconciledThrough: new Date("2026-08-17T00:05:00.000Z"),
    });

    const result = await new AutoTopUpService().executeAutoTopUpForOrganization("org-2");

    expect(result.status).toBe("cutover_paused");
    expect(result.success).toBe(false);
    expect(requireStripe).not.toHaveBeenCalled();
  });

  test("returns an explicit zero-work cron result", async () => {
    const result = await new AutoTopUpService().checkAndExecuteAutoTopUps();

    expect(result).toEqual({
      timestamp: expect.any(Date),
      cutoverPaused: true,
      controlMode: "paused",
      organizationsChecked: 0,
      organizationsProcessed: 0,
      successful: 0,
      failed: 0,
      results: [],
    });
    expect(requireStripe).not.toHaveBeenCalled();
  });

  test("fails closed when the database control authority is unavailable", async () => {
    getControl.mockRejectedValue(new Error("control unavailable"));

    await expect(new AutoTopUpService().executeAutoTopUpForOrganization("org-1")).rejects.toThrow(
      "control unavailable",
    );
    expect(requireStripe).not.toHaveBeenCalled();
  });
});

describe("parseAutoTopUpNumber", () => {
  test("parses finite numeric strings and numbers", () => {
    expect(parseAutoTopUpNumber("auto_top_up_amount", "10.00")).toBe(10);
    expect(parseAutoTopUpNumber("markup_percent", 5)).toBe(5);
    expect(parseAutoTopUpNumber("markup_percent", "0")).toBe(0);
  });

  test("rejects missing, blank, non-numeric, and non-finite values", () => {
    for (const value of [null, undefined, "", "   ", "abc", Number.POSITIVE_INFINITY]) {
      expect(() => parseAutoTopUpNumber("auto_top_up_amount", value)).toThrow(
        CorruptAutoTopUpNumberError,
      );
    }
  });
});

describe("AutoTopUpService.validateSettings", () => {
  const service = new AutoTopUpService();

  test("accepts boundary values", () => {
    expect(() => service.validateSettings(1, 0)).not.toThrow();
    expect(() => service.validateSettings(1000, 1000)).not.toThrow();
  });

  test("rejects invalid and non-finite settings", () => {
    expect(() => service.validateSettings(0, 5)).toThrow("at least $1");
    expect(() => service.validateSettings(1001, 5)).toThrow("cannot exceed $1000");
    expect(() => service.validateSettings(10, -1)).toThrow("threshold must be at least $0");
    expect(() => service.validateSettings(10, 1001)).toThrow("threshold cannot exceed $1000");
    expect(() => service.validateSettings(Number.NaN, 5)).toThrow("must be valid numbers");
  });
});

describe("AutoTopUpService settings compatibility", () => {
  test("reads the existing billing settings without unsealing charging", async () => {
    const result = await new AutoTopUpService().getSettings("org-1");

    expect(result).toEqual({
      enabled: true,
      amount: 10,
      threshold: 5,
      hasPaymentMethod: true,
    });
    expect(requireStripe).not.toHaveBeenCalled();
  });

  test("preserves zero defaults for normally unconfigured settings", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_enabled: false,
        auto_top_up_amount: null,
        auto_top_up_threshold: null,
      }),
    );

    await expect(new AutoTopUpService().getSettings("org-1")).resolves.toEqual({
      enabled: false,
      amount: 0,
      threshold: 0,
      hasPaymentMethod: true,
    });
  });

  test("reports genuinely corrupt disabled settings as null without fabricating values", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_enabled: false,
        auto_top_up_amount: "NaN",
        auto_top_up_threshold: "not-a-number",
      }),
    );

    await expect(new AutoTopUpService().getSettings("org-1")).resolves.toEqual({
      enabled: false,
      amount: null,
      threshold: null,
      hasPaymentMethod: true,
    });
  });

  test("persists validated decimal settings", async () => {
    await new AutoTopUpService().updateSettings("org-1", {
      enabled: true,
      amount: 25,
      threshold: 10,
    });

    expect(updateOrganization).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        auto_top_up_enabled: true,
        auto_top_up_amount: "25.00",
        auto_top_up_threshold: "10.00",
        updated_at: expect.any(Date),
      }),
    );
    expect(requireStripe).not.toHaveBeenCalled();
  });

  test("rejects enabling without a payment method", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({ stripe_default_payment_method: null }),
    );

    await expect(new AutoTopUpService().updateSettings("org-1", { enabled: true })).rejects.toThrow(
      "Cannot enable auto top-up without a default payment method",
    );
    expect(updateOrganization).not.toHaveBeenCalled();
  });

  test("rejects re-enabling while an earlier provider payment requires reconciliation", async () => {
    findBlockingLegacyPaymentByOrganization.mockResolvedValueOnce({
      id: "legacy-review-1",
      status: "manual_review",
    });

    await expect(new AutoTopUpService().updateSettings("org-1", { enabled: true })).rejects.toThrow(
      "Cannot enable auto top-up while an earlier card payment requires reconciliation",
    );
    expect(updateOrganization).not.toHaveBeenCalled();
  });

  test("rejects re-enabling while a durable attempt requires manual review", async () => {
    findBlockingByOrganization.mockResolvedValueOnce({
      id: "durable-review-1",
      status: "manual_review",
    });

    await expect(new AutoTopUpService().updateSettings("org-1", { enabled: true })).rejects.toThrow(
      "Cannot enable auto top-up while an earlier card payment requires reconciliation",
    );
    expect(updateOrganization).not.toHaveBeenCalled();
  });

  test("requires an explicit value for every corrupt setting when enabling", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_enabled: false,
        auto_top_up_amount: "NaN",
        auto_top_up_threshold: "not-a-number",
      }),
    );

    await expect(
      new AutoTopUpService().updateSettings("org-1", { enabled: true, amount: 25 }),
    ).rejects.toThrow("Valid auto top-up values are required to replace corrupt settings");
    expect(updateOrganization).not.toHaveBeenCalled();
  });

  test("repairs only a corrupt amount while reusing a valid persisted threshold", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_enabled: false,
        auto_top_up_amount: "NaN",
        auto_top_up_threshold: "8.00",
      }),
    );

    await new AutoTopUpService().updateSettings("org-1", {
      enabled: true,
      amount: 25,
    });

    expect(updateOrganization).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        auto_top_up_enabled: true,
        auto_top_up_amount: "25.00",
      }),
    );
    expect(updateOrganization.mock.calls[0]?.[1]).not.toHaveProperty("auto_top_up_threshold");
  });

  test("repairs only a corrupt threshold while reusing a valid persisted amount", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_enabled: false,
        auto_top_up_amount: "25.00",
        auto_top_up_threshold: "not-a-number",
      }),
    );

    await new AutoTopUpService().updateSettings("org-1", {
      enabled: true,
      threshold: 8,
    });

    expect(updateOrganization).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        auto_top_up_enabled: true,
        auto_top_up_threshold: "8.00",
      }),
    );
    expect(updateOrganization.mock.calls[0]?.[1]).not.toHaveProperty("auto_top_up_amount");
  });

  test("repairs corrupt settings when enabling with explicit valid values", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_enabled: false,
        auto_top_up_amount: "NaN",
        auto_top_up_threshold: "not-a-number",
      }),
    );

    await new AutoTopUpService().updateSettings("org-1", {
      enabled: true,
      amount: 25,
      threshold: 10,
    });

    expect(updateOrganization).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        auto_top_up_enabled: true,
        auto_top_up_amount: "25.00",
        auto_top_up_threshold: "10.00",
      }),
    );
  });

  test("rejects enabling normally unconfigured settings through safe range validation", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_enabled: false,
        auto_top_up_amount: null,
        auto_top_up_threshold: null,
      }),
    );

    await expect(new AutoTopUpService().updateSettings("org-1", { enabled: true })).rejects.toThrow(
      "Auto top-up amount must be at least $1",
    );
    expect(updateOrganization).not.toHaveBeenCalled();
  });

  test("persists the legacy zero threshold when enabling from SQL NULL", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_enabled: false,
        auto_top_up_amount: "10.00",
        auto_top_up_threshold: null,
      }),
    );

    await new AutoTopUpService().updateSettings("org-1", { enabled: true });

    expect(updateOrganization).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        auto_top_up_enabled: true,
        auto_top_up_threshold: "0.00",
      }),
    );
  });

  test("uses the legacy zero fallback for a partial update on unconfigured settings", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_enabled: false,
        auto_top_up_amount: null,
        auto_top_up_threshold: null,
      }),
    );

    await new AutoTopUpService().updateSettings("org-1", { amount: 10 });

    expect(updateOrganization).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ auto_top_up_amount: "10.00" }),
    );
  });

  test("rejects a partial update whose missing counterpart is corrupt", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_enabled: false,
        auto_top_up_amount: "10.00",
        auto_top_up_threshold: "not-a-number",
      }),
    );

    await expect(new AutoTopUpService().updateSettings("org-1", { amount: 25 })).rejects.toThrow(
      "Valid auto top-up values are required to replace corrupt settings",
    );
    expect(updateOrganization).not.toHaveBeenCalled();
  });

  test("allows fail-closed disable even when persisted amount fields are corrupt", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_amount: "NaN",
        auto_top_up_threshold: "not-a-number",
      }),
    );

    await new AutoTopUpService().updateSettings("org-1", { enabled: false });

    expect(updateOrganization).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ auto_top_up_enabled: false }),
    );
  });
});
