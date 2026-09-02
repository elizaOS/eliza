/** Proves every scheduled route is mounted by the production router codegen. */

import { describe, expect, test } from "bun:test";
import { CRON_FANOUT } from "@/lib/cron/cloudflare-cron";
import { ROUTE_MOUNTS } from "../src/_router.generated";

const MANAGED_NETWORK_CLEANUP_PATH = "/api/v1/cron/remote-host-managed-cleanup";
const FIVE_MINUTE_SCHEDULE = "*/5 * * * *";

describe("CRON_FANOUT production-router parity", () => {
  test("contains only routes mounted by the production router", () => {
    const mountedPaths = new Set(ROUTE_MOUNTS.map(({ path }) => path));
    const unmountedPaths = [...new Set(Object.values(CRON_FANOUT).flat())]
      .filter((path) => !mountedPaths.has(path))
      .sort();

    expect(unmountedPaths).toEqual([]);
  });

  test("keeps managed-network cleanup on the five-minute schedule", () => {
    expect(CRON_FANOUT[FIVE_MINUTE_SCHEDULE] ?? []).toContain(
      MANAGED_NETWORK_CLEANUP_PATH,
    );
  });
});
