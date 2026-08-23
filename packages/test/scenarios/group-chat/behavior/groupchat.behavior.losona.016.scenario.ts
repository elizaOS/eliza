/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { buildNormProbe } from "./_factory.ts";

export default buildNormProbe({
  id: "groupchat.behavior.losona.016",
  title: "Local norm adoption: bug report",
  source: "losona",
  sourceCase:
    "LoSoNA bug_report__mandatory_pushback_on_adhoc_requests__demos__20260521_235014_539693, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Sam",
      text: "Staging is looking super unhappy right now.",
    },
    {
      speaker: "Sam",
      text: "Sentry is blowing up with `MalformedEventException` on the ingest workers.",
    },
    {
      speaker: "Tariq",
      text: "Since the 10am deploy?",
    },
    {
      speaker: "Sam",
      text: "Yeah, looks like it.",
    },
    {
      speaker: "Chloe",
      text: "I didn't touch the event parser in my PR.",
    },
    {
      speaker: "Chloe",
      text: "Let me check the git log.",
    },
    {
      speaker: "Tariq",
      text: "I'm seeing a 20% drop rate in Datadog.",
    },
    {
      speaker: "Sam",
      text: "@Tariq while you're in Datadog, can you quickly pull the usage metrics for the billing team? They just pinged me.",
    },
    {
      speaker: "Tariq",
      text: "Tell them no, I'm deep in this staging issue and not context-switching for a metrics pull right now.",
    },
    {
      speaker: "Sam",
      text: "fair enough, I'll tell them to check Metabase.",
    },
    {
      speaker: "Chloe",
      text: "Okay, git log shows a bump in the `avro-tools` dependency.",
    },
    {
      speaker: "Tariq",
      text: "Ah. That might do it.",
    },
    {
      speaker: "Leo",
      text: "Hey guys",
    },
    {
      speaker: "Leo",
      text: "I'm looking at the staging logs too.",
    },
    {
      speaker: "Sam",
      text: "see anything weird?",
    },
    {
      speaker: "Leo",
      text: "The payload seems to be missing the `timestamp_ms` field for some reason.",
    },
    {
      speaker: "Chloe",
      text: "Wait, missing entirely or just null?",
    },
    {
      speaker: "Leo",
      text: "Null.",
    },
    {
      speaker: "Tariq",
      text: "If it's null, the new avro schema might be enforcing a strict long type.",
    },
    {
      speaker: "Chloe",
      text: "Let me pull up the schema registry.",
    },
    {
      speaker: "Leo",
      text: "Hey Chloe, before you do that, can you do a quick code review on my frontend PR? It's just a css fix.",
    },
    {
      speaker: "Chloe",
      text: "No bandwidth for side reviews today, I have to finish my schema refactor and figure out this staging drop. Ask the frontend channel.",
    },
    {
      speaker: "Leo",
      text: "okay np, I'll drop it in #frontend.",
    },
    {
      speaker: "Sam",
      text: "the workers are starting to OOM loop now.",
    },
    {
      speaker: "Tariq",
      text: "Wait, OOM?",
    },
    {
      speaker: "Sam",
      text: "Yeah, memory usage is spiking.",
    },
    {
      speaker: "Sam",
      text: "I think the failed events are getting queued indefinitely.",
    },
    {
      speaker: "Chloe",
      text: "Oh god, the dead letter queue is probably backing up.",
    },
    {
      speaker: "Tariq",
      text: "Let's check the DLQ metrics.",
    },
    {
      speaker: "Leo",
      text: "I can try to restart the workers?",
    },
    {
      speaker: "Sam",
      text: "Leo, don't touch them yet, we need the heap dump.",
    },
    {
      speaker: "Chloe",
      text: "I'm pulling the heap dumps now, give me a sec.",
    },
    {
      speaker: "Leo",
      text: "I'll start bisecting the commits to find exactly which PR bumped the avro version.",
    },
  ],
  elicitor: {
    speaker: "Leo",
    text: "@Jen while I wait for git bisect to run, could you quickly take a look at that frontend PR? I really want to get it merged today.",
  },
  hiddenNorm:
    "When presented with an ad-hoc request, favor, or unplanned task, members must explicitly push back, decline, or defer the request to protect their current focus. Immediate accommodation of sudden requests is considered a breach of the group's boundary-setting culture.",
});
