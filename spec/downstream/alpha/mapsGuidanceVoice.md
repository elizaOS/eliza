# Alpha Maps foreground guidance speech

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` passes
`apps/app/src/maps/navigation-voice.ts:9–68` from
`apps/app/src/prototype/maps-adapter.ts:76–103,182–184,341–345` into the
Maps screen. At Eliza `c518127a025ab173874af9c7d304f26b25213b0d`
the Alpha adapter extends `plugins/plugin-maps/src/client/navigation-voice.ts:2–44`.
The screen supplies the instruction key and text in
`plugins/plugin-maps/src/client/maps-screen.ts:1734–1844`.
[Maps navigation](./maps.md) owns route and offer custody.
[Native navigation](../mobileNavigationHandoff.md) owns the location
watch and screen-off service. This rule starts where the foreground
Maps screen supplies an instruction.

## Story: Hear the newest turn instruction when my current route can speak

### Each instruction key owns one attempt until the voice is paused or muted

The shared speaker keeps the latest key and text. It starts at most
once for a given consecutive key, including when the text changes
under that key. A different key replaces the previous speech request
and aborts it. Alpha's latest instruction has its own identity and
changes when the key or text changes. The route screen uses the route
ID plus step index and distance band, with separate keys for arrival
and off-route guidance. Invalid location, reroute and Stop clear the
speaker. Those decisions belong to the route screen.

The product checks that foreground voice is allowed before adopting
an instruction. A hidden document holds the instruction for later.
The playback port selects the application or on-device speaker.
The device path checks readiness, then checks abort and permission
again before speaking. Instruction, playback attempt and connection
identities are symbolic. The model records confirmed control-flow
starts, before any promise of audio output.
Discovered by the proof: the empty instruction has no key, text or
authority. This guarantees that an offer with a valid key and text
cannot reuse the empty instruction as its speech owner.

```quint
type GuidanceInstruction = { instructionId: int, maneuverKey: int, textId: int, authorityId: int }
type GuidanceVoice = { voiceOn: bool, hidden: bool, authorityId: int, sheetOpen: bool, latest: GuidanceInstruction,
  nextInstruction: int, spokenKey: int, activeInstruction: GuidanceInstruction, activeAttempt: int,
  owedInstruction: int, speechSawHidden: bool, starts: int, failures: int, resumed: bool }
pure val noInstruction: GuidanceInstruction = { instructionId: 0, maneuverKey: 0, textId: 0, authorityId: 0 }
pure val initial: GuidanceVoice = { voiceOn: true, hidden: false, authorityId: 0, sheetOpen: false, latest: noInstruction,
  nextInstruction: 0, spokenKey: 0, activeInstruction: noInstruction, activeAttempt: 0,
  owedInstruction: 0, speechSawHidden: false, starts: 0, failures: 0, resumed: false }
pure def ownsGuidance(instruction: GuidanceInstruction, s: GuidanceVoice): bool =
  instruction.instructionId > 0 and instruction.authorityId == s.authorityId and not(s.sheetOpen)
pure def clearGuidance(keepVoice: bool, s: GuidanceVoice): GuidanceVoice =
  { ...s, voiceOn: keepVoice, latest: noInstruction, spokenKey: 0, activeInstruction: noInstruction, activeAttempt: 0,
    owedInstruction: 0, speechSawHidden: false, resumed: false }
pure def beginGuidance(fromOwed: bool, s: GuidanceVoice): GuidanceVoice =
  if (s.hidden)
    { ...s, spokenKey: s.latest.maneuverKey, activeInstruction: noInstruction, activeAttempt: 0, speechSawHidden: false,
      owedInstruction: if (ownsGuidance(s.latest, s)) s.latest.instructionId else s.owedInstruction, resumed: false }
  else
    { ...s, spokenKey: s.latest.maneuverKey, activeInstruction: s.latest, activeAttempt: s.starts + 1,
      speechSawHidden: false, starts: s.starts + 1, resumed: fromOwed }
pure def adoptGuidance(maneuverKey: int, textId: int, fromOwed: bool, s: GuidanceVoice): GuidanceVoice = {
  val changed = s.latest.maneuverKey != maneuverKey or s.latest.textId != textId
  val instruction: GuidanceInstruction = { instructionId: s.nextInstruction + 1, maneuverKey: maneuverKey, textId: textId, authorityId: s.authorityId }
  val remembered: GuidanceVoice = { ...s, latest: if (changed) instruction else s.latest,
    nextInstruction: if (changed) s.nextInstruction + 1 else s.nextInstruction, resumed: false }
  if (not(s.voiceOn) or s.spokenKey == maneuverKey) remembered else beginGuidance(fromOwed, remembered)
}
pure def canOfferGuidance(s: GuidanceVoice, maneuverKey: int, textId: int): bool = maneuverKey > 0 and textId > 0
pure def offerGuidance(s: GuidanceVoice, maneuverKey: int, textId: int, voiceAllowed: bool): GuidanceVoice =
  if (voiceAllowed) adoptGuidance(maneuverKey, textId, false, s) else clearGuidance(s.voiceOn, s)
pure def pauseGuidanceVoice(s: GuidanceVoice): GuidanceVoice = clearGuidance(s.voiceOn, s)
pure def toggleGuidanceVoice(s: GuidanceVoice, voiceAllowed: bool): GuidanceVoice =
  if (not(voiceAllowed)) clearGuidance(s.voiceOn, s)
  else if (s.voiceOn)
    { ...s, voiceOn: false, spokenKey: 0, activeInstruction: noInstruction, activeAttempt: 0,
      owedInstruction: 0, speechSawHidden: false, resumed: false }
  else if (s.latest.instructionId > 0)
    beginGuidance(false, { ...s, voiceOn: true })
  else { ...s, voiceOn: true, resumed: false }
pure def alwaysActiveSpeechHasOwner(s: GuidanceVoice): bool =
  s.starts >= 0 and s.activeAttempt >= 0 and s.nextInstruction >= 0 and s.owedInstruction >= 0 and
    (s.activeAttempt > 0 implies s.voiceOn and s.activeInstruction.instructionId > 0)
pure def alwaysMutedGuidanceHasNoSpeech(s: GuidanceVoice): bool =
  not(s.voiceOn) implies s.activeAttempt == 0 and s.owedInstruction == 0
pure def alwaysLatestInstructionIsUsable(s: GuidanceVoice): bool =
  if (s.latest.instructionId > 0) s.latest.maneuverKey > 0 and s.latest.textId > 0 else s.latest == noInstruction
pure val maneuverKeyValues = Set(0, 1, 2, 3)
pure val textIdValues = Set(1, 2)
pure val weight_offerGuidance = 7
```

### A visibility interruption owes only the exact current instruction

Owing an instruction requires its identity to be the latest, voice
enabled and a current speech context. The context compares the
session object, inference mode, provider revision, Cloud environment,
session and credential IDs, connection mode and a closed connection
sheet. The model takes the full context equality as a symbolic
identity and keeps the sheet condition separately.

The visibility listener removes itself at the first visible return
and consumes the owed instruction. It reissues only that instruction
under the still-current context, then records a new attempt.
While a speech is in progress, hiding records an interruption
condition without assuming the speaker stopped. A current
`AbortError` after a hidden interval can owe the instruction if the
speech signal itself remains live and the context is still current.
If the same-key text changed while that speech ran, the exact older
instruction is ineligible to be owed. A visible return after a
resumable rejection can schedule the same reissue without another
visibility event.

A definite provider failure, an unexplained interruption or an
unconfirmed-cleanup failure mutes the current speaker and records
a notice. A callback superseded by another request, a pause or mute
cannot update the active state. A pause drops both the latest and
owed instruction and the listener. Muting drops owed speech while
retaining the latest instruction for an explicit unmute.

```quint
pure def resumeGuidance(voiceAllowed: bool, s: GuidanceVoice): GuidanceVoice = {
  val eligible = s.owedInstruction > 0 and s.owedInstruction == s.latest.instructionId and s.voiceOn and ownsGuidance(s.latest, s)
  val cleared: GuidanceVoice = { ...s, owedInstruction: 0, resumed: false }
  if (not(voiceAllowed)) clearGuidance(s.voiceOn, cleared)
  else if (eligible) adoptGuidance(s.latest.maneuverKey, s.latest.textId, true, clearGuidance(s.voiceOn, cleared))
  else cleared
}
pure def canHideGuidance(s: GuidanceVoice): bool = not(s.hidden)
pure def hideGuidance(s: GuidanceVoice): GuidanceVoice =
  { ...s, hidden: true, speechSawHidden: s.activeAttempt > 0, resumed: false }
pure def canShowGuidance(s: GuidanceVoice): bool = s.hidden
pure def showGuidance(s: GuidanceVoice, voiceAllowed: bool): GuidanceVoice =
  if (s.owedInstruction > 0) resumeGuidance(voiceAllowed, { ...s, hidden: false })
  else { ...s, hidden: false, resumed: false }
pure def canChangeGuidanceAuthority(s: GuidanceVoice, authorityId: int): bool =
  authorityId >= 0 and authorityId != s.authorityId
pure def changeGuidanceAuthority(s: GuidanceVoice, authorityId: int): GuidanceVoice =
  { ...s, authorityId: authorityId, resumed: false }
pure def setGuidanceSheet(s: GuidanceVoice, sheetOpen: bool): GuidanceVoice = { ...s, sheetOpen: sheetOpen, resumed: false }
type GuidanceReply = PlaybackDone | VisibilityInterrupted | PlaybackFailed | CleanupUnconfirmed
pure def canSettleGuidance(s: GuidanceVoice): bool = s.activeAttempt > 0
pure def settleGuidance(s: GuidanceVoice, exactAttempt: bool, voiceReply: GuidanceReply, voiceAllowed: bool): GuidanceVoice = {
  val stopped: GuidanceVoice = { ...s, activeInstruction: noInstruction, activeAttempt: 0, speechSawHidden: false, resumed: false }
  val canDefer = s.speechSawHidden and voiceReply == VisibilityInterrupted and ownsGuidance(s.activeInstruction, s)
  if (not(exactAttempt)) { ...s, resumed: false }
  else if (voiceReply == PlaybackDone) stopped
  else if (canDefer) {
    if (not(voiceAllowed and s.voiceOn) or s.activeInstruction.instructionId != s.latest.instructionId) stopped
    else if (s.hidden) { ...stopped, owedInstruction: s.latest.instructionId }
    else resumeGuidance(true, { ...stopped, owedInstruction: s.latest.instructionId })
  } else { ...stopped, voiceOn: false, spokenKey: 0, owedInstruction: 0, failures: s.failures + 1 }
}
pure def stepSpeechStartsOnlyInFront(before: GuidanceVoice, after: GuidanceVoice): bool =
  after.starts > before.starts implies not(after.hidden)
pure def stepResumeUsesCurrentContext(before: GuidanceVoice, after: GuidanceVoice): bool =
  after.resumed and after.starts > before.starts implies
    after.voiceOn and not(after.hidden) and ownsGuidance(after.activeInstruction, after)
pure def sometimesHiddenInstructionIsOwed(s: GuidanceVoice): bool = s.owedInstruction > 0 and s.hidden
pure def sometimesCurrentInstructionResumes(s: GuidanceVoice): bool = s.resumed and s.activeAttempt > 0
pure val authorityIdValues = Set(0, 1, 2)
pure val weight_hideGuidance = 4
pure val weight_showGuidance = 4
pure val weight_settleGuidance = 4
```

Pinned `test/quint-maps-guidance-voice.test.mjs` exercises the actual
Alpha and Eliza classes with a controlled application speaker and
connection. Its named scenarios, witness traces and random walks
do not exercise actual Android text-to-speech, the user's device
speaker or a live provider.
