import { describe, expect, test } from "bun:test";
import { isPublicPath } from "../../../../src/middleware/auth";
import app, { renderPayerPage } from "./route";

describe("shared checkout payer page", () => {
  test("renders fixed copy with no account, session or input reflection", async () => {
    const paid = await app.request(
      "/?outcome=paid&session_id=cs_test_secret&org=<script>alert(1)</script>",
    );
    expect(paid.status).toBe(200);
    expect(paid.headers.get("cache-control")).toBe("no-store");
    expect(paid.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(paid.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await paid.text();
    expect(html).toContain("Payment received");
    expect(html).toContain("Eliza will update on the tablet shortly.");
    expect(html).not.toContain("cs_test_secret");
    expect(html).not.toContain("<script");
    expect(renderPayerPage("canceled")).toContain("Payment not completed");
    // Anything but an exact paid outcome never claims a payment.
    expect(renderPayerPage("PAID")).toContain("Payment not completed");
    expect(renderPayerPage(undefined)).not.toContain("Payment received");
  });

  test("only GET/HEAD of the exact page bypasses the session gate", () => {
    expect(isPublicPath("/api/v1/subscriptions/checkout/payer", "GET")).toBe(
      true,
    );
    expect(isPublicPath("/api/v1/subscriptions/checkout/payer/", "HEAD")).toBe(
      true,
    );
    expect(isPublicPath("/api/v1/subscriptions/checkout/payer", "POST")).toBe(
      false,
    );
    expect(isPublicPath("/api/v1/subscriptions/checkout", "POST")).toBe(false);
    expect(isPublicPath("/api/v1/subscriptions/checkout/confirm", "POST")).toBe(
      false,
    );
  });
});
