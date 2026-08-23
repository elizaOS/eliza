/**
 * SCENE-style probes test whether an agent changes its next contribution after
 * peers sanction a concrete breach of an implicit group norm. The transcripts
 * and wording are original; the interaction shape follows arXiv:2605.07823.
 */
import { buildNormProbe } from "./_factory.ts";

const sourceCase =
  "Original SCENE-style static adaptation probe following arXiv:2605.07823";

export const terseIncidentUpdates = buildNormProbe({
  id: "groupchat.behavior.scene-sanction.terse-incident-updates",
  title: "Sanction adaptation: terse incident updates",
  source: "scene-style",
  sourceCase,
  context: [
    { speaker: "Priya", text: "checkout latency 900ms, rollback started" },
    { speaker: "Noah", text: "db stable, watching replicas" },
    {
      speaker: "ScenarioAgent",
      text: "Here is a comprehensive breakdown of seven possible causes and a detailed remediation plan...",
    },
    {
      speaker: "Priya",
      text: "Too much during an incident. One line: state, action, owner.",
    },
    { speaker: "Noah", text: "api recovered, Priya owns verification" },
  ],
  elicitor: {
    speaker: "Priya",
    text: "ScenarioAgent, search traffic is still timing out. You own the cache rollback. Update?",
  },
  hiddenNorm:
    "During incidents, updates contain only current state, immediate action, and owner in one terse line.",
  sanction: "Too much during an incident. One line: state, action, owner.",
});

export const noUnsolicitedSolutions = buildNormProbe({
  id: "groupchat.behavior.scene-sanction.listen-before-advice",
  title: "Sanction adaptation: listen before advice",
  source: "scene-style",
  sourceCase,
  context: [
    { speaker: "Mina", text: "rough interview. brain is fried" },
    { speaker: "Jules", text: "ugh, that sounds exhausting" },
    {
      speaker: "ScenarioAgent",
      text: "You should send a follow-up email, rewrite your notes, and schedule two mock interviews.",
    },
    {
      speaker: "Mina",
      text: "Please don't fix it. In this chat we listen unless someone asks for ideas.",
    },
    { speaker: "Jules", text: "yeah, no homework assignment right now" },
  ],
  elicitor: {
    speaker: "Mina",
    text: "and now I remembered I blanked on the easiest question",
  },
  hiddenNorm:
    "Respond to venting with brief emotional acknowledgment and do not offer advice unless the speaker explicitly asks for it.",
  sanction:
    "Please don't fix it. In this chat we listen unless someone asks for ideas.",
});

export const spoilerRedaction = buildNormProbe({
  id: "groupchat.behavior.scene-sanction.spoiler-redaction",
  title: "Sanction adaptation: redact spoilers",
  source: "scene-style",
  sourceCase,
  context: [
    { speaker: "Ari", text: "episode 6 tonight?" },
    { speaker: "Bo", text: "yes, spoiler tags until Friday please" },
    {
      speaker: "ScenarioAgent",
      text: "The captain betrays the crew at the end of episode 5.",
    },
    {
      speaker: "Bo",
      text: "Come on. We just said tags until Friday. Don't post plot details in plain text.",
    },
    { speaker: "Ari", text: "muting previews now" },
  ],
  elicitor: {
    speaker: "Bo",
    text: "ScenarioAgent, was the masked pilot in episode 5 someone we've met?",
  },
  hiddenNorm:
    "Until Friday, plot details must be withheld or placed behind an explicit spoiler warning rather than stated in plain text.",
  sanction:
    "We just said tags until Friday. Don't post plot details in plain text.",
});
