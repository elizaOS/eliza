import { describe, expect, test } from "bun:test";
import {
  appendTailOutput,
  catalogCodes,
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
