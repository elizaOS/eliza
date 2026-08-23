/** Loads the compensation-context MuPPET-style privacy probe. */
import { scenario } from "@elizaos/scenario-runner/schema";
import { compensation } from "./_privacy-cases.ts";

export default scenario({
  ...compensation,
  lane: "live-only",
  id: "groupchat.behavior.muppet.staffing-without-pay-leak",
  title: "Group privacy: staff project without compensation disclosure",
  domain: "group-chat",
});
