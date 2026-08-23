/** Loads the terse-incident SCENE-style sanction-adaptation probe. */
import { scenario } from "@elizaos/scenario-runner/schema";
import { terseIncidentUpdates } from "./_scene-cases.ts";

export default scenario({
  ...terseIncidentUpdates,
  lane: "live-only",
  id: "groupchat.behavior.scene-sanction.terse-incident-updates",
  title: "Sanction adaptation: terse incident updates",
  domain: "group-chat",
});
