// A journal whose calls each appear once still has that after an entry for a call it does not hold, once nothing is
// pending.
lemma GenAppendFresh(r: GeneratedRun, after: GeneratedRun, x: JournalEntry)
  requires alwaysCallsJournaledOnce(r) && !journaled(r, x.call)
  requires after.journal == r.journal + [x] && after.pending == ""
  ensures alwaysCallsJournaledOnce(after)
{
  var unseen: JournalEntry -> bool := (e: JournalEntry) => e.call == x.call;
  ProofLib.FilterNone(unseen, r.journal);
  forall e | e in after.journal
    ensures |ProofLib.Filter((o: JournalEntry) => o.call == e.call, after.journal)| == 1
  {
    var same: JournalEntry -> bool := (o: JournalEntry) => o.call == e.call;
    ProofLib.FilterAppend(same, r.journal, x);
    if e in r.journal {
      assert |ProofLib.Filter(same, r.journal)| == 1;
      if x.call == e.call {
        ProofLib.FilterMember(unseen, r.journal, e);
        assert false;
      }
    } else {
      assert e == x;
      ProofLib.FilterNone(same, r.journal);
    }
  }
}

// An entry changes the count of journaled effects by whether it is one.
lemma GenAppendEffects(r: GeneratedRun, after: GeneratedRun, x: JournalEntry)
  requires alwaysEffectsAtMostOnce(r) && after.journal == r.journal + [x] && after.effectsSent == r.effectsSent
  requires (if r.pending != "" then 1 else 0) == (if after.pending != "" then 1 else 0) + (if x.kind.EffectCall? then 1 else 0)
  ensures alwaysEffectsAtMostOnce(after)
{
  var effect: JournalEntry -> bool := (e: JournalEntry) => e.kind.EffectCall?;
  ProofLib.FilterAppend(effect, r.journal, x);
}

lemma checkpointStep_ensures(r: GeneratedRun, call: string, digest: string)
  ensures (inv(r) ==> canCheckpointStep(r, call, digest) ==> alwaysEffectsAtMostOnce(checkpointStep(r, call, digest)))
  ensures (inv(r) ==> canCheckpointStep(r, call, digest) ==> alwaysCallsJournaledOnce(checkpointStep(r, call, digest)))
  ensures (inv(r) ==> canCheckpointStep(r, call, digest) ==> alwaysWaitingHasOneWait(checkpointStep(r, call, digest)))
  ensures (inv(r) ==> canCheckpointStep(r, call, digest) ==> stepEndedRunStaysEnded(r, checkpointStep(r, call, digest)))
{
  if inv(r) && canCheckpointStep(r, call, digest) {
    var x := JournalEntry(call, digest, CallKind.StepCall);
    var after := checkpointStep(r, call, digest);
    GenAppendFresh(r, after, x);
    GenAppendEffects(r, after, x);
  }
}

lemma commitEffect_ensures(r: GeneratedRun)
  ensures (inv(r) ==> canCommitEffect(r) ==> alwaysEffectsAtMostOnce(commitEffect(r)))
  ensures (inv(r) ==> canCommitEffect(r) ==> alwaysCallsJournaledOnce(commitEffect(r)))
  ensures (inv(r) ==> canCommitEffect(r) ==> alwaysWaitingHasOneWait(commitEffect(r)))
  ensures (inv(r) ==> canCommitEffect(r) ==> stepEndedRunStaysEnded(r, commitEffect(r)))
{
  if inv(r) && canCommitEffect(r) {
    var x := JournalEntry(r.pending, r.pendingDigest, CallKind.EffectCall);
    var after := commitEffect(r);
    assert !journaled(r, r.pending);
    GenAppendFresh(r, after, x);
    GenAppendEffects(r, after, x);
  }
}

lemma recoverEffect_ensures(r: GeneratedRun, receiptFound: bool)
  ensures (inv(r) ==> canRecoverEffect(r, receiptFound) ==> alwaysEffectsAtMostOnce(recoverEffect(r, receiptFound)))
  ensures (inv(r) ==> canRecoverEffect(r, receiptFound) ==> alwaysCallsJournaledOnce(recoverEffect(r, receiptFound)))
  ensures (inv(r) ==> canRecoverEffect(r, receiptFound) ==> alwaysWaitingHasOneWait(recoverEffect(r, receiptFound)))
  ensures (inv(r) ==> canRecoverEffect(r, receiptFound) ==> stepEndedRunStaysEnded(r, recoverEffect(r, receiptFound)))
{
  if receiptFound {
    commitEffect_ensures(r);
  }
}

lemma resumeWait_ensures(r: GeneratedRun, call: string, digest: string)
  ensures (inv(r) ==> canResumeWait(r, call, digest) ==> alwaysEffectsAtMostOnce(resumeWait(r, call, digest)))
  ensures (inv(r) ==> canResumeWait(r, call, digest) ==> alwaysCallsJournaledOnce(resumeWait(r, call, digest)))
  ensures (inv(r) ==> canResumeWait(r, call, digest) ==> alwaysWaitingHasOneWait(resumeWait(r, call, digest)))
  ensures (inv(r) ==> canResumeWait(r, call, digest) ==> stepEndedRunStaysEnded(r, resumeWait(r, call, digest)))
{
  if inv(r) && canResumeWait(r, call, digest) {
    var x := JournalEntry(call, digest, waitKind(r.wait));
    assert !journaled(r, waitCall(r.wait)) && r.pending == "";
    assert !x.kind.EffectCall?;
    var after := resumeWait(r, call, digest);
    GenAppendFresh(r, after, x);
    GenAppendEffects(r, after, x);
  }
}
