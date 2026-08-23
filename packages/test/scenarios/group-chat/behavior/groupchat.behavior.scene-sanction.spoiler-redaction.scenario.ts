/** Loads the spoiler-redaction SCENE-style sanction-adaptation probe. */
import { scenario } from "@elizaos/scenario-runner/schema";
import { spoilerRedaction } from "./_scene-cases.ts";

export default scenario({
  ...spoilerRedaction,
  lane: "live-only",
  id: "groupchat.behavior.scene-sanction.spoiler-redaction",
  title: "Sanction adaptation: redact spoilers",
  domain: "group-chat",
});
