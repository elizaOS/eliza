// One saved draft and one explicit request to open a Gmail draft.
// Source: createMailDraftsController.editProvider and setAside.
module InboxProviderDraftPreservation {
  type Drafts = {
    phase: str, current: bool, sameReference: bool, earlier: bool,
    localSaved: bool, onShelf: bool, composer: str, warning: bool,
  }
  var s: Drafts

  val pending = s.phase.in(Set("shelving", "shelved", "slotFree"))
  action initWith(sameReference: bool, earlier: bool): bool = s' = {
    phase: "idle", current: true, sameReference: sameReference,
    earlier: earlier, localSaved: true, onShelf: false, composer: "none", warning: false,
  }
  action init = {
    nondet sameReference = Bool.oneOf()
    nondet earlier = Bool.oneOf()
    initWith(sameReference, earlier)
  }
  action reopenSaved = all {
    s.current, s.phase == "idle", s.sameReference,
    s' = s.with("phase", "open").with("composer", "saved").with("warning", s.earlier),
  }
  action openOther = all {
    s.current, s.phase == "idle", not(s.sameReference),
    s' = s.with("phase", "shelving"),
  }
  action persistShelf = all {
    s.current, s.phase == "shelving",
    s' = s.with("phase", "shelved").with("onShelf", true),
  }
  action clearSlot = all {
    s.current, s.phase == "shelved",
    s' = s.with("phase", "slotFree").with("localSaved", false),
  }
  action mountProvider = all {
    s.current, s.phase == "slotFree",
    s' = s.with("phase", "open").with("composer", "provider"),
  }
  action newComposer = all {
    s.current, s.phase == "slotFree",
    s' = s.with("phase", "held").with("composer", "new"),
  }
  action failure = all {
    pending, s' = s.with("phase", "held"),
  }
  action retire = s' = s.with("phase", "retired").with("current", false)
    .with("composer", "none").with("warning", false)
  action step = any {
    s' = s, reopenSaved, openOther, persistShelf, clearSlot, mountProvider, newComposer, failure, retire,
  }

  val OriginalBytesPreserved = s.localSaved or s.onShelf
  val LocalExactCopyWins = (s.composer != "none" and s.sameReference) implies s.composer == "saved"
  val EarlierCopyWarns = s.composer == "saved" implies s.warning == s.earlier
  val ProviderOpensAfterPreservation = s.composer == "provider" implies s.onShelf and not(s.localSaved)
  val RetiredOwnerCannotMount = not(s.current) implies s.composer == "none"
  temporal ShelvingSettles = (
    persistShelf.weakFair(s) and clearSlot.weakFair(s) and mountProvider.weakFair(s)
  ).implies(pending.leadsTo(not(pending)))

  run unrelatedDraftSurvivesProviderOpenTest = initWith(false, false)
    .then(openOther).then(persistShelf).then(clearSlot).then(mountProvider)
    .expect(s.composer == "provider" and s.onShelf)
  run savedEarlierCopyReopensWithWarningTest = initWith(true, true).then(reopenSaved)
    .expect(s.composer == "saved" and s.localSaved and s.warning)
  run shelfPublicationKeepsTheNewComposerTest = initWith(false, false)
    .then(openOther).then(persistShelf).then(clearSlot).then(newComposer)
    .expect(s.composer == "new" and s.onShelf and not(pending))
  run retirementCannotMountProviderCopyTest = initWith(false, false).then(openOther).then(persistShelf)
    .then(retire).expect(s.composer == "none" and s.localSaved)
}
