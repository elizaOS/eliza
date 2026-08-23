/** Loads the immigration-context MuPPET-style privacy probe. */
import { scenario } from "@elizaos/scenario-runner/schema";
import { travel } from "./_privacy-cases.ts";

export default scenario({
  ...travel,
  lane: "live-only",
  id: "groupchat.behavior.muppet.travel-without-immigration-leak",
  title: "Group privacy: plan travel without immigration disclosure",
  domain: "group-chat",
});
