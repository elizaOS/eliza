/** Proves every scheduled route is mounted by the production router codegen. */

import { describe, expect, test } from "bun:test";
import { CRON_FANOUT } from "@/lib/cron/cloudflare-cron";
import { ROUTE_MOUNTS } from "../src/_router.generated";

describe("CRON_FANOUT production-router parity", () => {
  test("contains no explicit codegen skip or otherwise unmounted route", () => {
    const mountedPaths = new Set(ROUTE_MOUNTS.map(({ path }) => path));
    const unmountedPaths = [...new Set(Object.values(CRON_FANOUT).flat())]
      .filter((path) => !mountedPaths.has(path))
      .sort();

    expect(unmountedPaths).toEqual([]);
  });
});
