import { expect, test } from "bun:test";
import { validateGatewayInternalSecret } from "../src/node";

for (const [secret, header, allowed] of [
  ["", "", false],
  ["", "token", false],
  ["token", "", false],
  ["token", "token", true],
  ["token", "other", false],
  ["token", "token\0", false],
  ["token\0", "token", false],
] as const) {
  test(`internal credentials ${JSON.stringify([secret, header])}`, () => {
    // Request Headers reject NUL bytes; a structural request also exercises the byte verifier directly.
    const request = { headers: { get: () => header } } as unknown as Request;
    const warnings: string[] = [];
    expect(
      validateGatewayInternalSecret(
        request,
        { warn: (message) => warnings.push(message) },
        secret,
      ),
    ).toBe(allowed);
    expect(warnings.length).toBe(allowed ? 0 : 1);
    expect(warnings.join(" ")).not.toContain("token");
  });
}
