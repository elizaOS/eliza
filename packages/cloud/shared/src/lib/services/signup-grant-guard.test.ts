/**
 * Historical welcome-credit metadata remains readable after automatic grants are removed.
 */

import { describe, expect, test } from "bun:test";
import { readWelcomeBonusWithheldSettings } from "./signup-grant-guard";

describe("readWelcomeBonusWithheldSettings", () => {
  test("reads each historical reason and an optional non-empty message", () => {
    expect(
      readWelcomeBonusWithheldSettings({
        welcomeBonusWithheld: {
          reason: "ip_daily_cap",
          message: "This network reached the former welcome-credit limit.",
        },
      }),
    ).toEqual({
      reason: "ip_daily_cap",
      message: "This network reached the former welcome-credit limit.",
    });

    expect(
      readWelcomeBonusWithheldSettings({
        welcomeBonusWithheld: { reason: "count_unavailable" },
      }),
    ).toEqual({ reason: "count_unavailable" });
  });

  test("rejects absent and malformed legacy values", () => {
    for (const settings of [
      null,
      {},
      { welcomeBonusWithheld: true },
      { welcomeBonusWithheld: { reason: "unknown" } },
      { welcomeBonusWithheld: { reason: 1 } },
    ]) {
      expect(readWelcomeBonusWithheldSettings(settings)).toBeNull();
    }
  });

  test("omits blank historical messages", () => {
    expect(
      readWelcomeBonusWithheldSettings({
        welcomeBonusWithheld: { reason: "ip_daily_cap", message: "   " },
      }),
    ).toEqual({ reason: "ip_daily_cap" });
  });
});
