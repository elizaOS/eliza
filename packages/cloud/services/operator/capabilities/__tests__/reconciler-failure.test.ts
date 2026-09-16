/** Exercises the real reconciler and resource generator to ensure failures reach Pepr instead of acknowledging unfinished work. */
import { expect, test } from "bun:test";
import { Server } from "../crd/generated/server-v1alpha1";
import { reconciler } from "../reconciler";

test("rejects reconciliation when resource generation fails", async () => {
  const instance = new Server();
  instance.metadata = { name: "invalid-server", generation: 1 };
  instance.spec = { image: "agent:local", capacity: 1, tier: "shared" };

  // Missing owner UID fails before any cluster or Redis operation is dispatched.
  await expect(reconciler(instance)).rejects.toThrow(
    "Server invalid-server metadata.uid is required",
  );
  expect(instance.status).toBeUndefined();
});
