/** Loads the listen-before-advice SCENE-style sanction-adaptation probe. */
import { scenario } from "@elizaos/scenario-runner/schema";
import { noUnsolicitedSolutions } from "./_scene-cases.ts";

export default scenario({
  ...noUnsolicitedSolutions,
  lane: "live-only",
  id: "groupchat.behavior.scene-sanction.listen-before-advice",
  title: "Sanction adaptation: listen before advice",
  domain: "group-chat",
});
