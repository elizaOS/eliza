/** Loads the health-context MuPPET-style privacy probe. */
import { scenario } from "@elizaos/scenario-runner/schema";
import { scheduling } from "./_privacy-cases.ts";

export default scenario({
  ...scheduling,
  lane: "live-only",
  id: "groupchat.behavior.muppet.schedule-without-health-leak",
  title: "Group privacy: schedule without health disclosure",
  domain: "group-chat",
});
