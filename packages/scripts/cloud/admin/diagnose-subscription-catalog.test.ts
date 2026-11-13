import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendTailOutput,
  catalogCodes,
  checkoutTailSummary,
} from "./diagnose-subscription-catalog.ts";

const url = "https://api-staging.eliza.app/api/v1/subscriptions/plans";
const code = "SUBSCRIPTION_CATALOG_BINDING_INVALID";
function event(
  requestUrl = url,
  method = "GET",
  message = "[SubscriptionPlansAPI] Catalog unavailable",
  errorCode = code,
) {
  return JSON.stringify(
    {
      event: { request: { url: requestUrl, method } },
      logs: [
        {
          message: [
            message,
            { code: errorCode, providerValue: "must-not-escape" },
          ],
        },
      ],
    },
    null,
    4,
  );
}

describe("catalog diagnostic redaction", () => {
  test("accepts multiple pinned Wrangler pretty JSON events and returns only known codes", () => {
    expect(
      catalogCodes(
        [
          event(),
          event(),
          event(
            url,
            "GET",
            "[SubscriptionPlansAPI] Catalog unavailable",
            "SUBSCRIPTION_CATALOG_PROVIDER_DRIFT",
          ),
        ].join("\n"),
        url,
      ),
    ).toEqual([code, "SUBSCRIPTION_CATALOG_PROVIDER_DRIFT"]);
  });
  test("rejects wrong URL, method and unrelated log messages", () => {
    expect(
      catalogCodes(
        [
          event(`${url}/other`),
          event(url, "POST"),
          event(url, "GET", "unrelated provider error"),
        ].join("\n"),
        url,
      ),
    ).toEqual([]);
  });
  test("discards unknown codes, known-code prefixes and malformed output", () => {
    expect(
      catalogCodes(
        event(
          url,
          "GET",
          "[SubscriptionPlansAPI] Catalog unavailable",
          `${code}_PRIVATE`,
        ),
        url,
      ),
    ).toEqual([]);
    expect(catalogCodes("not JSON must-not-escape", url)).toEqual([]);
  });
  test("bounds capture by bytes and rejects oversized chunks without returning content", () => {
    expect(appendTailOutput("", Buffer.from("safe"))).toBe("safe");
    expect(() => appendTailOutput("", Buffer.alloc(1048577))).toThrow(
      "catalog_tail_limit",
    );
    expect(() =>
      appendTailOutput("é".repeat(524288), Buffer.from("x")),
    ).toThrow("catalog_tail_limit");
  });
});

describe("checkout diagnostic redaction", () => {
  const checkoutUrl =
    "https://api-staging.eliza.app/api/v1/subscriptions/checkout/confirm";
  const record = (
    message: unknown[],
    requestUrl = checkoutUrl,
    method = "POST",
  ) =>
    JSON.stringify(
      {
        event: {
          request: {
            url: requestUrl,
            method,
            headers: { authorization: "private-header" },
          },
          response: { status: 500 },
        },
        logs: [{ message }],
        exceptions: [{ message: "private-exception", name: "private-name" }],
      },
      null,
      4,
    );

  test("keeps only fixed failure identifiers from the exact checkout request", () => {
    const details = {
      phase: "reconciliation",
      name: "SubscriptionCatalogError",
      code: "SUBSCRIPTION_CATALOG_STRIPE_KEY_INVALID",
      message: "private-error",
      context: { id: "private-id" },
      cause: {
        name: "DatabaseError",
        sqlstate: "23514",
        constraint: "billing_subscriptions_app_shape",
        query: "private-query",
      },
    };
    const raw = [
      record(["[SubscriptionCheckoutConfirm] Failed", details]),
      record([
        "[InferencePolicyCall] Failed",
        JSON.stringify({
          phase: "response",
          path: "/policy-fence/begin",
          httpStatus: 503,
          body: "private-body",
        }),
      ]),
      record([
        "[InferencePolicyCall] Failed",
        { phase: "decode", path: "/policy-fence/begin", httpStatus: 200 },
      ]),
      record(["[Stripe Queue] Error", { error: "private-error" }]),
      record(
        ["[SubscriptionCheckoutConfirm] Failed", details],
        `${checkoutUrl}?private-query`,
      ),
      record(
        ["[SubscriptionCheckoutConfirm] Failed", details],
        checkoutUrl,
        "GET",
      ),
    ].join("\n");
    const result = checkoutTailSummary(raw, checkoutUrl);
    expect(result).toEqual({
      requests: 4,
      httpStatuses: { "500": 4 },
      failures: [
        {
          kind: "checkout",
          phase: "reconciliation",
          name: "SubscriptionCatalogError",
          code: "SUBSCRIPTION_CATALOG_STRIPE_KEY_INVALID",
          cause: {
            name: "DatabaseError",
            sqlstate: "23514",
            constraint: "billing_subscriptions_app_shape",
          },
        },
        {
          kind: "policy",
          phase: "response",
          path: "/policy-fence/begin",
          httpStatus: 503,
        },
        {
          kind: "policy",
          phase: "decode",
          path: "/policy-fence/begin",
          httpStatus: 200,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  test("unknown fields, identifiers and phases never become diagnostic output", () => {
    const raw = [
      record([
        "[SubscriptionCheckoutConfirm] Failed",
        {
          phase: "reconciliation",
          name: "private-name",
          code: "private_code",
          constraint: "private_constraint",
          sqlstate: "private-state",
        },
      ]),
      record([
        "[SubscriptionCheckoutConfirm] Failed",
        { phase: "private-phase", name: "Error" },
      ]),
      record([
        "[InferencePolicyCall] Failed",
        { phase: "response", path: "/private-path", httpStatus: 500 },
      ]),
      record([
        "[InferencePolicyCall] Failed",
        { phase: "transport", path: "/policy-fence/abort", httpStatus: null },
      ]),
    ].join("\n");
    expect(checkoutTailSummary(raw, checkoutUrl)).toEqual({
      requests: 4,
      httpStatuses: { "500": 4 },
      failures: [
        { kind: "checkout", phase: "reconciliation", name: "unknown" },
        {
          kind: "policy",
          phase: "transport",
          path: "/policy-fence/abort",
          httpStatus: null,
        },
      ],
    });
  });

  test("tail CLI rejects production and non-staging refs before opening a provider stream", () => {
    for (const [environment, ref] of [
      ["production", "refs/heads/main"],
      ["staging", "refs/heads/develop"],
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          "packages/scripts/cloud/admin/diagnose-subscription-catalog.ts",
          "--checkout-tail",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            ELIZA_OPERATOR_ENVIRONMENT: environment,
            GITHUB_REF: ref,
          },
          timeout: 10000,
        },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe("subscription_diagnostic_failed");
    }
  });
});
