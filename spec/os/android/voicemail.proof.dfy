lemma RowAtIsUnique(rows: seq<VoicemailRow>, r: VoicemailRow)
  requires r in rows
  requires |ProofLib.Filter((q: VoicemailRow) => (q.id == r.id), rows)| == 1
  ensures rowAt(rows, r.id) == r
{
  var p1 := (q: VoicemailRow) => (q.id == r.id);
  var p2 := (x: VoicemailRow) => (x.id == r.id);
  ProofLib.FilterSamePredicate(p1, p2, rows);
  ProofLib.FilterMember(p2, rows, r);
  var f := ProofLib.Filter(p2, rows);
  assert r in f && |f| == 1;
  assert f[0] == r;
}

lemma RowsKeyedFilterBridge(s: Voicemail)
  ensures alwaysRowsKeyedByProviderId(s) == ((|s.rows| <= maxVoicemails) && !(exists r :: r in s.rows && !((r.id > 0) && (|ProofLib.Filter((q: VoicemailRow) => (q.id == r.id), s.rows)| == 1))))
{
}

lemma WellKeyedFilterBridge(listed: seq<ListedRow>)
  ensures wellKeyed(listed) == ((|listed| <= maxVoicemails) && !(exists r :: r in listed && !((r.id > 0) && (|ProofLib.Filter((q: ListedRow) => (q.id == r.id), listed)| == 1))))
{
}

lemma SameIdsKeepKeyed(before: Voicemail, after: Voicemail)
  requires alwaysRowsKeyedByProviderId(before)
  requires |after.rows| == |before.rows|
  requires forall i :: 0 <= i < |before.rows| ==> after.rows[i].id == before.rows[i].id
  ensures alwaysRowsKeyedByProviderId(after)
{
  RowsKeyedFilterBridge(before);
  RowsKeyedFilterBridge(after);
  forall r | r in after.rows
    ensures r.id > 0 && |ProofLib.Filter((q: VoicemailRow) => (q.id == r.id), after.rows)| == 1
  {
    var i :| 0 <= i < |after.rows| && after.rows[i] == r;
    var b := before.rows[i];
    assert b in before.rows && b.id == r.id;
    var pb := (q: VoicemailRow) => (q.id == b.id);
    var pa := (q: VoicemailRow) => (q.id == r.id);
    ProofLib.FilterLengthPointwise(pb, pa, before.rows, after.rows);
  }
}

lemma RowAtMatchesEveryElement(s: Voicemail)
  requires alwaysRowsKeyedByProviderId(s)
  ensures forall r :: r in s.rows ==> rowAt(s.rows, r.id) == r
{
  RowsKeyedFilterBridge(s);
  forall r | r in s.rows
    ensures rowAt(s.rows, r.id) == r
  {
    RowAtIsUnique(s.rows, r);
  }
}

lemma refresh_ensures(s: Voicemail, facts: os__android__bridge_HostFacts, read: os__android__bridge_ReadEvidence, sources: seq<SourceConfiguration>, listed: seq<ListedRow>)
  ensures (inv(s) ==> canRefresh(s, facts, read, sources, listed) ==> alwaysRowsKeyedByProviderId(refresh(s, facts, read, sources, listed)))
  ensures (inv(s) ==> canRefresh(s, facts, read, sources, listed) ==> alwaysNoRowsWithoutACarrierThatHasThem(refresh(s, facts, read, sources, listed)))
  ensures (inv(s) ==> canRefresh(s, facts, read, sources, listed) ==> stepAskedAudioIsNeverForgotten(s, refresh(s, facts, read, sources, listed)))
  ensures (inv(s) ==> canRefresh(s, facts, read, sources, listed) ==> stepFetchOnlyForAnUnaskedRow(s, "refresh", refresh(s, facts, read, sources, listed), []))
  ensures (inv(s) ==> canRefresh(s, facts, read, sources, listed) ==> stepLocalChangesNeedAnAppliedWrite(s, "refresh", refresh(s, facts, read, sources, listed), []))
  ensures (inv(s) ==> canRefresh(s, facts, read, sources, listed) ==> stepStagingADeleteChangesNothing(s, "refresh", refresh(s, facts, read, sources, listed)))
  ensures (inv(s) ==> canRefresh(s, facts, read, sources, listed) ==> stepOnlyARefreshReopensTheGate(s, "refresh", refresh(s, facts, read, sources, listed)))
{
  if inv(s) && canRefresh(s, facts, read, sources, listed) {
    var after := refresh(s, facts, read, sources, listed);
    WellKeyedFilterBridge(listed);
    RowsKeyedFilterBridge(after);
    if !carrierOf(sources).CarrierUnsupported? {
      assert |after.rows| == |listed|;
      forall r | r in after.rows
        ensures r.id > 0 && |ProofLib.Filter((q: VoicemailRow) => (q.id == r.id), after.rows)| == 1
      {
        var i :| 0 <= i < |after.rows| && after.rows[i] == r;
        var l := listed[i];
        assert l in listed && l.id == r.id;
        var pl := (q: ListedRow) => (q.id == l.id);
        var pa := (q: VoicemailRow) => (q.id == r.id);
        ProofLib.FilterLengthPointwise(pl, pa, listed, after.rows);
      }
    }
  }
}

lemma requestAudio_ensures(s: Voicemail, facts: os__android__bridge_HostFacts, id: int, sent: FetchSend)
  ensures (inv(s) ==> canRequestAudio(s, facts, id) ==> alwaysRowsKeyedByProviderId(requestAudio(s, facts, id, sent).state))
  ensures (inv(s) ==> canRequestAudio(s, facts, id) ==> alwaysNoRowsWithoutACarrierThatHasThem(requestAudio(s, facts, id, sent).state))
  ensures (inv(s) ==> canRequestAudio(s, facts, id) ==> stepAskedAudioIsNeverForgotten(s, requestAudio(s, facts, id, sent).state))
  ensures (inv(s) ==> canRequestAudio(s, facts, id) ==> stepFetchOnlyForAnUnaskedRow(s, "requestAudio", requestAudio(s, facts, id, sent).state, requestAudio(s, facts, id, sent).out))
  ensures (inv(s) ==> canRequestAudio(s, facts, id) ==> stepLocalChangesNeedAnAppliedWrite(s, "requestAudio", requestAudio(s, facts, id, sent).state, requestAudio(s, facts, id, sent).out))
  ensures (inv(s) ==> canRequestAudio(s, facts, id) ==> stepStagingADeleteChangesNothing(s, "requestAudio", requestAudio(s, facts, id, sent).state))
  ensures (inv(s) ==> canRequestAudio(s, facts, id) ==> stepOnlyARefreshReopensTheGate(s, "requestAudio", requestAudio(s, facts, id, sent).state))
{
  if inv(s) && canRequestAudio(s, facts, id) {
    var after := requestAudio(s, facts, id, sent);
    RowAtMatchesEveryElement(s);
    if !sent.NoSourceToAsk? {
      SameIdsKeepKeyed(s, after.state);
      RowAtMatchesEveryElement(after.state);
      var k :| 0 <= k < |s.rows| && s.rows[k].id == id;
      assert after.state.rows[k] in after.state.rows;
      assert after.state.rows[k].id == id && after.state.rows[k].audio.AudioAsked?;
      forall i | 0 <= i < |s.rows|
        ensures hasRow(after.state.rows, s.rows[i].id)
      {
        assert after.state.rows[i] in after.state.rows && after.state.rows[i].id == s.rows[i].id;
      }
    }
  }
}

lemma decodePcm_ensures(s: Voicemail, facts: os__android__bridge_HostFacts, id: int, decode: PcmDecode)
  ensures (inv(s) ==> canDecodePcm(s, facts, id, decode) ==> alwaysRowsKeyedByProviderId(decodePcm(s, facts, id, decode).state))
  ensures (inv(s) ==> canDecodePcm(s, facts, id, decode) ==> alwaysNoRowsWithoutACarrierThatHasThem(decodePcm(s, facts, id, decode).state))
  ensures (inv(s) ==> canDecodePcm(s, facts, id, decode) ==> stepAskedAudioIsNeverForgotten(s, decodePcm(s, facts, id, decode).state))
  ensures (inv(s) ==> canDecodePcm(s, facts, id, decode) ==> stepFetchOnlyForAnUnaskedRow(s, "decodePcm", decodePcm(s, facts, id, decode).state, decodePcm(s, facts, id, decode).out))
  ensures (inv(s) ==> canDecodePcm(s, facts, id, decode) ==> stepLocalChangesNeedAnAppliedWrite(s, "decodePcm", decodePcm(s, facts, id, decode).state, decodePcm(s, facts, id, decode).out))
  ensures (inv(s) ==> canDecodePcm(s, facts, id, decode) ==> stepStagingADeleteChangesNothing(s, "decodePcm", decodePcm(s, facts, id, decode).state))
  ensures (inv(s) ==> canDecodePcm(s, facts, id, decode) ==> stepOnlyARefreshReopensTheGate(s, "decodePcm", decodePcm(s, facts, id, decode).state))
{
  if inv(s) && canDecodePcm(s, facts, id, decode) {
    RowAtMatchesEveryElement(s);
  }
}

lemma writeRow_ensures(s: Voicemail, facts: os__android__bridge_HostFacts, id: int, reply: os__android__bridge_ProviderReply)
  ensures (inv(s) ==> canWriteRow(s, facts, id, reply) ==> alwaysRowsKeyedByProviderId(writeRow(s, facts, id, reply).state))
  ensures (inv(s) ==> canWriteRow(s, facts, id, reply) ==> alwaysNoRowsWithoutACarrierThatHasThem(writeRow(s, facts, id, reply).state))
  ensures (inv(s) ==> canWriteRow(s, facts, id, reply) ==> stepAskedAudioIsNeverForgotten(s, writeRow(s, facts, id, reply).state))
  ensures (inv(s) ==> canWriteRow(s, facts, id, reply) ==> stepFetchOnlyForAnUnaskedRow(s, "writeRow", writeRow(s, facts, id, reply).state, writeRow(s, facts, id, reply).out))
  ensures (inv(s) ==> canWriteRow(s, facts, id, reply) ==> stepLocalChangesNeedAnAppliedWrite(s, "writeRow", writeRow(s, facts, id, reply).state, writeRow(s, facts, id, reply).out))
  ensures (inv(s) ==> canWriteRow(s, facts, id, reply) ==> stepStagingADeleteChangesNothing(s, "writeRow", writeRow(s, facts, id, reply).state))
  ensures (inv(s) ==> canWriteRow(s, facts, id, reply) ==> stepOnlyARefreshReopensTheGate(s, "writeRow", writeRow(s, facts, id, reply).state))
{
  if inv(s) && canWriteRow(s, facts, id, reply) {
    var after := writeRow(s, facts, id, reply);
    RowAtMatchesEveryElement(s);
    if os__android__bridge_writeOutcome(reply).Applied? {
      SameIdsKeepKeyed(s, after.state);
      forall i | 0 <= i < |s.rows|
        ensures hasRow(after.state.rows, s.rows[i].id)
      {
        assert after.state.rows[i] in after.state.rows && after.state.rows[i].id == s.rows[i].id;
      }
    }
  }
}

lemma stageDelete_ensures(s: Voicemail, facts: os__android__bridge_HostFacts, id: int)
  ensures (inv(s) ==> canStageDelete(s, facts, id) ==> alwaysRowsKeyedByProviderId(stageDelete(s, facts, id)))
  ensures (inv(s) ==> canStageDelete(s, facts, id) ==> alwaysNoRowsWithoutACarrierThatHasThem(stageDelete(s, facts, id)))
  ensures (inv(s) ==> canStageDelete(s, facts, id) ==> stepAskedAudioIsNeverForgotten(s, stageDelete(s, facts, id)))
  ensures (inv(s) ==> canStageDelete(s, facts, id) ==> stepFetchOnlyForAnUnaskedRow(s, "stageDelete", stageDelete(s, facts, id), []))
  ensures (inv(s) ==> canStageDelete(s, facts, id) ==> stepLocalChangesNeedAnAppliedWrite(s, "stageDelete", stageDelete(s, facts, id), []))
  ensures (inv(s) ==> canStageDelete(s, facts, id) ==> stepStagingADeleteChangesNothing(s, "stageDelete", stageDelete(s, facts, id)))
  ensures (inv(s) ==> canStageDelete(s, facts, id) ==> stepOnlyARefreshReopensTheGate(s, "stageDelete", stageDelete(s, facts, id)))
{
  if inv(s) && canStageDelete(s, facts, id) {
    RowAtMatchesEveryElement(s);
  }
}

lemma lawAQueuedDeleteHidesOnlyItsRow_ensures(rows: seq<VoicemailRow>, queued: seq<int>)
  ensures (lawAQueuedDeleteHidesOnlyItsRow(rows, queued) == true)
{
  var p := (r: VoicemailRow) => !((r.id in queued));
  forall r
    ensures r in shownRows(rows, queued) <==> (r in rows && !(r.id in queued))
  {
    ProofLib.FilterMember(p, rows, r);
    assert (r in shownRows(rows, queued)) == (r in ProofLib.Filter(p, rows));
  }
}
