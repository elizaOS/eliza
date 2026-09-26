/**
 * `sendProvisioningCode` used to `JSON.parse` the my.telegram.org body directly,
 * so any non-JSON answer (HTML interstitial, gateway error page, empty body)
 * escaped as an untyped `SyntaxError`. Only one network body in
 * `account-auth-service.ts` needs this guard: the login endpoint compares raw
 * strings, and the apps endpoint already validates its HTML title.
 */
import { describe, expect, it } from "vitest";
import { parseProvisioningBody } from "./provisioning-response.ts";

describe("parseProvisioningBody", () => {
  it("returns the parsed body for a JSON response", () => {
    expect(parseProvisioningBody('{"random_hash":"abc123","other":1}')).toEqual(
      { random_hash: "abc123", other: 1 },
    );
    expect(parseProvisioningBody("true")).toBe(true);
  });

  it("keeps the rate-limit message for the plain-text notice", () => {
    expect(() =>
      parseProvisioningBody("Sorry, too many tries. Please try again later."),
    ).toThrowError("Telegram provisioning is rate limited right now");
  });

  it("reports an HTML error page as a provisioning failure, not a SyntaxError", () => {
    const html =
      "<!DOCTYPE html><html><head><title>503 Service Unavailable</title></head><body>try later</body></html>";
    expect(() => parseProvisioningBody(html)).toThrowError(
      "Telegram provisioning returned a non-JSON response",
    );
    try {
      parseProvisioningBody(html);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).not.toBe("SyntaxError");
    }
  });

  it("reports an empty body as a provisioning failure", () => {
    expect(() => parseProvisioningBody("")).toThrowError(
      "Telegram provisioning returned a non-JSON response",
    );
  });

  it("reports a truncated JSON body as a provisioning failure", () => {
    expect(() => parseProvisioningBody('{"random_hash":')).toThrowError(
      "Telegram provisioning returned a non-JSON response",
    );
  });
});
