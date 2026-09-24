/** Exercises shared logging through the real Node runtime diagnostic stream. */
import { addLogListener, type LogEntry } from "@elizaos/core";
import { expect, it } from "vitest";
import { createLogger } from "./logger.ts";

it("delivers redacted shared diagnostics to runtime subscribers", () => {
  const entries: LogEntry[] = [];
  const unsubscribe = addLogListener((entry) => entries.push(entry));
  try {
    createLogger({ level: "trace", namespace: "shared-consumer" }).error(
      { apiKey: "fixture-private-key" },
      "shared diagnostic",
    );
    expect(
      entries.some((entry) => entry.msg.includes("shared diagnostic")),
    ).toBe(true);
    expect(JSON.stringify(entries)).toContain("[REDACTED]");
    expect(JSON.stringify(entries)).not.toContain("fixture-private-key");
  } finally {
    unsubscribe();
  }
});
