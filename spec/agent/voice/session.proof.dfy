lemma captureFailed_ensures(s: VoiceSession)
  ensures (inv(s) ==> canCaptureFailed(s) ==> alwaysTheSessionOwnsItsCapture(captureFailed(s)))
  ensures (inv(s) ==> canCaptureFailed(s) ==> alwaysAHeldMicrophoneStaysClosedDuringItsTurn(captureFailed(s)))
  ensures (inv(s) ==> canCaptureFailed(s) ==> alwaysAnUnreleasedCaptureEndedItsSession(captureFailed(s)))
  ensures (inv(s) ==> canCaptureFailed(s) ==> alwaysTheProfileIsWithinItsBounds(captureFailed(s)))
  ensures (inv(s) ==> canCaptureFailed(s) ==> alwaysAGapWaitsForTextAndNoTurn(captureFailed(s)))
  ensures (inv(s) ==> canCaptureFailed(s) ==> alwaysDictationNeverSubmits(captureFailed(s)))
  ensures (inv(s) ==> canCaptureFailed(s) ==> alwaysACandidateInterruptsASentTurn(captureFailed(s)))
  ensures (inv(s) ==> canCaptureFailed(s) ==> alwaysACarriedTurnIsTheLastSentAndWaitsToGoOutAgain(captureFailed(s)))
  ensures (inv(s) ==> canCaptureFailed(s) ==> alwaysOneReportPerPlayedReply(captureFailed(s)))
  ensures (inv(s) ==> canCaptureFailed(s) ==> alwaysAReportIsPostedAtMostTwice(captureFailed(s)))
  ensures (inv(s) ==> canCaptureFailed(s) ==> stepNothingOpensOverAnUnreleasedCapture(s, captureFailed(s)))
  ensures (inv(s) ==> canCaptureFailed(s) ==> stepTheProfileChangesOnlyAtStart(s, "captureFailed", captureFailed(s)))
  ensures (inv(s) ==> canCaptureFailed(s) ==> stepTheEpochOnlyAdvances(s, "captureFailed", captureFailed(s)))
  ensures (inv(s) ==> canCaptureFailed(s) ==> stepASubmissionNamesItsCause(s, "captureFailed", captureFailed(s)))
  ensures (inv(s) ==> canCaptureFailed(s) ==> stepATurnIsSentOnce(s, "captureFailed", captureFailed(s)))
  ensures (inv(s) ==> canCaptureFailed(s) ==> stepATurnTakenBackBeforeItsReplyIsCarried(s, "captureFailed", captureFailed(s)))
  ensures (inv(s) ==> canCaptureFailed(s) ==> stepOnlyTheNextTurnNamesTheOneItReplaces(s, "captureFailed", captureFailed(s)))
  ensures (inv(s) ==> canCaptureFailed(s) ==> stepStopReportsOnlyWhenTheProfileAsks(s, "captureFailed", captureFailed(s)))
{
  if inv(s) && canCaptureFailed(s) {
    SessionEnds(s, captureFailed(s));
  }
}

lemma stop_ensures(s: VoiceSession)
  ensures (inv(s) ==> canStop(s) ==> alwaysTheSessionOwnsItsCapture(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysAHeldMicrophoneStaysClosedDuringItsTurn(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysAnUnreleasedCaptureEndedItsSession(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysTheProfileIsWithinItsBounds(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysAGapWaitsForTextAndNoTurn(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysDictationNeverSubmits(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysACandidateInterruptsASentTurn(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysACarriedTurnIsTheLastSentAndWaitsToGoOutAgain(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysOneReportPerPlayedReply(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysAReportIsPostedAtMostTwice(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> stepNothingOpensOverAnUnreleasedCapture(s, stop(s)))
  ensures (inv(s) ==> canStop(s) ==> stepTheProfileChangesOnlyAtStart(s, "stop", stop(s)))
  ensures (inv(s) ==> canStop(s) ==> stepTheEpochOnlyAdvances(s, "stop", stop(s)))
  ensures (inv(s) ==> canStop(s) ==> stepASubmissionNamesItsCause(s, "stop", stop(s)))
  ensures (inv(s) ==> canStop(s) ==> stepATurnIsSentOnce(s, "stop", stop(s)))
  ensures (inv(s) ==> canStop(s) ==> stepATurnTakenBackBeforeItsReplyIsCarried(s, "stop", stop(s)))
  ensures (inv(s) ==> canStop(s) ==> stepOnlyTheNextTurnNamesTheOneItReplaces(s, "stop", stop(s)))
  ensures (inv(s) ==> canStop(s) ==> stepStopReportsOnlyWhenTheProfileAsks(s, "stop", stop(s)))
{
  if inv(s) && canStop(s) {
    SessionEnds(s, stop(s));
  }
}

lemma finalTranscript_ensures(s: VoiceSession, heard: HeardTurn)
  ensures (inv(s) ==> canFinalTranscript(s) ==> alwaysTheSessionOwnsItsCapture(finalTranscript(s, heard)))
  ensures (inv(s) ==> canFinalTranscript(s) ==> alwaysAHeldMicrophoneStaysClosedDuringItsTurn(finalTranscript(s, heard)))
  ensures (inv(s) ==> canFinalTranscript(s) ==> alwaysAnUnreleasedCaptureEndedItsSession(finalTranscript(s, heard)))
  ensures (inv(s) ==> canFinalTranscript(s) ==> alwaysTheProfileIsWithinItsBounds(finalTranscript(s, heard)))
  ensures (inv(s) ==> canFinalTranscript(s) ==> alwaysAGapWaitsForTextAndNoTurn(finalTranscript(s, heard)))
  ensures (inv(s) ==> canFinalTranscript(s) ==> alwaysDictationNeverSubmits(finalTranscript(s, heard)))
  ensures (inv(s) ==> canFinalTranscript(s) ==> alwaysACandidateInterruptsASentTurn(finalTranscript(s, heard)))
  ensures (inv(s) ==> canFinalTranscript(s) ==> alwaysACarriedTurnIsTheLastSentAndWaitsToGoOutAgain(finalTranscript(s, heard)))
  ensures (inv(s) ==> canFinalTranscript(s) ==> alwaysOneReportPerPlayedReply(finalTranscript(s, heard)))
  ensures (inv(s) ==> canFinalTranscript(s) ==> alwaysAReportIsPostedAtMostTwice(finalTranscript(s, heard)))
  ensures (inv(s) ==> canFinalTranscript(s) ==> stepNothingOpensOverAnUnreleasedCapture(s, finalTranscript(s, heard)))
  ensures (inv(s) ==> canFinalTranscript(s) ==> stepTheProfileChangesOnlyAtStart(s, "finalTranscript", finalTranscript(s, heard)))
  ensures (inv(s) ==> canFinalTranscript(s) ==> stepTheEpochOnlyAdvances(s, "finalTranscript", finalTranscript(s, heard)))
  ensures (inv(s) ==> canFinalTranscript(s) ==> stepASubmissionNamesItsCause(s, "finalTranscript", finalTranscript(s, heard)))
  ensures (inv(s) ==> canFinalTranscript(s) ==> stepATurnIsSentOnce(s, "finalTranscript", finalTranscript(s, heard)))
  ensures (inv(s) ==> canFinalTranscript(s) ==> stepATurnTakenBackBeforeItsReplyIsCarried(s, "finalTranscript", finalTranscript(s, heard)))
  ensures (inv(s) ==> canFinalTranscript(s) ==> stepOnlyTheNextTurnNamesTheOneItReplaces(s, "finalTranscript", finalTranscript(s, heard)))
  ensures (inv(s) ==> canFinalTranscript(s) ==> stepStopReportsOnlyWhenTheProfileAsks(s, "finalTranscript", finalTranscript(s, heard)))
{
  if inv(s) && canFinalTranscript(s) {
    var accepted := turnAccepted(heard.(agentSpeaking := s.turn.Playing?));
    if !s.mode.DictationMode? && s.bargeIn && accepted {
      SessionEnds(s, finalTranscript(s, heard));
    }
  }
}

lemma bargeInHeld_ensures(s: VoiceSession, heldMs: int)
  ensures (inv(s) ==> canBargeInHeld(s, heldMs) ==> alwaysTheSessionOwnsItsCapture(bargeInHeld(s, heldMs)))
  ensures (inv(s) ==> canBargeInHeld(s, heldMs) ==> alwaysAHeldMicrophoneStaysClosedDuringItsTurn(bargeInHeld(s, heldMs)))
  ensures (inv(s) ==> canBargeInHeld(s, heldMs) ==> alwaysAnUnreleasedCaptureEndedItsSession(bargeInHeld(s, heldMs)))
  ensures (inv(s) ==> canBargeInHeld(s, heldMs) ==> alwaysTheProfileIsWithinItsBounds(bargeInHeld(s, heldMs)))
  ensures (inv(s) ==> canBargeInHeld(s, heldMs) ==> alwaysAGapWaitsForTextAndNoTurn(bargeInHeld(s, heldMs)))
  ensures (inv(s) ==> canBargeInHeld(s, heldMs) ==> alwaysDictationNeverSubmits(bargeInHeld(s, heldMs)))
  ensures (inv(s) ==> canBargeInHeld(s, heldMs) ==> alwaysACandidateInterruptsASentTurn(bargeInHeld(s, heldMs)))
  ensures (inv(s) ==> canBargeInHeld(s, heldMs) ==> alwaysACarriedTurnIsTheLastSentAndWaitsToGoOutAgain(bargeInHeld(s, heldMs)))
  ensures (inv(s) ==> canBargeInHeld(s, heldMs) ==> alwaysOneReportPerPlayedReply(bargeInHeld(s, heldMs)))
  ensures (inv(s) ==> canBargeInHeld(s, heldMs) ==> alwaysAReportIsPostedAtMostTwice(bargeInHeld(s, heldMs)))
  ensures (inv(s) ==> canBargeInHeld(s, heldMs) ==> stepNothingOpensOverAnUnreleasedCapture(s, bargeInHeld(s, heldMs)))
  ensures (inv(s) ==> canBargeInHeld(s, heldMs) ==> stepTheProfileChangesOnlyAtStart(s, "bargeInHeld", bargeInHeld(s, heldMs)))
  ensures (inv(s) ==> canBargeInHeld(s, heldMs) ==> stepTheEpochOnlyAdvances(s, "bargeInHeld", bargeInHeld(s, heldMs)))
  ensures (inv(s) ==> canBargeInHeld(s, heldMs) ==> stepASubmissionNamesItsCause(s, "bargeInHeld", bargeInHeld(s, heldMs)))
  ensures (inv(s) ==> canBargeInHeld(s, heldMs) ==> stepATurnIsSentOnce(s, "bargeInHeld", bargeInHeld(s, heldMs)))
  ensures (inv(s) ==> canBargeInHeld(s, heldMs) ==> stepATurnTakenBackBeforeItsReplyIsCarried(s, "bargeInHeld", bargeInHeld(s, heldMs)))
  ensures (inv(s) ==> canBargeInHeld(s, heldMs) ==> stepOnlyTheNextTurnNamesTheOneItReplaces(s, "bargeInHeld", bargeInHeld(s, heldMs)))
  ensures (inv(s) ==> canBargeInHeld(s, heldMs) ==> stepStopReportsOnlyWhenTheProfileAsks(s, "bargeInHeld", bargeInHeld(s, heldMs)))
{
  if inv(s) && canBargeInHeld(s, heldMs) {
    SessionEnds(s, bargeInHeld(s, heldMs));
  }
}

lemma playbackBroke_ensures(s: VoiceSession)
  ensures (inv(s) ==> canPlaybackBroke(s) ==> alwaysTheSessionOwnsItsCapture(playbackBroke(s)))
  ensures (inv(s) ==> canPlaybackBroke(s) ==> alwaysAHeldMicrophoneStaysClosedDuringItsTurn(playbackBroke(s)))
  ensures (inv(s) ==> canPlaybackBroke(s) ==> alwaysAnUnreleasedCaptureEndedItsSession(playbackBroke(s)))
  ensures (inv(s) ==> canPlaybackBroke(s) ==> alwaysTheProfileIsWithinItsBounds(playbackBroke(s)))
  ensures (inv(s) ==> canPlaybackBroke(s) ==> alwaysAGapWaitsForTextAndNoTurn(playbackBroke(s)))
  ensures (inv(s) ==> canPlaybackBroke(s) ==> alwaysDictationNeverSubmits(playbackBroke(s)))
  ensures (inv(s) ==> canPlaybackBroke(s) ==> alwaysACandidateInterruptsASentTurn(playbackBroke(s)))
  ensures (inv(s) ==> canPlaybackBroke(s) ==> alwaysACarriedTurnIsTheLastSentAndWaitsToGoOutAgain(playbackBroke(s)))
  ensures (inv(s) ==> canPlaybackBroke(s) ==> alwaysOneReportPerPlayedReply(playbackBroke(s)))
  ensures (inv(s) ==> canPlaybackBroke(s) ==> alwaysAReportIsPostedAtMostTwice(playbackBroke(s)))
  ensures (inv(s) ==> canPlaybackBroke(s) ==> stepNothingOpensOverAnUnreleasedCapture(s, playbackBroke(s)))
  ensures (inv(s) ==> canPlaybackBroke(s) ==> stepTheProfileChangesOnlyAtStart(s, "playbackBroke", playbackBroke(s)))
  ensures (inv(s) ==> canPlaybackBroke(s) ==> stepTheEpochOnlyAdvances(s, "playbackBroke", playbackBroke(s)))
  ensures (inv(s) ==> canPlaybackBroke(s) ==> stepASubmissionNamesItsCause(s, "playbackBroke", playbackBroke(s)))
  ensures (inv(s) ==> canPlaybackBroke(s) ==> stepATurnIsSentOnce(s, "playbackBroke", playbackBroke(s)))
  ensures (inv(s) ==> canPlaybackBroke(s) ==> stepATurnTakenBackBeforeItsReplyIsCarried(s, "playbackBroke", playbackBroke(s)))
  ensures (inv(s) ==> canPlaybackBroke(s) ==> stepOnlyTheNextTurnNamesTheOneItReplaces(s, "playbackBroke", playbackBroke(s)))
  ensures (inv(s) ==> canPlaybackBroke(s) ==> stepStopReportsOnlyWhenTheProfileAsks(s, "playbackBroke", playbackBroke(s)))
{
  if inv(s) && canPlaybackBroke(s) {
    SessionEnds(s, playbackBroke(s));
  }
}

lemma dispatchHeard_ensures(s: VoiceSession, reply: int, waitedMs: int)
  ensures (inv(s) ==> canDispatchHeard(s, reply, waitedMs) ==> alwaysTheSessionOwnsItsCapture(dispatchHeard(s, reply, waitedMs)))
  ensures (inv(s) ==> canDispatchHeard(s, reply, waitedMs) ==> alwaysAHeldMicrophoneStaysClosedDuringItsTurn(dispatchHeard(s, reply, waitedMs)))
  ensures (inv(s) ==> canDispatchHeard(s, reply, waitedMs) ==> alwaysAnUnreleasedCaptureEndedItsSession(dispatchHeard(s, reply, waitedMs)))
  ensures (inv(s) ==> canDispatchHeard(s, reply, waitedMs) ==> alwaysTheProfileIsWithinItsBounds(dispatchHeard(s, reply, waitedMs)))
  ensures (inv(s) ==> canDispatchHeard(s, reply, waitedMs) ==> alwaysAGapWaitsForTextAndNoTurn(dispatchHeard(s, reply, waitedMs)))
  ensures (inv(s) ==> canDispatchHeard(s, reply, waitedMs) ==> alwaysDictationNeverSubmits(dispatchHeard(s, reply, waitedMs)))
  ensures (inv(s) ==> canDispatchHeard(s, reply, waitedMs) ==> alwaysACandidateInterruptsASentTurn(dispatchHeard(s, reply, waitedMs)))
  ensures (inv(s) ==> canDispatchHeard(s, reply, waitedMs) ==> alwaysACarriedTurnIsTheLastSentAndWaitsToGoOutAgain(dispatchHeard(s, reply, waitedMs)))
  ensures (inv(s) ==> canDispatchHeard(s, reply, waitedMs) ==> alwaysOneReportPerPlayedReply(dispatchHeard(s, reply, waitedMs)))
  ensures (inv(s) ==> canDispatchHeard(s, reply, waitedMs) ==> alwaysAReportIsPostedAtMostTwice(dispatchHeard(s, reply, waitedMs)))
  ensures (inv(s) ==> canDispatchHeard(s, reply, waitedMs) ==> stepNothingOpensOverAnUnreleasedCapture(s, dispatchHeard(s, reply, waitedMs)))
  ensures (inv(s) ==> canDispatchHeard(s, reply, waitedMs) ==> stepTheProfileChangesOnlyAtStart(s, "dispatchHeard", dispatchHeard(s, reply, waitedMs)))
  ensures (inv(s) ==> canDispatchHeard(s, reply, waitedMs) ==> stepTheEpochOnlyAdvances(s, "dispatchHeard", dispatchHeard(s, reply, waitedMs)))
  ensures (inv(s) ==> canDispatchHeard(s, reply, waitedMs) ==> stepASubmissionNamesItsCause(s, "dispatchHeard", dispatchHeard(s, reply, waitedMs)))
  ensures (inv(s) ==> canDispatchHeard(s, reply, waitedMs) ==> stepATurnIsSentOnce(s, "dispatchHeard", dispatchHeard(s, reply, waitedMs)))
  ensures (inv(s) ==> canDispatchHeard(s, reply, waitedMs) ==> stepATurnTakenBackBeforeItsReplyIsCarried(s, "dispatchHeard", dispatchHeard(s, reply, waitedMs)))
  ensures (inv(s) ==> canDispatchHeard(s, reply, waitedMs) ==> stepOnlyTheNextTurnNamesTheOneItReplaces(s, "dispatchHeard", dispatchHeard(s, reply, waitedMs)))
  ensures (inv(s) ==> canDispatchHeard(s, reply, waitedMs) ==> stepStopReportsOnlyWhenTheProfileAsks(s, "dispatchHeard", dispatchHeard(s, reply, waitedMs)))
{
  if inv(s) && canDispatchHeard(s, reply, waitedMs) {
    SessionPointwise(s, dispatchHeard(s, reply, waitedMs));
  }
}

lemma heardAnswered_ensures(s: VoiceSession, reply: int, status: int, body: HeardBody)
  ensures (inv(s) ==> canHeardAnswered(s, reply) ==> alwaysTheSessionOwnsItsCapture(heardAnswered(s, reply, status, body)))
  ensures (inv(s) ==> canHeardAnswered(s, reply) ==> alwaysAHeldMicrophoneStaysClosedDuringItsTurn(heardAnswered(s, reply, status, body)))
  ensures (inv(s) ==> canHeardAnswered(s, reply) ==> alwaysAnUnreleasedCaptureEndedItsSession(heardAnswered(s, reply, status, body)))
  ensures (inv(s) ==> canHeardAnswered(s, reply) ==> alwaysTheProfileIsWithinItsBounds(heardAnswered(s, reply, status, body)))
  ensures (inv(s) ==> canHeardAnswered(s, reply) ==> alwaysAGapWaitsForTextAndNoTurn(heardAnswered(s, reply, status, body)))
  ensures (inv(s) ==> canHeardAnswered(s, reply) ==> alwaysDictationNeverSubmits(heardAnswered(s, reply, status, body)))
  ensures (inv(s) ==> canHeardAnswered(s, reply) ==> alwaysACandidateInterruptsASentTurn(heardAnswered(s, reply, status, body)))
  ensures (inv(s) ==> canHeardAnswered(s, reply) ==> alwaysACarriedTurnIsTheLastSentAndWaitsToGoOutAgain(heardAnswered(s, reply, status, body)))
  ensures (inv(s) ==> canHeardAnswered(s, reply) ==> alwaysOneReportPerPlayedReply(heardAnswered(s, reply, status, body)))
  ensures (inv(s) ==> canHeardAnswered(s, reply) ==> alwaysAReportIsPostedAtMostTwice(heardAnswered(s, reply, status, body)))
  ensures (inv(s) ==> canHeardAnswered(s, reply) ==> stepNothingOpensOverAnUnreleasedCapture(s, heardAnswered(s, reply, status, body)))
  ensures (inv(s) ==> canHeardAnswered(s, reply) ==> stepTheProfileChangesOnlyAtStart(s, "heardAnswered", heardAnswered(s, reply, status, body)))
  ensures (inv(s) ==> canHeardAnswered(s, reply) ==> stepTheEpochOnlyAdvances(s, "heardAnswered", heardAnswered(s, reply, status, body)))
  ensures (inv(s) ==> canHeardAnswered(s, reply) ==> stepASubmissionNamesItsCause(s, "heardAnswered", heardAnswered(s, reply, status, body)))
  ensures (inv(s) ==> canHeardAnswered(s, reply) ==> stepATurnIsSentOnce(s, "heardAnswered", heardAnswered(s, reply, status, body)))
  ensures (inv(s) ==> canHeardAnswered(s, reply) ==> stepATurnTakenBackBeforeItsReplyIsCarried(s, "heardAnswered", heardAnswered(s, reply, status, body)))
  ensures (inv(s) ==> canHeardAnswered(s, reply) ==> stepOnlyTheNextTurnNamesTheOneItReplaces(s, "heardAnswered", heardAnswered(s, reply, status, body)))
  ensures (inv(s) ==> canHeardAnswered(s, reply) ==> stepStopReportsOnlyWhenTheProfileAsks(s, "heardAnswered", heardAnswered(s, reply, status, body)))
{
  if inv(s) && canHeardAnswered(s, reply) {
    SessionPointwise(s, heardAnswered(s, reply, status, body));
  }
}

// spec/agent/voice/session.md: each played reply holds at most one heard report.
lemma SessionReportFilter(s: VoiceSession)
  ensures alwaysOneReportPerPlayedReply(s) == (((s.reply >= 0) && (if s.turn.Playing? then (((s.reply >= 1) && (s.played >= 0)) && (s.played < s.segments)) else ((s.segments == 0) && (s.played == 0)))) && !((exists r :: r in s.receipts && !(((((r.reply >= 1) && (r.reply <= s.reply)) && (|ProofLib.Filter((q: HeardReceipt) => (q.reply == r.reply), s.receipts)| == 1)) && (!(s.turn.Playing?) || (r.reply < s.reply)))))))
{
}

// spec/agent/voice/session.md: a turn that ends reserves the report of the reply it played.
lemma SessionEnds(s: VoiceSession, t: VoiceSession)
  requires alwaysOneReportPerPlayedReply(s)
  requires !t.turn.Playing? && t.segments == 0 && t.played == 0 && t.reply == s.reply
  requires t.receipts == s.receipts || (s.turn.Playing? && t.receipts == reserved(s))
  ensures alwaysOneReportPerPlayedReply(t)
{
  SessionReportFilter(s);
  SessionReportFilter(t);
  if t.receipts != s.receipts {
    var n := HeardReceipt(s.reply, 0, ReportPhase.ReportDue, (s.played == 0));
    assert t.receipts == s.receipts + [n];
    forall r | r in t.receipts
      ensures r.reply >= 1 && r.reply <= t.reply
      ensures |ProofLib.Filter((q: HeardReceipt) => (q.reply == r.reply), t.receipts)| == 1
    {
      var p := (q: HeardReceipt) => (q.reply == r.reply);
      ProofLib.FilterAppend(p, s.receipts, n);
      if r in s.receipts {
        assert r.reply < s.reply;
      } else {
        assert r == n;
        forall i | 0 <= i < |s.receipts| ensures !p(s.receipts[i]) {
          assert s.receipts[i] in s.receipts;
        }
        ProofLib.FilterNone(p, s.receipts);
      }
    }
  }
}

// spec/agent/voice/session.md: posting and answering a report never changes which reply it is for.
lemma SessionPointwise(s: VoiceSession, t: VoiceSession)
  requires alwaysOneReportPerPlayedReply(s)
  requires t.turn == s.turn && t.reply == s.reply && t.segments == s.segments && t.played == s.played
  requires |t.receipts| == |s.receipts| && forall i :: 0 <= i < |s.receipts| ==> t.receipts[i].reply == s.receipts[i].reply
  ensures alwaysOneReportPerPlayedReply(t)
{
  SessionReportFilter(s);
  SessionReportFilter(t);
  forall r | r in t.receipts
    ensures r.reply >= 1 && r.reply <= t.reply && (!(t.turn.Playing?) || (r.reply < t.reply))
    ensures |ProofLib.Filter((q: HeardReceipt) => (q.reply == r.reply), t.receipts)| == 1
  {
    var i :| 0 <= i < |t.receipts| && t.receipts[i] == r;
    var o := s.receipts[i];
    assert o in s.receipts;
    ProofLib.FilterLengthPointwise((q: HeardReceipt) => (q.reply == r.reply), (q: HeardReceipt) => (q.reply == o.reply), t.receipts, s.receipts);
  }
}
