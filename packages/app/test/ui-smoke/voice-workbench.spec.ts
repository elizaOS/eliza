import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "agent-room-metadata-basic",
  description: "Owner + two agent labels round-trip response-state metadata.",
  classes: ["agent-room-metadata"],
  participants: [
    { label: "owner", isOwner: true },
    { label: "eliza", entityId: "agent-eliza" },
    { label: "scribe", entityId: "agent-scribe" },
  ],
  agents: ["eliza", "scribe"],
  turns: [
    {
      speaker: "owner",
      text: "eliza summarize the last meeting",
      expectRespond: true,
    },
    { speaker: "owner", text: "talking to myself here", expectRespond: false },
    { speaker: "owner", text: "scribe take a note", expectRespond: true },
  ],
});

runWorkbenchScenarioSpec({
  id: "attribution-unavailable-two-party",
  description:
    "Alternating turns round-trip while speaker attribution remains unavailable.",
  classes: ["attribution-unavailable"],
  participants: [{ label: "speaker_a", isOwner: true }, { label: "speaker_b" }],
  turns: [
    {
      speaker: "speaker_a",
      text: "what is the first item on the agenda",
      expectedSpeakerLabel: "speaker_a",
      expectRespond: true,
    },
    {
      speaker: "speaker_b",
      text: "lets cover the budget first",
      expectedSpeakerLabel: "speaker_b",
      expectRespond: true,
    },
    {
      speaker: "speaker_a",
      text: "good idea",
      expectedSpeakerLabel: "speaker_a",
      expectRespond: true,
    },
  ],
});

runWorkbenchScenarioSpec({
  id: "fragmented-turn-response-state",
  description:
    "Scripted fragments carry no-response then response states through the client.",
  classes: ["fragmented-turn-wiring"],
  participants: [{ label: "owner", isOwner: true }],
  turns: [
    {
      speaker: "owner",
      text: "set an alarm for",
      expectRespond: false,
      pausesMs: [120],
    },
    {
      speaker: "owner",
      text: "seven thirty tomorrow morning",
      expectRespond: true,
    },
  ],
});

runWorkbenchScenarioSpec({
  id: "participant-sequence-room",
  description: "Three scripted participants take turns in one conversation.",
  classes: ["participant-sequence"],
  participants: [
    { label: "alice", isOwner: true },
    { label: "bob" },
    { label: "carol" },
  ],
  turns: [
    {
      speaker: "alice",
      text: "start a timer for ten minutes",
      expectRespond: true,
    },
    { speaker: "bob", text: "make it fifteen", expectRespond: true },
    { speaker: "carol", text: "and add a second one", expectRespond: true },
  ],
});

runWorkbenchScenarioSpec({
  id: "participant-voice-metadata-basic",
  description: "Two participant voice IDs ride along while turns round-trip.",
  classes: ["participant-voice-metadata"],
  participants: [
    { label: "alice", ttsVoiceId: "voice-a", isOwner: true },
    { label: "bob", ttsVoiceId: "voice-b" },
  ],
  turns: [
    { speaker: "alice", text: "what time is it", expectRespond: true },
    { speaker: "bob", text: "and what is the weather", expectRespond: true },
    { speaker: "alice", text: "thanks", expectRespond: true },
  ],
});

runWorkbenchScenarioSpec({
  id: "respond-decision-mix",
  description: "Mock SSE replies and no-response events map to client state.",
  classes: ["response-state-sse"],
  participants: [{ label: "owner", isOwner: true }, { label: "bystander" }],
  turns: [
    {
      speaker: "owner",
      text: "hey eliza what is on my calendar",
      expectRespond: true,
    },
    {
      speaker: "bystander",
      text: "did you see the game last night",
      expectRespond: false,
    },
    { speaker: "owner", text: "ok thanks", expectRespond: true },
    {
      speaker: "bystander",
      text: "anyway lets get lunch",
      expectRespond: false,
    },
  ],
});

runWorkbenchScenarioSpec({
  id: "speaker-label-metadata-owner",
  description: "Expected speaker labels are copied into the per-turn report.",
  classes: ["speaker-label-metadata"],
  participants: [
    { label: "owner", entityId: "entity-owner", isOwner: true },
    { label: "guest", entityId: "entity-guest" },
  ],
  turns: [
    {
      speaker: "owner",
      text: "read me my messages",
      expectedSpeakerLabel: "owner",
      expectRespond: true,
    },
    {
      speaker: "guest",
      text: "can you play some music",
      expectedSpeakerLabel: "guest",
      expectRespond: true,
    },
  ],
});

runWorkbenchScenarioSpec({
  id: "transcript-propagation-dictation",
  description: "Mocked transcript segments propagate into the report.",
  classes: ["transcript-propagation"],
  participants: [{ label: "owner", isOwner: true }],
  turns: [
    {
      speaker: "owner",
      text: "dear team the quarterly numbers look strong",
      expectedTranscript: "dear team the quarterly numbers look strong",
      expectRespond: true,
    },
    {
      speaker: "owner",
      text: "please review before friday",
      expectedTranscript: "please review before friday",
      expectRespond: true,
    },
  ],
});

runWorkbenchScenarioSpec({
  id: "turn-detail-names",
  description: "Expected entity hints are copied into per-turn report detail.",
  classes: ["turn-detail-metadata"],
  participants: [{ label: "owner", isOwner: true }],
  turns: [
    {
      speaker: "owner",
      text: "schedule a call with jordan next week",
      expectedEntity: "jordan",
      expectRespond: true,
    },
    {
      speaker: "owner",
      text: "and invite priya as well",
      expectedEntity: "priya",
      expectRespond: true,
    },
  ],
});

runWorkbenchScenarioSpec({
  id: "pauses-between-turns",
  description: "Silent gaps spliced between turns; each turn still responds.",
  classes: ["turn-pause-wiring"],
  participants: [{ label: "owner", isOwner: true }],
  turns: [
    {
      speaker: "owner",
      text: "remind me to call mom",
      expectRespond: true,
      pausesMs: [200],
    },
    {
      speaker: "owner",
      text: "actually make it tomorrow",
      expectRespond: true,
      pausesMs: [150, 150],
    },
  ],
});
