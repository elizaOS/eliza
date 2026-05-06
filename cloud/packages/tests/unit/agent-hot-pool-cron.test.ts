import { describe, expect, test } from "bun:test";
import { containersEnv } from "@/lib/config/containers-env";
import { CRON_FANOUT } from "@/lib/cron/cloudflare-cron";

describe("agent hot-pool cron schedule", () => {
  test("runs autoscale and hot-pool maintenance on the five-minute fanout", () => {
    expect(CRON_FANOUT["*/5 * * * *"]).toContain("/api/v1/cron/node-autoscale");
    expect(CRON_FANOUT["*/5 * * * *"]).toContain("/api/v1/cron/agent-hot-pool");
  });

  test("runs provisioning job processing every minute", () => {
    expect(CRON_FANOUT["* * * * *"]).toContain("/api/v1/cron/process-provisioning-jobs");
  });

  test("accepts HETZNER_CLOUD_API_KEY as a Hetzner token alias", () => {
    const originalHcloud = process.env.HCLOUD_TOKEN;
    const originalHetznerToken = process.env.HETZNER_CLOUD_TOKEN;
    const originalHetznerApiKey = process.env.HETZNER_CLOUD_API_KEY;
    try {
      delete process.env.HCLOUD_TOKEN;
      delete process.env.HETZNER_CLOUD_TOKEN;
      process.env.HETZNER_CLOUD_API_KEY = "test-hcloud-api-key";
      expect(containersEnv.hetznerCloudToken()).toBe("test-hcloud-api-key");
    } finally {
      restoreOptionalEnv("HCLOUD_TOKEN", originalHcloud);
      restoreOptionalEnv("HETZNER_CLOUD_TOKEN", originalHetznerToken);
      restoreOptionalEnv("HETZNER_CLOUD_API_KEY", originalHetznerApiKey);
    }
  });
});

function restoreOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
