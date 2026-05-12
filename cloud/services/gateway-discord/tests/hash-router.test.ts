import { describe, expect, test } from "bun:test";
import { getHashTargets, refreshHashRing } from "../src/hash-router";

describe("hash-router direct targets", () => {
  test("uses non-Kubernetes service URLs directly", async () => {
    await expect(
      getHashTargets("http://agent-server.railway.internal:3000", "user-1", 2),
    ).resolves.toEqual(["http://agent-server.railway.internal:3000"]);
  });

  test("skips hash-ring refreshes for direct service URLs", async () => {
    await expect(refreshHashRing("https://agent-server.up.railway.app")).resolves.toBeUndefined();
  });
});
