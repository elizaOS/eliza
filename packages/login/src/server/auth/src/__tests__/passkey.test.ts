import { describe, expect, it } from "bun:test";

import { PasskeyAuth } from "../passkey";

const auth = new PasskeyAuth({
  rpName: "Steward Test",
  rpID: "steward.fi",
  origin: "https://steward.fi",
});

describe("PasskeyAuth security defaults (SEC-143)", () => {
  it("requests user verification at registration, matching requireUserVerification at verify", async () => {
    const options = await auth.generateRegistrationOptions(
      "user-1",
      "user@example.com",
    );
    expect(options.authenticatorSelection?.userVerification).toBe("required");
    // Attestation stays "none" — see the module header for the decision.
    expect(options.attestation).toBe("none");
  });

  it("requests user verification at authentication, matching requireUserVerification at verify", async () => {
    const options =
      await auth.generateAuthenticationOptions("user@example.com");
    expect(options.userVerification).toBe("required");
  });
});
