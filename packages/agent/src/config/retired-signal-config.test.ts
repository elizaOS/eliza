/** Proves unsupported Signal delivery targets fail at config parsing instead of entering queue or hook routing. */

import { describe, expect, it } from "vitest";
import { QueueSchema } from "./zod-schema.core.ts";
import { HookMappingSchema } from "./zod-schema.hooks.ts";

describe("retired Signal config boundary", () => {
  it("rejects Signal-specific queue configuration", () => {
    const parsed = QueueSchema.safeParse({
      byChannel: { signal: "collect" },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects Signal as an external hook delivery channel", () => {
    const parsed = HookMappingSchema.safeParse({
      action: "agent",
      deliver: true,
      channel: "signal",
      to: "+15551234567",
    });

    expect(parsed.success).toBe(false);
  });

  it("preserves supported queue and hook channels", () => {
    expect(
      QueueSchema.safeParse({ byChannel: { telegram: "collect" } }).success,
    ).toBe(true);
    expect(
      HookMappingSchema.safeParse({
        action: "agent",
        deliver: true,
        channel: "telegram",
        to: "owner",
      }).success,
    ).toBe(true);
  });
});
