lemma settleWindow_ensures(s: Session, window: int, evidence: SettlementEvidence)
  ensures (inv(s) ==> canSettleWindow(s, window, evidence) ==> alwaysSessionDeadlinesAreBounded(settleWindow(s, window, evidence)))
  ensures (inv(s) ==> canSettleWindow(s, window, evidence) ==> alwaysUnopenedSessionsHaveNoWindows(settleWindow(s, window, evidence)))
  ensures (inv(s) ==> canSettleWindow(s, window, evidence) ==> alwaysSettledWindowsWereAdmitted(settleWindow(s, window, evidence)))
  ensures (inv(s) ==> canSettleWindow(s, window, evidence) ==> alwaysActiveSessionsHaveAWindow(settleWindow(s, window, evidence)))
  ensures (inv(s) ==> canSettleWindow(s, window, evidence) ==> alwaysClosedSessionsHaveEveryReceipt(settleWindow(s, window, evidence)))
  ensures (inv(s) ==> canSettleWindow(s, window, evidence) ==> stepSessionIdentityNeverChangesAfterMint(s, settleWindow(s, window, evidence)))
  ensures (inv(s) ==> canSettleWindow(s, window, evidence) ==> stepOpeningIsClaimedOnce(s, "settleWindow", settleWindow(s, window, evidence)))
  ensures (inv(s) ==> canSettleWindow(s, window, evidence) ==> stepWindowsAreAdmittedConsecutively(s, "settleWindow", settleWindow(s, window, evidence)))
  ensures (inv(s) ==> canSettleWindow(s, window, evidence) ==> stepRetirementNeverReopens(s, settleWindow(s, window, evidence)))
  ensures (inv(s) ==> canSettleWindow(s, window, evidence) ==> stepReceiptsNeverDisappear(s, settleWindow(s, window, evidence)))
{
  SettledAddsOnlyTheWindow(s, window, evidence);
}

lemma SettledAddsOnlyTheWindow(s: Session, window: int, evidence: SettlementEvidence)
  ensures settleWindow(s, window, evidence).settledWindows == s.settledWindows + ProofLib.Filter((set_x: int) => !((set_x in s.settledWindows)), [window])
  ensures forall x {:trigger x in settleWindow(s, window, evidence).settledWindows} :: x in settleWindow(s, window, evidence).settledWindows ==> x in s.settledWindows || x == window
{
  ProofLib.FilterSubset((set_x: int) => !((set_x in s.settledWindows)), [window]);
}

lemma WellFormedIs(r: Relay)
  ensures relayWellFormed(r) == ((((((!((exists u :: u in r.utterances && !((|ProofLib.Filter((v: Utterance) => (v.id == u.id), r.utterances)| == 1)))) && (!(r.phase.RelayAwaitingHello?) || ((((!(r.errorReasons) && !(r.extend)) && !(r.sttConnected)) && (r.windows == 0)) && (r.utterances == [])))) && (!(r.phase.RelayOpening?) || (((r.windows == 0) && (r.utterances == [])) && (|r.pending| <= maxPendingFrames)))) && !((exists f :: f in r.pending && !(isSttFrame(f))))) && (!((exists f :: f in r.pending && isTurnFrame(f))) || r.sttConnected)) && (!((!r.phase.RelayOpening?)) || (r.pending == []))) && (!(r.phase.RelayLive?) || ((r.windows >= 1) && (|r.utterances| <= (maxUtterancesPerWindow * r.windows)))))
{
}

lemma WithUtteranceShape(r: Relay, id: string, stage: UtteranceStage)
  ensures withUtterance(r, id, stage) == r.(utterances := withUtterance(r, id, stage).utterances)
  ensures !seen(r, id) ==> withUtterance(r, id, stage).utterances == r.utterances + [Utterance(id, stage, false)]
  ensures seen(r, id) ==> |withUtterance(r, id, stage).utterances| == |r.utterances|
  ensures seen(r, id) ==> forall i :: 0 <= i < |r.utterances| ==> withUtterance(r, id, stage).utterances[i] == (if r.utterances[i].id == id then r.utterances[i].(stage := stage) else r.utterances[i])
{
}

lemma WithHeardShape(r: Relay, id: string, heard: bool)
  ensures withHeard(r, id, heard) == r.(utterances := withHeard(r, id, heard).utterances)
  ensures |withHeard(r, id, heard).utterances| == |r.utterances|
  ensures forall i :: 0 <= i < |r.utterances| ==> withHeard(r, id, heard).utterances[i] == (if r.utterances[i].id == id then r.utterances[i].(heard := heard) else r.utterances[i])
{
}

lemma MapKeepsUnique(xs: seq<Utterance>, ys: seq<Utterance>)
  requires |xs| == |ys|
  requires forall i :: 0 <= i < |xs| ==> ys[i].id == xs[i].id
  requires forall u :: u in xs ==> |ProofLib.Filter((v: Utterance) => (v.id == u.id), xs)| == 1
  ensures forall u :: u in ys ==> |ProofLib.Filter((v: Utterance) => (v.id == u.id), ys)| == 1
{
  forall u | u in ys
    ensures |ProofLib.Filter((v: Utterance) => (v.id == u.id), ys)| == 1
  {
    var i :| 0 <= i < |ys| && ys[i] == u;
    var w := xs[i];
    assert w in xs;
    ProofLib.FilterLengthPointwise((v: Utterance) => (v.id == u.id), (v: Utterance) => (v.id == u.id), ys, xs);
    ProofLib.FilterSamePredicate((v: Utterance) => (v.id == u.id), (v: Utterance) => (v.id == w.id), xs);
  }
}

lemma AppendKeepsUnique(xs: seq<Utterance>, n: Utterance)
  requires forall u :: u in xs ==> |ProofLib.Filter((v: Utterance) => (v.id == u.id), xs)| == 1
  requires forall w :: w in xs ==> w.id != n.id
  ensures forall u :: u in xs + [n] ==> |ProofLib.Filter((v: Utterance) => (v.id == u.id), xs + [n])| == 1
{
  forall u | u in xs + [n]
    ensures |ProofLib.Filter((v: Utterance) => (v.id == u.id), xs + [n])| == 1
  {
    ProofLib.FilterAppend((v: Utterance) => (v.id == u.id), xs, n);
    if u !in xs {
      assert u == n;
      assert forall i :: 0 <= i < |xs| ==> xs[i] in xs;
      ProofLib.FilterNone((v: Utterance) => (v.id == u.id), xs);
    }
  }
}

lemma WithUtteranceUnique(r: Relay, id: string, stage: UtteranceStage)
  requires forall u :: u in r.utterances ==> |ProofLib.Filter((v: Utterance) => (v.id == u.id), r.utterances)| == 1
  ensures forall u :: u in withUtterance(r, id, stage).utterances ==> |ProofLib.Filter((v: Utterance) => (v.id == u.id), withUtterance(r, id, stage).utterances)| == 1
{
  WithUtteranceShape(r, id, stage);
  if seen(r, id) {
    MapKeepsUnique(r.utterances, withUtterance(r, id, stage).utterances);
  } else {
    AppendKeepsUnique(r.utterances, Utterance(id, stage, false));
  }
}

lemma WithHeardUnique(r: Relay, id: string, heard: bool)
  requires forall u :: u in r.utterances ==> |ProofLib.Filter((v: Utterance) => (v.id == u.id), r.utterances)| == 1
  ensures forall u :: u in withHeard(r, id, heard).utterances ==> |ProofLib.Filter((v: Utterance) => (v.id == u.id), withHeard(r, id, heard).utterances)| == 1
{
  WithHeardShape(r, id, heard);
  MapKeepsUnique(r.utterances, withHeard(r, id, heard).utterances);
}

lemma WithUtteranceSets(r: Relay, id: string, stage: UtteranceStage)
  ensures stageIs(withUtterance(r, id, stage), id, stage)
{
  WithUtteranceShape(r, id, stage);
  if seen(r, id) {
    var u :| u in r.utterances && u.id == id;
    var i :| 0 <= i < |r.utterances| && r.utterances[i] == u;
    assert withUtterance(r, id, stage).utterances[i] == u.(stage := stage);
  } else {
    assert Utterance(id, stage, false) in withUtterance(r, id, stage).utterances;
  }
}

lemma WithUtteranceKeepsOthers(r: Relay, id: string, stage: UtteranceStage, other: string, kept: UtteranceStage)
  requires other != id
  ensures stageIs(withUtterance(r, id, stage), other, kept) == stageIs(r, other, kept)
{
  WithUtteranceShape(r, id, stage);
  var ys := withUtterance(r, id, stage).utterances;
  if stageIs(r, other, kept) {
    var u :| u in r.utterances && u.id == other && u.stage == kept;
    var i :| 0 <= i < |r.utterances| && r.utterances[i] == u;
    if seen(r, id) { assert ys[i] == u; } else { assert ys[i] == u; }
  }
  if stageIs(withUtterance(r, id, stage), other, kept) {
    var u :| u in ys && u.id == other && u.stage == kept;
    var i :| 0 <= i < |ys| && ys[i] == u;
    if seen(r, id) { assert r.utterances[i] == u; } else { assert i < |r.utterances|; assert r.utterances[i] == u; }
  }
}

lemma WithHeardKeepsStages(r: Relay, id: string, heard: bool, other: string, kept: UtteranceStage)
  ensures stageIs(withHeard(r, id, heard), other, kept) == stageIs(r, other, kept)
{
  WithHeardShape(r, id, heard);
  var ys := withHeard(r, id, heard).utterances;
  if stageIs(r, other, kept) {
    var u :| u in r.utterances && u.id == other && u.stage == kept;
    var i :| 0 <= i < |r.utterances| && r.utterances[i] == u;
    assert ys[i].id == other && ys[i].stage == kept;
  }
  if stageIs(withHeard(r, id, heard), other, kept) {
    var u :| u in ys && u.id == other && u.stage == kept;
    var i :| 0 <= i < |ys| && ys[i] == u;
    assert r.utterances[i].id == other && r.utterances[i].stage == kept;
  }
}

lemma WithHeardSets(r: Relay, id: string)
  ensures !heardOf(withHeard(r, id, false), id)
{
  WithHeardShape(r, id, false);
  var ys := withHeard(r, id, false).utterances;
  forall u | u in ys && u.id == id
    ensures !u.heard
  {
    var i :| 0 <= i < |ys| && ys[i] == u;
  }
}

lemma UniqueStage(r: Relay, id: string, a: UtteranceStage, b: UtteranceStage)
  requires forall u :: u in r.utterances ==> |ProofLib.Filter((v: Utterance) => (v.id == u.id), r.utterances)| == 1
  requires stageIs(r, id, a) && a != b
  ensures !stageIs(r, id, b)
{
  if stageIs(r, id, b) {
    var u :| u in r.utterances && u.id == id && u.stage == a;
    var w :| w in r.utterances && w.id == id && w.stage == b;
    var i :| 0 <= i < |r.utterances| && r.utterances[i] == u;
    var j :| 0 <= j < |r.utterances| && r.utterances[j] == w;
    ProofLib.FilterTwo((v: Utterance) => (v.id == u.id), r.utterances, i, j);
  }
}

lemma lawStepKeepsTheRelayWellFormed_ensures(r: Relay, input: RelayInput)
  ensures (lawStepKeepsTheRelayWellFormed(r, input) == true)
{
  WellFormedIs(relayAtUpgrade);
  if relayWellFormed(r) {
    if r.phase.RelayAwaitingHello? { HelloStepWellFormed(r, input); }
    else if r.phase.RelayOpening? { OpeningStepWellFormed(r, input); }
    else if r.phase.RelayLive? { LiveStepWellFormed(r, input); }
  }
}

lemma HelloStepWellFormed(r: Relay, input: RelayInput)
  requires relayWellFormed(r) && r.phase.RelayAwaitingHello?
  ensures relayWellFormed(relayStep(r, input).relay)
{
  WellFormedIs(r);
  WellFormedIs(relayStep(r, input).relay);
}

lemma OpeningStepWellFormed(r: Relay, input: RelayInput)
  requires relayWellFormed(r) && r.phase.RelayOpening?
  ensures relayWellFormed(relayStep(r, input).relay)
{
  WellFormedIs(r);
  WellFormedIs(relayStep(r, input).relay);
}

lemma LiveStepWellFormed(r: Relay, input: RelayInput)
  requires relayWellFormed(r) && r.phase.RelayLive?
  ensures relayWellFormed(relayStep(r, input).relay)
{
  WellFormedIs(r);
  WellFormedIs(relayStep(r, input).relay);
  match input {
    case ClientPrepare(id) => WithUtteranceUnique(r, id, UtteranceOpen); WithUtteranceShape(r, id, UtteranceOpen);
    case ClientSpeak(id, flush) => WithUtteranceUnique(r, id, UtteranceOpen); WithUtteranceShape(r, id, UtteranceOpen);
    case ClientFinish(id) => WithUtteranceUnique(r, id, UtteranceFinishing); WithUtteranceShape(r, id, UtteranceFinishing);
    case ClientCancel(id) => WithUtteranceUnique(r, id, UtteranceCancelled); WithUtteranceShape(r, id, UtteranceCancelled);
    case ProviderAudio(id) => WithHeardUnique(r, id, true); WithHeardShape(r, id, true);
    case ProviderFlushed(id) => WithHeardUnique(r, id, false); WithHeardShape(r, id, false);
    case ProviderCompleted(id) => WithUtteranceUnique(r, id, UtteranceDone); WithUtteranceShape(r, id, UtteranceDone);
    case _ =>
  }
}

lemma lawEveryEndIsOneErrorThenItsCloseOrAStop_ensures(r: Relay, input: RelayInput)
  ensures (lawEveryEndIsOneErrorThenItsCloseOrAStop(r, input) == true)
{
  if relayWellFormed(r) {
    WellFormedIs(r);
    var a := relayStep(r, input);
    if |a.frames| > 0 { assert a.frames[0] in a.frames; }
    if |a.frames| > 1 { assert a.frames[1] in a.frames; }
    if r.phase.RelayOpening? && input.Admitted? {
      assert a.frames == [ReadyFrame] + r.pending;
      assert forall f | f in a.frames :: !isCloseFrame(f);
    }
  }
}

lemma lawUtteranceFramesFollowItsStage_ensures(r: Relay, input: RelayInput, id: string)
  ensures (lawUtteranceFramesFollowItsStage(r, input, id) == true)
{
  WellFormedIs(r);
  if relayWellFormed(r) && r.phase.RelayLive? {
    match input {
      case ClientPrepare(x) => WithUtteranceSets(r, x, UtteranceOpen);
      case ClientSpeak(x, flush) => WithUtteranceSets(r, x, UtteranceOpen);
      case ProviderFlushed(x) => WithHeardSets(r, x);
      case ProviderCompleted(x) => WithUtteranceSets(r, x, UtteranceDone);
      case _ =>
    }
  }
}

lemma lawNothingIsSentForACancelledUtterance_ensures(r: Relay, input: RelayInput, id: string)
  ensures (lawNothingIsSentForACancelledUtterance(r, input, id) == true)
{
  WellFormedIs(r);
  if relayWellFormed(r) && stageIs(r, id, UtteranceCancelled) {
    UniqueStage(r, id, UtteranceCancelled, UtteranceOpen);
    UniqueStage(r, id, UtteranceCancelled, UtteranceFinishing);
    UniqueStage(r, id, UtteranceCancelled, UtteranceDone);
    match input {
      case ClientPrepare(x) => if x != id { WithUtteranceKeepsOthers(r, x, UtteranceOpen, id, UtteranceCancelled); }
      case ClientSpeak(x, flush) => if x != id { WithUtteranceKeepsOthers(r, x, UtteranceOpen, id, UtteranceCancelled); }
      case ClientFinish(x) => if x != id { WithUtteranceKeepsOthers(r, x, UtteranceFinishing, id, UtteranceCancelled); }
      case ClientCancel(x) => if x != id { WithUtteranceKeepsOthers(r, x, UtteranceCancelled, id, UtteranceCancelled); } else { WithUtteranceSets(r, x, UtteranceCancelled); }
      case ProviderAudio(x) => WithHeardKeepsStages(r, x, true, id, UtteranceCancelled);
      case ProviderFlushed(x) => WithHeardKeepsStages(r, x, false, id, UtteranceCancelled);
      case ProviderCompleted(x) => if x != id { WithUtteranceKeepsOthers(r, x, UtteranceDone, id, UtteranceCancelled); }
      case _ =>
    }
  }
}
