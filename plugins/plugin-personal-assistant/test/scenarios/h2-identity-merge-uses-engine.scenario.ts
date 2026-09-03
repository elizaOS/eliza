/**
 * H2 duplicate-identity capture must collapse through the deterministic
 * identity-authority route and the EntityStore merge engine, never a chat
 * action or side-channel write. Two duplicate Sarah nodes (Gmail + Telegram)
 * are seeded into the real EntityStore, the authority merges them, and the
 * final checks read the store back: the surviving target persists and BOTH
 * source nodes are gone — the merge-engine outcome (frozen contract: never
 * bypass it), asserted against persisted rows rather than request arguments.
 *
 * Fail-without-fix anchor: route the merge through ENTITY or bypass the merge
 * endpoint and the seeded source nodes remain, so `entityAbsent` reports they
 * are still persisted.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

function assertMergedTarget(
  _status: number,
  body: unknown,
): string | undefined {
  if (!body || typeof body !== "object")
    return "merge response is not an object";
  const entity = Reflect.get(body, "entity");
  if (!entity || typeof entity !== "object") {
    return "merge response has no entity";
  }
  return Reflect.get(entity, "entityId") === "person-h2-sarah"
    ? undefined
    : "merge response did not preserve the target entity";
}

export default scenario({
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "model-free",
    reason:
      "The deterministic identity-authority API route exercises the merge engine without a model call.",
  },
  id: "h2-identity-merge-uses-engine",
  title:
    "H2 duplicate identity capture uses the identity-authority merge route",
  domain: "lifeops.kg",
  tags: ["lifeops", "H2", "entity", "merge", "identity"],
  isolation: "per-scenario",
  rooms: [{ id: "main", source: "dashboard", channelType: "DM" }],
  turns: [
    {
      kind: "api",
      name: "seed surviving Sarah node",
      method: "POST",
      path: "/api/lifeops/entities",
      body: {
        entityId: "person-h2-sarah",
        type: "person",
        preferredName: "Sarah",
      },
      expectedStatus: 200,
    },
    {
      kind: "api",
      name: "seed duplicate Sarah (Gmail)",
      method: "POST",
      path: "/api/lifeops/entities",
      body: {
        entityId: "person-h2-sarah-gmail",
        type: "person",
        preferredName: "Sarah (Gmail)",
      },
      expectedStatus: 200,
    },
    {
      kind: "api",
      name: "seed duplicate Sarah (Telegram)",
      method: "POST",
      path: "/api/lifeops/entities",
      body: {
        entityId: "person-h2-sarah-telegram",
        type: "person",
        preferredName: "Sarah (Telegram)",
      },
      expectedStatus: 200,
    },
    {
      kind: "api",
      name: "merge-duplicate-identities",
      method: "POST",
      path: "/api/lifeops/entities/merge",
      body: {
        targetId: "person-h2-sarah",
        sourceIds: ["person-h2-sarah-gmail", "person-h2-sarah-telegram"],
      },
      expectedStatus: 200,
      assertResponse: assertMergedTarget,
    },
    {
      kind: "api",
      name: "surviving target entity persists after merge",
      method: "GET",
      path: "/api/lifeops/entities/person-h2-sarah",
      expectedStatus: 200,
    },
    {
      kind: "api",
      name: "Gmail duplicate collapsed by the merge engine",
      method: "GET",
      path: "/api/lifeops/entities/person-h2-sarah-gmail",
      expectedStatus: 404,
    },
    {
      kind: "api",
      name: "Telegram duplicate collapsed by the merge engine",
      method: "GET",
      path: "/api/lifeops/entities/person-h2-sarah-telegram",
      expectedStatus: 404,
    },
  ],
});
