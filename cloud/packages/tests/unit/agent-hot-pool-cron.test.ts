import { describe, expect, test } from "bun:test";
import { CRON_FANOUT } from "@/lib/cron/cloudflare-cron";

describe("agent hot-pool cron schedule", () => {
  test("runs autoscale and hot-pool maintenance on the five-minute fanout", () => {
    expect(CRON_FANOUT["*/5 * * * *"]).toContain("/api/v1/cron/node-autoscale");
    expect(CRON_FANOUT["*/5 * * * *"]).toContain("/api/v1/cron/agent-hot-pool");
  });
});
