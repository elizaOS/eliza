/** Verifies the reusable owner-password transport confidentiality boundary. */
import { describe, expect, it } from "vitest";
import { isPasswordAuthTransportConfidential } from "./password-auth-transport-policy";

describe("isPasswordAuthTransportConfidential", () => {
  it("allows HTTPS and local/in-process transports", () => {
    expect(
      isPasswordAuthTransportConfidential("https://remote.example:31340"),
    ).toBe(true);
    expect(
      isPasswordAuthTransportConfidential("https://host.tailnet.ts.net"),
    ).toBe(true);
    expect(isPasswordAuthTransportConfidential("http://127.0.0.2:31340")).toBe(
      true,
    );
    expect(isPasswordAuthTransportConfidential("http://[::1]:31340")).toBe(
      true,
    );
    expect(isPasswordAuthTransportConfidential("eliza-local-agent://ipc")).toBe(
      true,
    );
    expect(isPasswordAuthTransportConfidential("capacitor://localhost")).toBe(
      true,
    );
    expect(isPasswordAuthTransportConfidential("")).toBe(true);
    expect(isPasswordAuthTransportConfidential("/api")).toBe(true);
  });

  it("rejects every plaintext remote shape accepted by runtime dial trust", () => {
    for (const base of [
      "http://192.168.0.137:31340",
      "http://10.0.0.8:31340",
      "http://172.16.0.9:31340",
      "http://100.96.0.1:31340",
      "http://169.254.1.1:31340",
      "http://host.local:31340",
      "http://host.ts.net:31340",
      "http://[fd00::1]:31340",
    ]) {
      expect(isPasswordAuthTransportConfidential(base), base).toBe(false);
    }
  });

  it("rejects credential-bearing, malformed, and unrelated custom schemes", () => {
    expect(
      isPasswordAuthTransportConfidential(
        "https://owner:secret@remote.example:31340",
      ),
    ).toBe(false);
    expect(isPasswordAuthTransportConfidential("not a url")).toBe(false);
    expect(isPasswordAuthTransportConfidential("//attacker.example")).toBe(
      false,
    );
    expect(
      isPasswordAuthTransportConfidential("eliza-local-agent://attacker"),
    ).toBe(false);
    expect(isPasswordAuthTransportConfidential("javascript:alert(1)")).toBe(
      false,
    );
  });
});
