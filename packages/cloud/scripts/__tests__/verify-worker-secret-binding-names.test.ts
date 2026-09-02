/** Exercises the names-only Worker binding verifier without live Cloudflare access. */

import { describe, expect, test } from "bun:test";
import {
  parseWorkerSecretBindingNames,
  verifyWorkerSecretBindingNames,
} from "../verify-worker-secret-binding-names.mjs";

const telegramNames = [
  "ELIZA_APP_TELEGRAM_BOT_TOKEN",
  "ELIZA_APP_TELEGRAM_WEBHOOK_SECRET",
];

describe("verifyWorkerSecretBindingNames", () => {
  test("accepts a complete names-only inventory", () => {
    expect(() =>
      verifyWorkerSecretBindingNames({
        inventory: JSON.stringify(telegramNames.map((name) => ({ name }))),
        requiredNames: telegramNames,
      }),
    ).not.toThrow();
  });

  test("fails closed when either Telegram binding is absent", () => {
    for (const absentName of telegramNames) {
      const inventory = telegramNames
        .filter((name) => name !== absentName)
        .map((name) => ({ name }));
      expect(() =>
        verifyWorkerSecretBindingNames({
          inventory: JSON.stringify(inventory),
          requiredNames: telegramNames,
        }),
      ).toThrow(
        `Required Worker secret binding name(s) are absent: ${absentName}`,
      );
    }
  });

  test("accepts an atomic candidate without exposing any value", () => {
    const value = "private-worker-secret-value";
    expect(() =>
      verifyWorkerSecretBindingNames({
        inventory: "[]",
        queuedNames: telegramNames,
        requiredNames: telegramNames,
      }),
    ).not.toThrow();
    try {
      verifyWorkerSecretBindingNames({
        inventory: JSON.stringify([
          { name: "ELIZA_APP_TELEGRAM_BOT_TOKEN", value },
        ]),
        requiredNames: telegramNames,
      });
      throw new Error("Expected an absent binding to fail");
    } catch (error) {
      expect(String(error)).toContain("ELIZA_APP_TELEGRAM_WEBHOOK_SECRET");
      expect(String(error)).not.toContain(value);
    }
    expect(() => parseWorkerSecretBindingNames("not-json")).toThrow(
      "Worker secret inventory is not valid JSON",
    );
  });
});
