// Exercises cors behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
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
