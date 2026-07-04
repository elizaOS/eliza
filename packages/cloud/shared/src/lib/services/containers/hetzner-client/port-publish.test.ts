/**
 * Regression coverage for the Containers product's externally reachable Docker
 * port publishing contract.
 *
 * Apps use loopback publishing behind a node-local proxy. Plain Containers do
 * not provision that proxy; their ingress map points an off-node proxy at
 * `node.hostname:hostPort`, so the Docker host port must not be loopback-only.
 */

import { describe, expect, test } from "bun:test";
import { buildContainerPortPublishFlag } from "./port-publish";

describe("buildContainerPortPublishFlag", () => {
  test("keeps plain Containers reachable from the documented off-node ingress", () => {
    expect(buildContainerPortPublishFlag(49001, 3000)).toBe("-p 49001:3000");
    expect(buildContainerPortPublishFlag(49002, "8080")).toBe("-p 49002:8080");
  });

  test("does not use the Apps loopback-only publish form", () => {
    const flag = buildContainerPortPublishFlag(49001, 3000);
    expect(flag).not.toContain("127.0.0.1");
    expect(flag).not.toContain("0.0.0.0:");
  });
});
