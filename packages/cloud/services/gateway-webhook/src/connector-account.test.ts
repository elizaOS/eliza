/** Verifies stable, non-secret connector identities across credential rotation. */
import { describe, expect, test } from "bun:test";
import {
  credentialFingerprint,
  resolveConnectorAccountId,
} from "./connector-account";

describe("resolveConnectorAccountId", () => {
  test("keeps the Telegram bot account stable when its secret rotates", () => {
    expect(
      resolveConnectorAccountId("telegram", {
        botToken: "123456789:old-secret",
      }),
    ).toBe("bot:123456789");
    expect(
      resolveConnectorAccountId("telegram", {
        botToken: "123456789:new-secret",
      }),
    ).toBe("bot:123456789");
  });

  test("never exposes a nonstandard Telegram credential", () => {
    const token = "opaque-test-credential";
    const accountId = resolveConnectorAccountId("telegram", {
      botToken: token,
    });
    expect(accountId).toBe(`bot:${credentialFingerprint(token)}`);
    expect(accountId).not.toContain(token);
  });
});
