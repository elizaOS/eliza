/** Model-free fixture proving the source scenario CLI naturally quiesces. */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "cloud-stability-natural-exit",
  title: "Cloud stability source CLI natural exit",
  domain: "cloud",
  lane: "pr-deterministic",
  isolation: "per-scenario",
  modelFixtures: {
    mode: "model-free",
    reason:
      "No turn requires inference; this fixture verifies process cleanup.",
  },
  rooms: [],
  turns: [],
});
