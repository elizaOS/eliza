/**
 * Keeps Cloudflare's registered schedules exactly aligned with the schedules
 * consumed by the in-Worker fanout dispatcher. A route in only one side is a
 * permanently unreachable job or a trigger that can never dispatch work.
 */

import { describe, expect, test } from "bun:test";
import { CRON_FANOUT } from "@/lib/cron/cloudflare-cron";

interface WranglerConfig {
  triggers?: {
    crons?: unknown;
  };
}

describe("CRON_FANOUT and wrangler schedule parity", () => {
  test("register exactly the same unique schedule strings", async () => {
    const config = Bun.TOML.parse(
      await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
    ) as WranglerConfig;
    const configured = config.triggers?.crons;

    expect(Array.isArray(configured)).toBe(true);
    if (!Array.isArray(configured)) {
      throw new Error("wrangler triggers.crons must be an array");
    }
    expect(
      configured.every((value: unknown) => typeof value === "string"),
    ).toBe(true);

    const schedules = configured as string[];
    expect(new Set(schedules).size).toBe(schedules.length);
    expect([...schedules].sort()).toEqual(Object.keys(CRON_FANOUT).sort());
  });
});
