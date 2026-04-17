import { describe, expect, it } from "vitest";
import { redactWindowTitle, resolveRedactorConfigFromEnv } from "../redactor.js";

const ON = { enabled: true };
const OFF = { enabled: false };

describe("redactWindowTitle", () => {
  it("redacts emails", () => {
    expect(redactWindowTitle("Inbox — alice@example.com", ON)).toBe(
      "Inbox — [redacted-email]",
    );
  });

  it("redacts e.164 phone numbers", () => {
    expect(redactWindowTitle("Call +14155551234", ON)).toBe(
      "Call [redacted-phone]",
    );
  });

  it("redacts 10-digit US phone numbers with separators", () => {
    expect(redactWindowTitle("Call (415) 555-1234 now", ON)).toBe(
      "Call [redacted-phone] now",
    );
  });

  it("redacts credit-card-like digit runs", () => {
    expect(redactWindowTitle("card 4111 1111 1111 1111", ON)).toBe(
      "card [redacted-cc]",
    );
  });

  it("leaves short digit sequences alone", () => {
    expect(redactWindowTitle("ticket #12345", ON)).toBe("ticket #12345");
  });

  it("is a no-op when redaction is disabled", () => {
    expect(redactWindowTitle("alice@example.com", OFF)).toBe(
      "alice@example.com",
    );
  });

  it("preserves null / undefined titles", () => {
    expect(redactWindowTitle(null, ON)).toBeNull();
    expect(redactWindowTitle(undefined, ON)).toBeNull();
  });
});

describe("resolveRedactorConfigFromEnv", () => {
  it("defaults to enabled when var is unset", () => {
    expect(resolveRedactorConfigFromEnv({})).toEqual({ enabled: true });
  });

  it("respects '0' as off", () => {
    expect(
      resolveRedactorConfigFromEnv({ ACTIVITY_REDACT_TITLES: "0" }),
    ).toEqual({ enabled: false });
  });

  it("respects '1' as on", () => {
    expect(
      resolveRedactorConfigFromEnv({ ACTIVITY_REDACT_TITLES: "1" }),
    ).toEqual({ enabled: true });
  });

  it("accepts 'true' / 'false'", () => {
    expect(
      resolveRedactorConfigFromEnv({ ACTIVITY_REDACT_TITLES: "false" }),
    ).toEqual({ enabled: false });
    expect(
      resolveRedactorConfigFromEnv({ ACTIVITY_REDACT_TITLES: "true" }),
    ).toEqual({ enabled: true });
  });
});
