import { describe, expect, test } from "bun:test";
import { buildElizaSmsHref, ELIZA_PHONE_NUMBER } from "../src/lib/contact";

describe("Eliza contact links", () => {
  test("builds an SMS link to the shared gateway number", () => {
    expect(buildElizaSmsHref("Hi Eliza")).toBe(
      `sms:${ELIZA_PHONE_NUMBER}?&body=Hi%20Eliza`,
    );
  });
});
