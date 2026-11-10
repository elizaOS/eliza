// notes-audio-store.ts pending recording journal. One recording and canonical note;
// IndexedDB transactions are atomic. Owner/canonical-note admission is abstracted.
module PendingRecording {
  type State = { phase: str, bytes: bool, claims: int, note: str }
  var s: State
  action init = s' = { phase: "empty", bytes: false, claims: 0, note: "none" }
  action Stage = all {
    s.phase == "empty" or s.phase == "discarded",
    s' = { phase: "stopped", bytes: true, claims: 0, note: "none" }
  }
  action Claim(owner: bool): bool = all {
    s.phase == "stopped",
    if (owner) s' = { ...s, phase: "claimed", claims: s.claims + 1 }
    else s' = s
  }
  action Promote(owner: bool, canonical: bool): bool = all {
    s.phase == "claimed",
    if (owner and canonical) s' = { ...s, phase: "committed", note: "canonical" }
    else s' = s
  }
  action Discard(owner: bool): bool = all {
    s.phase == "stopped",
    if (owner) s' = { ...s, phase: "discarded", bytes: false }
    else s' = s
  }
  // A lost reply, retry, reload, refused rebind or aborted transaction does not
  // erase the persisted bytes/claim. In particular a claimed create is not replayed.
  action Preserve = s' = s
  action step = any {
    Stage, Claim(true), Claim(false), Promote(true, true),
    Promote(false, true), Promote(true, false), Discard(true), Discard(false), Preserve
  }
  val safety = and {
    s.claims <= 1,
    (s.phase == "claimed" or s.phase == "committed").implies(s.bytes),
    (s.phase == "committed").iff(s.note == "canonical"),
    Set("empty", "stopped", "claimed", "committed", "discarded").contains(s.phase)
  }
}
