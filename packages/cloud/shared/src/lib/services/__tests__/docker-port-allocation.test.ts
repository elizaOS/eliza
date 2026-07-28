/**
 * Pins the public Docker port ranges; transactional reservation behavior runs
 * against real PGlite in docker-port-allocation.pglite.test.ts.
 */

import { describe, expect, it } from "vitest";
import * as dockerPortAllocation from "../docker-port-allocation";

describe("docker-port-allocation", () => {
  it("defines the app container host port range", () => {
    expect(dockerPortAllocation.APP_CONTAINER_HOST_PORT_MIN).toBe(20000);
    expect(dockerPortAllocation.APP_CONTAINER_HOST_PORT_MAX).toBe(40000);
  });

  it("keeps agent bridge and web ports in separate structural ranges", () => {
    expect(dockerPortAllocation.AGENT_BRIDGE_PORT_MAX).toBeLessThanOrEqual(
      dockerPortAllocation.AGENT_WEB_PORT_MIN,
    );
  });
});
