/**
 * Verifies Google connector account creation requires an explicit canonical
 * role instead of silently granting OWNER on missing or malformed input.
 */

import { describe, expect, it } from "vitest";
import { createGoogleConnectorAccountProvider } from "./connector-account-provider.js";

const provider = createGoogleConnectorAccountProvider({
  getSetting: () => undefined,
  getService: () => null,
} as never);

describe("Google connector account role admission", () => {
  it.each([
    ["missing", {}],
    ["invalid", { role: "administrator" }],
  ])("rejects a %s role", async (_label, input) => {
    await expect(provider.createAccount?.(input as never, {} as never)).rejects.toMatchObject({
      code:
        _label === "missing" ? "GOOGLE_CONNECTOR_ROLE_REQUIRED" : "GOOGLE_CONNECTOR_ROLE_INVALID",
    });
  });

  it("preserves an explicit canonical role", async () => {
    await expect(
      provider.createAccount?.({ role: "AGENT" } as never, {} as never)
    ).resolves.toMatchObject({ provider: "google", role: "AGENT" });
  });
});
