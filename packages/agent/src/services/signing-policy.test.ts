/**
 * Exercises the signing-policy evaluator through its public evaluate and record
 * APIs with a deterministic clock; no signer backend or private state is mocked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultPolicy,
  type SigningPolicy,
  SigningPolicyEvaluator,
  type SigningRequest,
} from "./signing-policy.ts";

function createRequest(
  overrides: Partial<SigningRequest> = {},
): SigningRequest {
  return {
    requestId: "request-1",
    chainId: 1,
    to: "0x0000000000000000000000000000000000000001",
    value: "0",
    data: "0x",
    createdAt: Date.now(),
    ...overrides,
  };
}

function createPolicy(overrides: Partial<SigningPolicy> = {}): SigningPolicy {
  return { ...createDefaultPolicy(), ...overrides };
}

describe("SigningPolicyEvaluator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a negative value before the request can be dispatched", () => {
    const evaluator = new SigningPolicyEvaluator();

    const decision = evaluator.evaluate(createRequest({ value: "-1" }));

    expect(decision).toMatchObject({
      allowed: false,
      requiresHumanConfirmation: false,
      matchedRule: "value_non_negative",
    });
  });

  it("continues to reject unparseable and over-cap values", () => {
    const evaluator = new SigningPolicyEvaluator(
      createPolicy({ maxTransactionValueWei: "5" }),
    );

    expect(
      evaluator.evaluate(createRequest({ value: "invalid" })).matchedRule,
    ).toBe("value_parse_error");
    expect(evaluator.evaluate(createRequest({ value: "6" })).matchedRule).toBe(
      "value_cap",
    );
  });

  it("allows canonical empty calldata when a selector allowlist is configured", () => {
    const evaluator = new SigningPolicyEvaluator(
      createPolicy({ allowedMethodSelectors: ["0x12345678"] }),
    );

    expect(evaluator.evaluate(createRequest({ data: "0x" })).allowed).toBe(
      true,
    );
  });

  it.each([
    "0x1",
    "0x1234",
    "0x1234567",
    "0x1234567g",
    "12345678",
    "0x123456789",
    "0x12345678zz",
  ])("rejects incomplete, odd-length, or non-hex calldata %s", (data) => {
    const evaluator = new SigningPolicyEvaluator(
      createPolicy({ allowedMethodSelectors: ["0x12345678"] }),
    );

    expect(evaluator.evaluate(createRequest({ data }))).toMatchObject({
      allowed: false,
      matchedRule: "method_selector_format",
    });
  });

  it("compares complete selectors case-insensitively", () => {
    const evaluator = new SigningPolicyEvaluator(
      createPolicy({ allowedMethodSelectors: ["0xAbCdEf12"] }),
    );

    expect(
      evaluator.evaluate(createRequest({ data: "0XaBcDeF1200" })).allowed,
    ).toBe(true);
    expect(
      evaluator.evaluate(createRequest({ data: "0xdeadbeef00" })),
    ).toMatchObject({
      allowed: false,
      matchedRule: "method_selector_allowlist",
    });
  });

  it("is immune to mutation of caller-held and returned policy arrays", () => {
    const input = createPolicy({ allowedMethodSelectors: ["0x12345678"] });
    const evaluator = new SigningPolicyEvaluator(input);

    input.deniedContracts.push("0x0000000000000000000000000000000000000001");
    evaluator.getPolicy().allowedMethodSelectors.length = 0;

    expect(
      evaluator.evaluate(createRequest({ data: "0x12345678" })),
    ).toMatchObject({ allowed: true, matchedRule: "allowed" });

    const update = createPolicy({ allowedMethodSelectors: ["0x12345678"] });
    evaluator.updatePolicy(update);
    update.allowedMethodSelectors[0] = "0xdeadbeef";

    expect(
      evaluator.evaluate(
        createRequest({ requestId: "request-2", data: "0x12345678" }),
      ),
    ).toMatchObject({ allowed: true, matchedRule: "allowed" });
  });

  it("enforces the hourly limit using only recorded public requests", () => {
    const now = Date.parse("2026-08-20T00:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const evaluator = new SigningPolicyEvaluator(
      createPolicy({
        maxTransactionsPerHour: 2,
        maxTransactionsPerDay: 10,
      }),
    );
    evaluator.recordRequest("recorded-1");
    evaluator.recordRequest("recorded-2");

    expect(
      evaluator.evaluate(createRequest({ requestId: "candidate" })),
    ).toMatchObject({
      allowed: false,
      matchedRule: "rate_limit_hourly",
    });
  });

  it("enforces the daily limit after hourly entries age out", () => {
    let now = Date.parse("2026-08-20T00:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const evaluator = new SigningPolicyEvaluator(
      createPolicy({
        maxTransactionsPerHour: 10,
        maxTransactionsPerDay: 2,
      }),
    );
    evaluator.recordRequest("recorded-1");
    now += 2 * 60 * 60 * 1000;
    evaluator.recordRequest("recorded-2");
    now += 2 * 60 * 60 * 1000;

    expect(
      evaluator.evaluate(createRequest({ requestId: "candidate" })),
    ).toMatchObject({
      allowed: false,
      matchedRule: "rate_limit_daily",
    });
  });

  it("prunes recorded entries after one day through evaluate", () => {
    let now = Date.parse("2026-08-20T00:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const evaluator = new SigningPolicyEvaluator(
      createPolicy({
        maxTransactionsPerHour: 1,
        maxTransactionsPerDay: 1,
      }),
    );
    evaluator.recordRequest("expired");
    now += 24 * 60 * 60 * 1000 + 1;

    expect(
      evaluator.evaluate(createRequest({ requestId: "candidate" })),
    ).toMatchObject({ allowed: true, matchedRule: "allowed" });
  });
});
