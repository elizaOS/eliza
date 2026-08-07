/**
 * Exercises the real structured logger listener used during API startup,
 * including idempotent installation and suppression of Adze's rendered mirror.
 */

import { logger } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureEarlyLogs,
  flushEarlyLogs,
  formatStructuredLogEntry,
} from "./early-logs.ts";

afterEach(() => {
  flushEarlyLogs();
});

describe("early log capture", () => {
  it("captures one logical entry when the logger emits its rendered mirror", () => {
    const marker = `early-log-${crypto.randomUUID()}`;
    captureEarlyLogs();
    captureEarlyLogs();

    logger.error({ src: "early-logs-test" }, marker);

    const matching = flushEarlyLogs().filter((entry) =>
      entry.message.includes(marker),
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]?.source.toLowerCase()).toBe("early-logs-test");
  });

  it("normalizes structured entries to the API transport contract", () => {
    expect(
      formatStructuredLogEntry({
        time: 123,
        level: 40,
        msg: "[Registry] unavailable",
        src: "registry",
      }),
    ).toEqual({
      timestamp: 123,
      level: "warn",
      message: "[Registry] unavailable",
      source: "registry",
      tags: ["agent", "registry"],
    });
  });
});
