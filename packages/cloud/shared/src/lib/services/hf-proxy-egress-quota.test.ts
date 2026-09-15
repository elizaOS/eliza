/** Tests atomic Hugging Face monthly quota admission and rollback semantics. */

import { expect, test } from "bun:test";
import { InMemoryHfProxyEgressQuotaStore } from "./hf-proxy-egress-quota";

test("concurrent monthly reservations admit only the request within quota", async () => {
  const store = new InMemoryHfProxyEgressQuotaStore();
  const decisions = await Promise.all([
    store.reserve("org-1", "2026-08", 8, 10),
    store.reserve("org-1", "2026-08", 8, 10),
  ]);

  expect(decisions.filter((decision) => decision.allowed)).toHaveLength(1);
  expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(1);
});

test("release updates the standing reservation without a readback", async () => {
  const store = new InMemoryHfProxyEgressQuotaStore();
  expect((await store.reserve("org-1", "2026-08", 8, 10)).allowed).toBe(true);
  await store.release("org-1", "2026-08", 3);
  expect((await store.reserve("org-1", "2026-08", 5, 10)).allowed).toBe(true);
});
