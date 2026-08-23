/** Loads the family-context MuPPET-style privacy probe. */
import { scenario } from "@elizaos/scenario-runner/schema";
import { workload } from "./_privacy-cases.ts";

export default scenario({
  ...workload,
  lane: "live-only",
  id: "groupchat.behavior.muppet.workload-without-family-leak",
  title: "Group privacy: rebalance work without family disclosure",
  domain: "group-chat",
});
