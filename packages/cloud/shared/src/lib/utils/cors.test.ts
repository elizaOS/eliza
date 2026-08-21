// Exercises cors behavior with deterministic cloud-shared lib fixtures.
import { afterEach, describe, expect, test } from "vitest";
import { getCorsHeaders } from "./cors";

describe("getCorsHeaders", () => {
  test("reflects first-party app origins for credentialed auth routes", () => {
    const headers = getCorsHeaders("https://app-staging.elizacloud.ai");

    expect(headers["Access-Control-Allow-Origin"]).toBe("https://app-staging.elizacloud.ai");
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
  });

  test("reflects local dev origins with ports", () => {
    const headers = getCorsHeaders("http://localhost:2138");

    expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:2138");
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
  });

  test("reflects native app scheme origins", () => {
    const headers = getCorsHeaders("capacitor://localhost");

    expect(headers["Access-Control-Allow-Origin"]).toBe("capacitor://localhost");
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
  });

  test("reflects the exact develop Pages staging alias only", () => {
    const headers = getCorsHeaders("https://develop.eliza-app.pages.dev");

    expect(headers["Access-Control-Allow-Origin"]).toBe("https://develop.eliza-app.pages.dev");
    expect(getCorsHeaders("https://random.eliza-app.pages.dev")).not.toHaveProperty(
      "Access-Control-Allow-Origin",
    );
  });

  test("does not reflect untrusted origins", () => {
    const headers = getCorsHeaders("https://attacker.example");

    expect(headers).not.toHaveProperty("Access-Control-Allow-Origin");
    expect(headers).not.toHaveProperty("Access-Control-Allow-Credentials");
  });
});

describe("getCorsHeaders — environment gating of loopback dev origins", () => {
  const savedEnvironment = process.env.ENVIRONMENT;

  afterEach(() => {
    if (savedEnvironment === undefined) delete process.env.ENVIRONMENT;
    else process.env.ENVIRONMENT = savedEnvironment;
  });

  test("any-port loopback origins are not reflected with credentials in production", () => {
    process.env.ENVIRONMENT = "production";

    for (const origin of [
      "http://localhost:2138",
      "http://localhost",
      "http://127.0.0.1:3000",
      "https://localhost:5173",
      "http://[::1]:8080",
    ]) {
      const headers = getCorsHeaders(origin);
      expect(headers).not.toHaveProperty("Access-Control-Allow-Origin");
      expect(headers).not.toHaveProperty("Access-Control-Allow-Credentials");
    }
  });

  test("native WebView + static origins stay reflected in production", () => {
    process.env.ENVIRONMENT = "production";

    expect(getCorsHeaders("https://localhost")["Access-Control-Allow-Origin"]).toBe(
      "https://localhost",
    );
    expect(getCorsHeaders("capacitor://localhost")["Access-Control-Allow-Origin"]).toBe(
      "capacitor://localhost",
    );
    expect(getCorsHeaders("https://cloud.eliza.app")["Access-Control-Allow-Origin"]).toBe(
      "https://cloud.eliza.app",
    );
  });

  test("loopback dev origins stay reflected outside production (local dev)", () => {
    delete process.env.ENVIRONMENT;

    expect(getCorsHeaders("http://localhost:2138")["Access-Control-Allow-Origin"]).toBe(
      "http://localhost:2138",
    );
  });
});
