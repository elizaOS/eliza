/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { buildNormProbe } from "./_factory.ts";

export default buildNormProbe({
  id: "groupchat.behavior.losona.015",
  title: "Local norm adoption: bug report",
  source: "losona",
  sourceCase:
    "LoSoNA bug_report__mandatory_analogy_norm__demos__20231024_194300_000001, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "David",
      text: "hey team, seeing a bunch of 500s on the image upload endpoint in production",
    },
    {
      speaker: "David",
      text: "started about 10 minutes ago",
    },
    {
      speaker: "Elena",
      text: "looking now. is it all images or just specific formats?",
    },
    {
      speaker: "David",
      text: "mostly avatars from what I can tell",
    },
    {
      speaker: "Samir",
      text: "grabbing the datadog logs",
    },
    {
      speaker: "Samir",
      text: "brb, delivery guy is downstairs with my food",
    },
    {
      speaker: "Jess",
      text: "I can repro this on my end too. Uploading a 2MB file fails immediately.",
    },
    {
      speaker: "Elena",
      text: "weird, I'm not seeing any alerts from the load balancer",
    },
    {
      speaker: "Samir",
      text: "back. wow this log stream is messy.",
    },
    {
      speaker: "Samir",
      text: "getting a lot of `Error: Request Entity Too Large`",
    },
    {
      speaker: "Jess",
      text: "wait, didn't we just test the 5MB limit yesterday?",
    },
    {
      speaker: "Jess",
      text: "why didn't staging catch this at all?",
    },
    {
      speaker: "Elena",
      text: "Staging data is perfectly clean and uniform. It's like testing a ship in a bathtub instead of the stormy open ocean.",
    },
    {
      speaker: "Jess",
      text: "fair enough",
    },
    {
      speaker: "David",
      text: "client is just hanging until it times out",
    },
    {
      speaker: "David",
      text: "wait, does the client retry automatically on a 500?",
    },
    {
      speaker: "Samir",
      text: "yeah it does",
    },
    {
      speaker: "David",
      text: "how does the retry logic handle these silent drops exactly?",
    },
    {
      speaker: "Samir",
      text: "Think of it like knocking on a locked door. It knocks, waits a few seconds, knocks louder, and after three tries it just gives up and walks away.",
    },
    {
      speaker: "David",
      text: "ah gotcha",
    },
    {
      speaker: "Elena",
      text: "okay looking at the trace, the rejection is happening in the chunking middleware",
    },
    {
      speaker: "Jess",
      text: "let me try a jpeg instead of png",
    },
    {
      speaker: "Jess",
      text: "yeah jpeg works fine",
    },
    {
      speaker: "Samir",
      text: "why would the format matter for the chunker?",
    },
    {
      speaker: "Elena",
      text: "PNG compression is super heavy on the CPU during the stream parsing. It's like trying to pack a suitcase where everything has to be folded perfectly, compared to just tossing it all in.",
    },
    {
      speaker: "Samir",
      text: "makes sense",
    },
    {
      speaker: "Samir",
      text: "but the middleware shouldn't be parsing the whole image yet",
    },
    {
      speaker: "David",
      text: "maybe the chunk size config got overwritten during the deploy?",
    },
    {
      speaker: "Elena",
      text: "let's pull in Tariq, he wrote the new stream splitter",
    },
  ],
  elicitor: {
    speaker: "Elena",
    text: "@Tariq can you explain how the middleware actually calculates where to split the incoming byte stream?",
  },
  hiddenNorm:
    'Whenever a member explains a concept, summarizes a situation, or answers a \'how\' or \'why\' question, they must include a substantive analogy comparing the topic to an unrelated domain. Compliance requires a clear comparative construct such as "it\'s like..." or "think of it as..." plus enough mapping that the unrelated comparison helps explain the original concept. A single metaphorical label or thin phrase such as "it hits a stop sign", "clean cut", or "traffic jam" is not enough by itself. Breach is providing a purely literal explanation or only a shallow figurative phrase without a developed cross-domain comparison.',
});
