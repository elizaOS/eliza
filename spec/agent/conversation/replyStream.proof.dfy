lemma restartText_ensures(s: ReplyStream, units: seq<int>, provisional: bool)
  ensures (inv(s) ==> canRestartText(s) ==> alwaysOnlyAStreamingTurnCarriesText(restartText(s, units, provisional).state))
  ensures (inv(s) ==> canRestartText(s) ==> alwaysCaughtUpWhenFree(restartText(s, units, provisional).state))
  ensures (inv(s) ==> canRestartText(s) ==> alwaysSnapshotCadence(restartText(s, units, provisional).state))
  ensures (inv(s) ==> canRestartText(s) ==> alwaysAnAnnouncedReplyEndsAnswered(restartText(s, units, provisional).state))
  ensures (inv(s) ==> canRestartText(s) ==> stepOneFrameInFlight(s, "restartText", restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepFramesRebuildTheText(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepAppendsNeverClearTheMark(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepMarkFollowsTheText(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepOnlyARestartShortensTheText(s, "restartText", restartText(s, units, provisional).state))
  ensures (inv(s) ==> canRestartText(s) ==> stepCadenceSnapshotsAtLeastDouble(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepProgressNeverTouchesTheText(s, "restartText", restartText(s, units, provisional).state))
  ensures (inv(s) ==> canRestartText(s) ==> stepAcknowledgedAtMostOnce(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepAcknowledgingNeverTouchesTheText(s, "restartText", restartText(s, units, provisional).state))
  ensures (inv(s) ==> canRestartText(s) ==> stepReadyAtMostOnce(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepNothingAfterTheEnd(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "restartText", restartText(s, units, provisional).state, restartText(s, units, provisional).out))
{
  ReplyStreamRestartReadiness(s, units, provisional);
  ReplyStreamRestartOutput(s, units, provisional);
  ReplyStreamRestartAck(s, units, provisional);
}

lemma {:induction false} ReplyStreamWriteNextAck(left: bool, x: ReplyStream)
  ensures (if !(x.inFlight && !left) && x.phase.Open? && ackWaiting(x.ack) then
      writeNext(left, x) == StreamStep(x.(inFlight := true, ack := AckSent), [Write(AckFrame(x.ack.cue))])
    else
      writeNext(left, x).state.ack == x.ack && !(exists f :: f in written(writeNext(left, x).out) && isAckFrame(f)))
{
  hide *;
  reveal writeNext();
  reveal isOpen();
  reveal isFinishing();
  reveal ackWaiting();
  reveal ackFrame();
  var r := writeNext(left, x);
  var free := x.(inFlight := (x.inFlight && !left));
  if free.inFlight || (!isFinishing(free.phase) && !isOpen(free.phase)) {
    assert r.out == [] && r.state.ack == x.ack;
    assert written(r.out) == [] by {
      reveal written();
      reveal Std.Collections.Seq.FoldLeft();
    }
    assert !(exists f :: f in written(r.out) && isAckFrame(f));
  } else if isFinishing(free.phase) {
    var e := ending(free.phase);
    assert r.out == [Write(Final(e))] && r.state.ack == x.ack;
    ReplyStreamTerminalFoldLeftWrites(Final(e));
    assert !isAckFrame(Final(e)) by { reveal isAckFrame(); }
    assert !(exists f :: f in written(r.out) && isAckFrame(f));
  } else if ackWaiting(free.ack) {
    assert r == StreamStep(x.(inFlight := true, ack := AckSent), [Write(AckFrame(x.ack.cue))]);
  } else if textPending(free) {
    var frame := textFrame(free);
    assert r.out == [Write(frame)] && r.state.ack == x.ack;
    ReplyStreamTerminalFoldLeftWrites(frame);
    assert !isAckFrame(frame) by {
      reveal textFrame();
      reveal isAckFrame();
    }
    assert !(exists f :: f in written(r.out) && isAckFrame(f));
  } else if readyPending(free.ready) {
    var frame := readyFrame(free.ready);
    assert r.out == [Write(frame)] && r.state.ack == x.ack;
    ReplyStreamTerminalFoldLeftWrites(frame);
    assert !isAckFrame(frame) by {
      reveal readyFrame();
      reveal isAckFrame();
    }
    assert !(exists f :: f in written(r.out) && isAckFrame(f));
  } else if !free.progress.NoProgress? {
    var frame := Progressed(free.progress);
    assert r.out == [Write(frame)] && r.state.ack == x.ack;
    ReplyStreamTerminalFoldLeftWrites(frame);
    assert !isAckFrame(frame) by { reveal isAckFrame(); }
    assert !(exists f :: f in written(r.out) && isAckFrame(f));
  } else {
    assert r.out == [] && r.state.ack == x.ack;
    assert written(r.out) == [] by {
      reveal written();
      reveal Std.Collections.Seq.FoldLeft();
    }
    assert !(exists f :: f in written(r.out) && isAckFrame(f));
  }
}

lemma {:induction false} ReplyStreamAckKept(before: ReplyStream, via: string, after: ReplyStream, out: seq<Effect>)
  requires after.ack == before.ack
  requires !(exists f :: f in written(out) && isAckFrame(f))
  requires via != "acknowledge"
  ensures stepAcknowledgingNeverTouchesTheText(before, via, after)
  ensures stepAcknowledgedAtMostOnce(before, after, out)
  ensures stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(before, after, out)
{
  hide *;
  reveal stepAcknowledgingNeverTouchesTheText();
  reveal stepAcknowledgedAtMostOnce();
  reveal stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame();
}

lemma {:induction false} ReplyStreamRestartAck(s: ReplyStream, units: seq<int>, provisional: bool)
  ensures (inv(s) ==> canRestartText(s) ==> stepAcknowledgingNeverTouchesTheText(s, "restartText", restartText(s, units, provisional).state))
  ensures (inv(s) ==> canRestartText(s) ==> stepAcknowledgedAtMostOnce(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
{
  hide *;
  if inv(s) && canRestartText(s) {
    var next := s.(text := units, held := provisional);
    var result := restartText(s, units, provisional);
    assert result == writeNext(false, next) by { reveal restartText(); }
    if !s.inFlight {
      assert !ackWaiting(next.ack) by {
        reveal inv();
        reveal canRestartText();
        reveal alwaysCaughtUpWhenFree();
        reveal isOpen();
      }
    }
    ReplyStreamWriteNextAck(false, next);
    assert result.state.ack == s.ack && !(exists f :: f in written(result.out) && isAckFrame(f));
    ReplyStreamAckKept(s, "restartText", result.state, result.out);
  }
}

lemma finish_ensures(s: ReplyStream, reply: int, units: seq<int>, kind: agent__conversation__turns_ReplyKind, results: int)
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> alwaysOnlyAStreamingTurnCarriesText(finish(s, reply, units, kind, results).state))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> alwaysCaughtUpWhenFree(finish(s, reply, units, kind, results).state))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> alwaysSnapshotCadence(finish(s, reply, units, kind, results).state))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> alwaysAnAnnouncedReplyEndsAnswered(finish(s, reply, units, kind, results).state))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepOneFrameInFlight(s, "finish", finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepFramesRebuildTheText(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepAppendsNeverClearTheMark(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepMarkFollowsTheText(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepOnlyARestartShortensTheText(s, "finish", finish(s, reply, units, kind, results).state))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepCadenceSnapshotsAtLeastDouble(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepProgressNeverTouchesTheText(s, "finish", finish(s, reply, units, kind, results).state))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepAcknowledgedAtMostOnce(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepAcknowledgingNeverTouchesTheText(s, "finish", finish(s, reply, units, kind, results).state))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepReadyAtMostOnce(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepNothingAfterTheEnd(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "finish", finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
{
  hide *;
  ReplyStreamState_finish_ensures(s, reply, units, kind, results);
  ReplyStreamDelivery_finish_ensures(s, reply, units, kind, results);
  ReplyStreamMarks_finish_ensures(s, reply, units, kind, results);
  ReplyStreamReadiness_finish_ensures(s, reply, units, kind, results);
  CombinedReplyStreamClause27_finish_ensures(s, reply, units, kind, results);
  ReplyStreamAck_finish_ensures(s, reply, units, kind, results);
}

lemma answerError_ensures(s: ReplyStream, code: string)
  ensures (inv(s) ==> canAnswerError(s, code) ==> alwaysOnlyAStreamingTurnCarriesText(answerError(s, code).state))
  ensures (inv(s) ==> canAnswerError(s, code) ==> alwaysCaughtUpWhenFree(answerError(s, code).state))
  ensures (inv(s) ==> canAnswerError(s, code) ==> alwaysSnapshotCadence(answerError(s, code).state))
  ensures (inv(s) ==> canAnswerError(s, code) ==> alwaysAnAnnouncedReplyEndsAnswered(answerError(s, code).state))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepOneFrameInFlight(s, "answerError", answerError(s, code).state, answerError(s, code).out))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepFramesRebuildTheText(s, answerError(s, code).state, answerError(s, code).out))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepAppendsNeverClearTheMark(s, answerError(s, code).state, answerError(s, code).out))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepMarkFollowsTheText(s, answerError(s, code).state, answerError(s, code).out))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepOnlyARestartShortensTheText(s, "answerError", answerError(s, code).state))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepCadenceSnapshotsAtLeastDouble(s, answerError(s, code).state, answerError(s, code).out))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepProgressNeverTouchesTheText(s, "answerError", answerError(s, code).state))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepAcknowledgedAtMostOnce(s, answerError(s, code).state, answerError(s, code).out))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, answerError(s, code).state, answerError(s, code).out))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepAcknowledgingNeverTouchesTheText(s, "answerError", answerError(s, code).state))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepReadyAtMostOnce(s, answerError(s, code).state, answerError(s, code).out))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepNothingAfterTheEnd(s, answerError(s, code).state, answerError(s, code).out))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "answerError", answerError(s, code).state, answerError(s, code).out))
{
  var end := Errored(code);
  var next := s.(progress := Progress.NoProgress, phase := Finishing(end));
  ReplyStreamTerminalWrite(next, end);
  assert answerError(s, code) == writeNext(false, next);
  ReplyStreamAckKept(s, "answerError", writeNext(false, next).state, writeNext(false, next).out);
}

lemma {:induction false} ReplyStreamTerminalFoldLeftSingleton<A, T>(f: (A, T) -> A, init: A, x: T)
  ensures Std.Collections.Seq.FoldLeft(f, init, [x]) == f(init, x)
{
  reveal Std.Collections.Seq.FoldLeft();
  assert [x][0] == x;
  assert [x][1..] == [];
  assert Std.Collections.Seq.FoldLeft(f, f(init, x), []) == f(init, x);
}

lemma {:induction false} ReplyStreamTerminalFoldLeftWrites(frame: Frame)
  ensures written([Write(frame)]) == [frame]
{
  hide *;
  reveal written();
  ReplyStreamTerminalFoldLeftSingleton((acc: seq<Frame>, e: Effect) => (if e.Write? then (acc + [e.frame]) else acc), [], Write(frame));
}

lemma {:induction false} ReplyStreamTerminalFoldLeftApplies(shown: seq<int>, frame: Frame)
  ensures rebuilt(shown, [Write(frame)]) == applyFrame(shown, frame)
{
  hide *;
  reveal rebuilt();
  ReplyStreamTerminalFoldLeftWrites(frame);
  ReplyStreamTerminalFoldLeftSingleton((acc: seq<int>, f: Frame) => applyFrame(acc, f), shown, frame);
}

lemma {:induction false} ReplyStreamRestartReadiness(s: ReplyStream, units: seq<int>, provisional: bool)
  ensures (inv(s) ==> canRestartText(s) ==> stepReadyAtMostOnce(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
{
  hide *;
  reveal inv();
  reveal canRestartText();
  reveal isOpen();
  reveal isFinishing();
  reveal alwaysCaughtUpWhenFree();
  reveal readyPending();
  reveal restartText();
  reveal writeNext();
  reveal stepReadyAtMostOnce();
  if inv(s) && canRestartText(s) {
    var next := s.(text := units, held := provisional);
    var result := restartText(s, units, provisional);
    assert next.phase.Open?;
    assert result == writeNext(false, next);
    if s.inFlight {
      assert result == StreamStep(next, []);
    } else {
      assert alwaysCaughtUpWhenFree(s);
      assert !readyPending(next.ready) && next.progress.NoProgress?;
      assert !ackWaiting(next.ack);
      reveal textPending();
      if textPending(next) {
        var frame := textFrame(next);
        assert result.out == [Write(frame)];
        assert !isReadyFrame(frame) by {
          reveal textFrame();
          reveal isReadyFrame();
        }
        ReplyStreamTerminalFoldLeftWrites(frame);
        assert written(result.out) == [frame];
        assert !(exists f :: f in written(result.out) && isReadyFrame(f)) by {
          forall f | f in written(result.out)
            ensures !isReadyFrame(f)
          {
            assert f == frame;
          }
        }
      } else {
        assert result.out == [];
      }
    }
    assert result.state.ready == s.ready;
    if result.out == [] {
      assert written(result.out) == [] by {
        reveal written();
        reveal Std.Collections.Seq.FoldLeft();
      }
    }
    assert !(exists f :: f in written(result.out) && isReadyFrame(f));
  }
}

lemma {:induction false} ReplyStreamSliceFold(xs: seq<int>, offset: int, start: int, end: int, acc: seq<int>)
  requires 0 <= offset
  requires 0 <= start <= end <= offset + |xs|
  ensures Std.Collections.Seq.FoldLeft((walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units)), core__streamUnits_SliceWalk(offset, acc), xs).units ==
    acc + xs[(if offset < start then start - offset else 0)..(if offset < end then end - offset else 0)]
  decreases |xs|
{
  hide *;
  reveal Std.Collections.Seq.FoldLeft();
  var fold := (walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units));
  var lo := if offset < start then start - offset else 0;
  var hi := if offset < end then end - offset else 0;
  if |xs| == 0 {
    assert xs == [];
    assert lo == 0 && hi == 0;
  } else {
    var tail := xs[1..];
    var next := fold(core__streamUnits_SliceWalk(offset, acc), xs[0]);
    assert next.offset == offset + 1;
    assert next == core__streamUnits_SliceWalk(offset + 1, next.units);
    assert Std.Collections.Seq.FoldLeft(fold, core__streamUnits_SliceWalk(offset, acc), xs) ==
      Std.Collections.Seq.FoldLeft(fold, next, tail);
    ReplyStreamSliceFold(tail, offset + 1, start, end, next.units);
    if offset < start {
      assert next.units == acc;
      assert tail[lo - 1..hi - 1] == xs[lo..hi];
    } else if offset < end {
      assert next.units == acc + [xs[0]];
      assert tail[..hi - 1] == xs[1..hi];
      assert [xs[0]] + xs[1..hi] == xs[..hi];
      assert (acc + [xs[0]]) + tail[..hi - 1] == acc + xs[..hi];
    } else {
      assert next.units == acc;
      assert lo == 0 && hi == 0;
    }
  }
}

lemma {:induction false} ReplyStreamSliceAt(xs: seq<int>, split: int)
  requires 0 <= split <= |xs|
  ensures core__streamUnits_sliceUnits(xs, 0, split) + core__streamUnits_sliceUnits(xs, split, |xs|) == xs
{
  hide *;
  reveal core__streamUnits_sliceUnits();
  ReplyStreamSliceFold(xs, 0, 0, split, []);
  ReplyStreamSliceFold(xs, 0, split, |xs|, []);
  assert xs[..split] + xs[split..] == xs;
}

lemma {:induction false} ReplyStreamRestartOutput(s: ReplyStream, units: seq<int>, provisional: bool)
  ensures (inv(s) ==> canRestartText(s) ==> stepOneFrameInFlight(s, "restartText", restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepFramesRebuildTheText(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepAppendsNeverClearTheMark(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepMarkFollowsTheText(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepCadenceSnapshotsAtLeastDouble(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepNothingAfterTheEnd(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
{
  hide *;
  reveal inv();
  reveal canRestartText();
  reveal isOpen();
  reveal isFinishing();
  reveal alwaysCaughtUpWhenFree();
  reveal readyPending();
  reveal restartText();
  reveal writeNext();
  reveal textPending();
  reveal stepOneFrameInFlight();
  reveal stepFramesRebuildTheText();
  reveal stepAppendsNeverClearTheMark();
  reveal stepMarkFollowsTheText();
  reveal stepCadenceSnapshotsAtLeastDouble();
  reveal stepNothingAfterTheEnd();
  if inv(s) && canRestartText(s) {
    var next := s.(text := units, held := provisional);
    var result := restartText(s, units, provisional);
    assert s.phase.Open?;
    assert !isEnded(s.phase) by { reveal isEnded(); }
    if !s.inFlight {
      assert alwaysCaughtUpWhenFree(s);
      assert !readyPending(next.ready) && next.progress.NoProgress?;
      assert !ackWaiting(next.ack);
    }
    if s.inFlight || !textPending(next) {
      assert result == StreamStep(next, []);
      assert written(result.out) == [] by {
        reveal written();
        reveal Std.Collections.Seq.FoldLeft();
      }
      assert rebuilt(s.shown, result.out) == s.shown by {
        reveal rebuilt();
        reveal Std.Collections.Seq.FoldLeft();
      }
    } else {
      var frame := textFrame(next);
      var split := |s.shown|;
      assert result.out == [Write(frame)];
      assert result.state.inFlight;
      assert result.state.shown == units && result.state.shownHeld == provisional;
      ReplyStreamTerminalFoldLeftWrites(frame);
      ReplyStreamTerminalFoldLeftApplies(s.shown, frame);
      assert written(result.out) == [frame];

      reveal textFrame();
      reveal applyFrame();
      reveal isTextFrame();
      reveal markOf();
      reveal appendable();
      if !appendable(next) {
        assert frame == Replace(units, provisional);
      } else if cadenceDue(next) {
        assert frame.TokenSnapshot? && frame.fullText == units;
        reveal cadenceDue();
        reveal alwaysSnapshotCadence();
        reveal threshold();
        assert |s.shown| == s.lastSnapshot + s.sinceSnapshot;
        assert |units| - s.lastSnapshot >= threshold(s.lastSnapshot);
        assert threshold(s.lastSnapshot) >= 2048 && threshold(s.lastSnapshot) >= s.lastSnapshot;
        assert |units| >= (2 * s.lastSnapshot) && |units| >= (s.lastSnapshot + 2048);
      } else {
        assert frame.Token? && frame.provisional == provisional;
        reveal core__streamUnits_unitPrefix();
        assert 0 <= split <= |units|;
        assert core__streamUnits_sliceUnits(units, 0, split) == s.shown;
        ReplyStreamSliceAt(units, split);
        assert s.shown + core__streamUnits_sliceUnits(units, split, |units|) == units;
      }
      assert applyFrame(s.shown, frame) == units;
      assert frame.Token? ==> (frame.provisional || !s.shownHeld);
      assert isTextFrame(frame) && markOf(frame) == result.state.shownHeld;
      assert frame.TokenSnapshot? ==> ((|frame.fullText| >= (2 * s.lastSnapshot)) && (|frame.fullText| >= (s.lastSnapshot + 2048)));
      assert !frame.Final?;
      forall f | f in written(result.out)
        ensures (if f.Token? then (f.provisional || !(s.shownHeld)) else true)
        ensures (!(isTextFrame(f)) || (markOf(f) == result.state.shownHeld))
        ensures (if f.TokenSnapshot? then ((|f.fullText| >= (2 * s.lastSnapshot)) && (|f.fullText| >= (s.lastSnapshot + 2048))) else true)
        ensures !f.Final?
      {
        assert f == frame;
      }
    }
  }
}

lemma {:induction false} ReplyStreamTerminalWrite(s: ReplyStream, e: Ending)
  requires s.phase == Finishing(e)
  ensures writeNext(false, s).out == (if s.inFlight then [] else [Write(Final(e))])
  ensures written(writeNext(false, s).out) == (if s.inFlight then [] else [Final(e)])
  ensures s.inFlight ==> writeNext(false, s).state == s
  ensures !s.inFlight ==> (
    writeNext(false, s).state ==
      s.(phase := Ended(e), inFlight := true, shown := endText(e, s.shown), shownHeld := false,
        sinceSnapshot := 0, lastSnapshot := |endText(e, s.shown)|))
  ensures writeNext(false, s).state.ready == s.ready
  ensures writeNext(false, s).state.ack == s.ack
  ensures !(exists f :: f in written(writeNext(false, s).out) && isAckFrame(f))
  ensures stepFramesRebuildTheText(s, writeNext(false, s).state, writeNext(false, s).out)
{
  var result := writeNext(false, s);
  if s.inFlight {
    assert result == StreamStep(s, []);
    assert written([]) == [];
    assert rebuilt(s.shown, []) == s.shown;
  } else {
    var f := Final(e);
    var w := Write(f);
    assert result.out == [w];
    assert result.state.shown == endText(e, s.shown);
    ReplyStreamTerminalFoldLeftWrites(f);
    ReplyStreamTerminalFoldLeftApplies(s.shown, f);
    assert rebuilt(s.shown, [w]) == result.state.shown;
    assert !isAckFrame(f);
  }
}

lemma ReplyStreamState_finish_ensures(s: ReplyStream, reply: int, units: seq<int>, kind: agent__conversation__turns_ReplyKind, results: int)
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> alwaysOnlyAStreamingTurnCarriesText(finish(s, reply, units, kind, results).state))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> alwaysCaughtUpWhenFree(finish(s, reply, units, kind, results).state))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepOnlyARestartShortensTheText(s, "finish", finish(s, reply, units, kind, results).state))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepProgressNeverTouchesTheText(s, "finish", finish(s, reply, units, kind, results).state))
{
  var end := Done(reply, units, results, agent__conversation__turns_failureKind(kind));
  ReplyStreamTerminalWrite(s.(progress := Progress.NoProgress, phase := Finishing(end)), end);
}

lemma ReplyStreamDelivery_finish_ensures(s: ReplyStream, reply: int, units: seq<int>, kind: agent__conversation__turns_ReplyKind, results: int)
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepOneFrameInFlight(s, "finish", finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepFramesRebuildTheText(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepNothingAfterTheEnd(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
{
  var end := Done(reply, units, results, agent__conversation__turns_failureKind(kind));
  ReplyStreamTerminalWrite(s.(progress := Progress.NoProgress, phase := Finishing(end)), end);
}

lemma ReplyStreamMarks_finish_ensures(s: ReplyStream, reply: int, units: seq<int>, kind: agent__conversation__turns_ReplyKind, results: int)
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> alwaysSnapshotCadence(finish(s, reply, units, kind, results).state))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepAppendsNeverClearTheMark(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepMarkFollowsTheText(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepCadenceSnapshotsAtLeastDouble(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
{
  var end := Done(reply, units, results, agent__conversation__turns_failureKind(kind));
  ReplyStreamTerminalWrite(s.(progress := Progress.NoProgress, phase := Finishing(end)), end);
}

lemma ReplyStreamReadiness_finish_ensures(s: ReplyStream, reply: int, units: seq<int>, kind: agent__conversation__turns_ReplyKind, results: int)
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> alwaysAnAnnouncedReplyEndsAnswered(finish(s, reply, units, kind, results).state))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepReadyAtMostOnce(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
{
  var end := Done(reply, units, results, agent__conversation__turns_failureKind(kind));
  ReplyStreamTerminalWrite(s.(progress := Progress.NoProgress, phase := Finishing(end)), end);
}

lemma ReplyStreamAck_finish_ensures(s: ReplyStream, reply: int, units: seq<int>, kind: agent__conversation__turns_ReplyKind, results: int)
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepAcknowledgingNeverTouchesTheText(s, "finish", finish(s, reply, units, kind, results).state))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepAcknowledgedAtMostOnce(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
{
  var end := Done(reply, units, results, agent__conversation__turns_failureKind(kind));
  var next := s.(progress := Progress.NoProgress, phase := Finishing(end));
  ReplyStreamTerminalWrite(next, end);
  assert finish(s, reply, units, kind, results) == writeNext(false, next);
  ReplyStreamAckKept(s, "finish", writeNext(false, next).state, writeNext(false, next).out);
}

lemma CombinedReplyStreamClause27_finish_ensures(s: ReplyStream, reply: int, units: seq<int>, kind: agent__conversation__turns_ReplyKind, results: int)
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "finish", finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
{
  hide *;
  reveal finish();
  reveal stepLeavingAbortsOnlyAnOwnRunningTurn();
  var end := Done(reply, units, results, agent__conversation__turns_failureKind(kind));
  ReplyStreamTerminalWrite(s.(progress := Progress.NoProgress, phase := Finishing(end)), end);
  var result := finish(s, reply, units, kind, results);
  assert result.out == (if s.inFlight then [] else [Write(Final(end))]);
  forall e | e in result.out
    ensures !e.AbortTurn?
  {
    assert e == Write(Final(end));
  }
  assert !(exists e :: e in result.out && e.AbortTurn?);
}

lemma admit_ensures(s: ReplyStream, verdict: agent__conversation__turns_Admission)
  ensures (inv(s) ==> canAdmit(s) ==> alwaysOnlyAStreamingTurnCarriesText(admit(s, verdict).state))
  ensures (inv(s) ==> canAdmit(s) ==> alwaysCaughtUpWhenFree(admit(s, verdict).state))
  ensures (inv(s) ==> canAdmit(s) ==> alwaysSnapshotCadence(admit(s, verdict).state))
  ensures (inv(s) ==> canAdmit(s) ==> alwaysAnAnnouncedReplyEndsAnswered(admit(s, verdict).state))
  ensures (inv(s) ==> canAdmit(s) ==> stepOneFrameInFlight(s, "admit", admit(s, verdict).state, admit(s, verdict).out))
  ensures (inv(s) ==> canAdmit(s) ==> stepFramesRebuildTheText(s, admit(s, verdict).state, admit(s, verdict).out))
  ensures (inv(s) ==> canAdmit(s) ==> stepAppendsNeverClearTheMark(s, admit(s, verdict).state, admit(s, verdict).out))
  ensures (inv(s) ==> canAdmit(s) ==> stepMarkFollowsTheText(s, admit(s, verdict).state, admit(s, verdict).out))
  ensures (inv(s) ==> canAdmit(s) ==> stepOnlyARestartShortensTheText(s, "admit", admit(s, verdict).state))
  ensures (inv(s) ==> canAdmit(s) ==> stepCadenceSnapshotsAtLeastDouble(s, admit(s, verdict).state, admit(s, verdict).out))
  ensures (inv(s) ==> canAdmit(s) ==> stepProgressNeverTouchesTheText(s, "admit", admit(s, verdict).state))
  ensures (inv(s) ==> canAdmit(s) ==> stepAcknowledgedAtMostOnce(s, admit(s, verdict).state, admit(s, verdict).out))
  ensures (inv(s) ==> canAdmit(s) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, admit(s, verdict).state, admit(s, verdict).out))
  ensures (inv(s) ==> canAdmit(s) ==> stepAcknowledgingNeverTouchesTheText(s, "admit", admit(s, verdict).state))
  ensures (inv(s) ==> canAdmit(s) ==> stepReadyAtMostOnce(s, admit(s, verdict).state, admit(s, verdict).out))
  ensures (inv(s) ==> canAdmit(s) ==> stepNothingAfterTheEnd(s, admit(s, verdict).state, admit(s, verdict).out))
  ensures (inv(s) ==> canAdmit(s) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "admit", admit(s, verdict).state, admit(s, verdict).out))
{
  hide *;
  if inv(s) && canAdmit(s) {
    ReplyStreamAdmitState(s, verdict);
    ReplyStreamAdmitDelivery(s, verdict);
    ReplyStreamAdmitProtocol(s, verdict);
  }
}

lemma {:induction false} ReplyStreamAdmitShape(s: ReplyStream, verdict: agent__conversation__turns_Admission)
  requires inv(s) && canAdmit(s)
  ensures s.phase.Open? && !s.inFlight
  ensures s.text == [] && s.shown == [] && !s.held && !s.shownHeld
  ensures s.ready.NotReady? && s.progress.NoProgress? && s.ack.Unacknowledged?
  ensures s.sinceSnapshot == 0 && s.lastSnapshot == 0
  ensures roleFor(verdict).Streams? || roleFor(verdict).Waits? || roleFor(verdict).Refused?
  ensures admit(s, verdict) ==
    (if roleFor(verdict).Streams? then
      StreamStep(s.(role := roleFor(verdict), inFlight := true), [Write(Progressed(Activity("thinking")))])
    else StreamStep(s.(role := roleFor(verdict)), []))
{
  hide *;
  reveal inv();
  reveal canAdmit();
  reveal alwaysOnlyAStreamingTurnCarriesText();
  reveal isOpen();
  assert s.phase.Open? && !s.inFlight;
  assert s.text == [] && s.shown == [] && !s.held && !s.shownHeld;
  assert s.ready.NotReady? && s.progress.NoProgress? && s.ack.Unacknowledged?;
  reveal roleFor();
  reveal admit();
  if roleFor(verdict).Streams? {
    reveal writeNext();
    reveal isFinishing();
    reveal textPending();
    reveal readyPending();
    reveal ackWaiting();
  }
}

lemma {:induction false} ReplyStreamAdmitResultViews(s: ReplyStream, verdict: agent__conversation__turns_Admission)
  requires inv(s) && canAdmit(s)
  ensures written(admit(s, verdict).out) == (if roleFor(verdict).Streams? then [Progressed(Activity("thinking"))] else [])
  ensures rebuilt(s.shown, admit(s, verdict).out) == s.shown
  ensures !(exists e :: e in admit(s, verdict).out && e.AbortTurn?)
{
  hide *;
  ReplyStreamAdmitShape(s, verdict);
  var result := admit(s, verdict);
  if roleFor(verdict).Streams? {
    var frame := Progressed(Activity("thinking"));
    ReplyStreamTerminalFoldLeftWrites(frame);
    ReplyStreamTerminalFoldLeftApplies(s.shown, frame);
    reveal applyFrame();
    assert written(result.out) == [frame];
    assert rebuilt(s.shown, result.out) == s.shown;
  } else {
    reveal Std.Collections.Seq.FoldLeft();
    reveal written();
    reveal rebuilt();
    assert written(result.out) == [];
    assert rebuilt(s.shown, result.out) == s.shown;
  }
}

lemma {:induction false} ReplyStreamAdmitState(s: ReplyStream, verdict: agent__conversation__turns_Admission)
  requires inv(s) && canAdmit(s)
  ensures alwaysOnlyAStreamingTurnCarriesText(admit(s, verdict).state)
  ensures alwaysCaughtUpWhenFree(admit(s, verdict).state)
  ensures alwaysSnapshotCadence(admit(s, verdict).state)
  ensures alwaysAnAnnouncedReplyEndsAnswered(admit(s, verdict).state)
{
  hide *;
  ReplyStreamAdmitShape(s, verdict);
  reveal inv();
  reveal alwaysOnlyAStreamingTurnCarriesText();
  reveal alwaysCaughtUpWhenFree();
  reveal alwaysSnapshotCadence();
  reveal alwaysAnAnnouncedReplyEndsAnswered();
  reveal isOpen();
  reveal isFinishing();
  reveal isSent();
  if roleFor(verdict).Streams? {
    assert admit(s, verdict).state.role.Streams?;
  }
}

lemma {:induction false} ReplyStreamAdmitDelivery(s: ReplyStream, verdict: agent__conversation__turns_Admission)
  requires inv(s) && canAdmit(s)
  ensures stepOneFrameInFlight(s, "admit", admit(s, verdict).state, admit(s, verdict).out)
  ensures stepFramesRebuildTheText(s, admit(s, verdict).state, admit(s, verdict).out)
  ensures stepAppendsNeverClearTheMark(s, admit(s, verdict).state, admit(s, verdict).out)
  ensures stepMarkFollowsTheText(s, admit(s, verdict).state, admit(s, verdict).out)
  ensures stepOnlyARestartShortensTheText(s, "admit", admit(s, verdict).state)
{
  hide *;
  ReplyStreamAdmitShape(s, verdict);
  ReplyStreamAdmitResultViews(s, verdict);
  reveal stepOneFrameInFlight();
  reveal stepFramesRebuildTheText();
  reveal stepAppendsNeverClearTheMark();
  reveal stepMarkFollowsTheText();
  reveal isTextFrame();
  reveal stepOnlyARestartShortensTheText();
  if roleFor(verdict).Streams? {
    assert admit(s, verdict).state.role.Streams?;
  }
}

lemma {:induction false} ReplyStreamAdmitProtocol(s: ReplyStream, verdict: agent__conversation__turns_Admission)
  requires inv(s) && canAdmit(s)
  ensures stepCadenceSnapshotsAtLeastDouble(s, admit(s, verdict).state, admit(s, verdict).out)
  ensures stepProgressNeverTouchesTheText(s, "admit", admit(s, verdict).state)
  ensures stepReadyAtMostOnce(s, admit(s, verdict).state, admit(s, verdict).out)
  ensures stepNothingAfterTheEnd(s, admit(s, verdict).state, admit(s, verdict).out)
  ensures stepLeavingAbortsOnlyAnOwnRunningTurn(s, "admit", admit(s, verdict).state, admit(s, verdict).out)
  ensures stepAcknowledgingNeverTouchesTheText(s, "admit", admit(s, verdict).state)
  ensures stepAcknowledgedAtMostOnce(s, admit(s, verdict).state, admit(s, verdict).out)
  ensures stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, admit(s, verdict).state, admit(s, verdict).out)
{
  hide *;
  ReplyStreamAdmitShape(s, verdict);
  ReplyStreamAdmitResultViews(s, verdict);
  assert admit(s, verdict).state.ack == s.ack;
  assert !(exists f :: f in written(admit(s, verdict).out) && isAckFrame(f)) by { reveal isAckFrame(); }
  ReplyStreamAckKept(s, "admit", admit(s, verdict).state, admit(s, verdict).out);
  reveal stepCadenceSnapshotsAtLeastDouble();
  reveal stepProgressNeverTouchesTheText();
  reveal stepReadyAtMostOnce();
  reveal isReadySent();
  reveal isReadyFrame();
  reveal stepNothingAfterTheEnd();
  reveal isEnded();
  reveal isOpen();
  reveal stepLeavingAbortsOnlyAnOwnRunningTurn();
  if roleFor(verdict).Streams? {
    assert admit(s, verdict).state.role.Streams?;
  }
}

lemma clientLeft_ensures(s: ReplyStream)
  ensures (inv(s) ==> canClientLeft(s) ==> alwaysOnlyAStreamingTurnCarriesText(clientLeft(s).state))
  ensures (inv(s) ==> canClientLeft(s) ==> alwaysCaughtUpWhenFree(clientLeft(s).state))
  ensures (inv(s) ==> canClientLeft(s) ==> alwaysSnapshotCadence(clientLeft(s).state))
  ensures (inv(s) ==> canClientLeft(s) ==> alwaysAnAnnouncedReplyEndsAnswered(clientLeft(s).state))
  ensures (inv(s) ==> canClientLeft(s) ==> stepOneFrameInFlight(s, "clientLeft", clientLeft(s).state, clientLeft(s).out))
  ensures (inv(s) ==> canClientLeft(s) ==> stepFramesRebuildTheText(s, clientLeft(s).state, clientLeft(s).out))
  ensures (inv(s) ==> canClientLeft(s) ==> stepAppendsNeverClearTheMark(s, clientLeft(s).state, clientLeft(s).out))
  ensures (inv(s) ==> canClientLeft(s) ==> stepMarkFollowsTheText(s, clientLeft(s).state, clientLeft(s).out))
  ensures (inv(s) ==> canClientLeft(s) ==> stepOnlyARestartShortensTheText(s, "clientLeft", clientLeft(s).state))
  ensures (inv(s) ==> canClientLeft(s) ==> stepCadenceSnapshotsAtLeastDouble(s, clientLeft(s).state, clientLeft(s).out))
  ensures (inv(s) ==> canClientLeft(s) ==> stepProgressNeverTouchesTheText(s, "clientLeft", clientLeft(s).state))
  ensures (inv(s) ==> canClientLeft(s) ==> stepAcknowledgedAtMostOnce(s, clientLeft(s).state, clientLeft(s).out))
  ensures (inv(s) ==> canClientLeft(s) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, clientLeft(s).state, clientLeft(s).out))
  ensures (inv(s) ==> canClientLeft(s) ==> stepAcknowledgingNeverTouchesTheText(s, "clientLeft", clientLeft(s).state))
  ensures (inv(s) ==> canClientLeft(s) ==> stepReadyAtMostOnce(s, clientLeft(s).state, clientLeft(s).out))
  ensures (inv(s) ==> canClientLeft(s) ==> stepNothingAfterTheEnd(s, clientLeft(s).state, clientLeft(s).out))
  ensures (inv(s) ==> canClientLeft(s) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "clientLeft", clientLeft(s).state, clientLeft(s).out))
{
  hide *;
  if inv(s) && canClientLeft(s) {
    ReplyStreamClientLeftViews(s);
    ReplyStreamAckKept(s, "clientLeft", clientLeft(s).state, clientLeft(s).out);
    reveal inv();
    reveal canClientLeft();
    reveal alwaysOnlyAStreamingTurnCarriesText();
    reveal alwaysCaughtUpWhenFree();
    reveal alwaysSnapshotCadence();
    reveal alwaysAnAnnouncedReplyEndsAnswered();
    reveal isOpen();
    reveal isFinishing();
    reveal isSent();
    reveal stepOneFrameInFlight();
    reveal stepFramesRebuildTheText();
    reveal stepAppendsNeverClearTheMark();
    reveal stepMarkFollowsTheText();
    reveal stepOnlyARestartShortensTheText();
    reveal stepCadenceSnapshotsAtLeastDouble();
    reveal stepProgressNeverTouchesTheText();
    reveal stepReadyAtMostOnce();
    reveal isReadySent();
    reveal stepNothingAfterTheEnd();
    reveal isEnded();
    reveal stepLeavingAbortsOnlyAnOwnRunningTurn();
  }
}

lemma {:induction false} ReplyStreamClientLeftViews(s: ReplyStream)
  ensures clientLeft(s).state == s.(phase := Phase.Dropped, inFlight := false)
  ensures written(clientLeft(s).out) == []
  ensures rebuilt(s.shown, clientLeft(s).out) == s.shown
  ensures (exists e :: e in clientLeft(s).out && e.AbortTurn?) == (s.role.Streams? && isOpen(s.phase))
{
  hide *;
  reveal clientLeft();
  reveal written();
  var result := clientLeft(s);
  var allWrites := (acc: seq<Frame>, e: Effect) => (if e.Write? then (acc + [e.frame]) else acc);
  if s.role.Streams? && isOpen(s.phase) {
    assert result.out == [Effect.AbortTurn];
    ReplyStreamTerminalFoldLeftSingleton(allWrites, [], Effect.AbortTurn);
    assert exists e :: e in result.out && e.AbortTurn?;
  } else {
    assert result.out == [];
  }
  reveal rebuilt();
  reveal Std.Collections.Seq.FoldLeft();
}

lemma appendText_ensures(s: ReplyStream, units: seq<int>, provisional: bool)
  ensures (inv(s) ==> canAppendText(s, units) ==> alwaysOnlyAStreamingTurnCarriesText(appendText(s, units, provisional).state))
  ensures (inv(s) ==> canAppendText(s, units) ==> alwaysCaughtUpWhenFree(appendText(s, units, provisional).state))
  ensures (inv(s) ==> canAppendText(s, units) ==> alwaysSnapshotCadence(appendText(s, units, provisional).state))
  ensures (inv(s) ==> canAppendText(s, units) ==> alwaysAnAnnouncedReplyEndsAnswered(appendText(s, units, provisional).state))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepOneFrameInFlight(s, "appendText", appendText(s, units, provisional).state, appendText(s, units, provisional).out))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepFramesRebuildTheText(s, appendText(s, units, provisional).state, appendText(s, units, provisional).out))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepAppendsNeverClearTheMark(s, appendText(s, units, provisional).state, appendText(s, units, provisional).out))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepMarkFollowsTheText(s, appendText(s, units, provisional).state, appendText(s, units, provisional).out))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepOnlyARestartShortensTheText(s, "appendText", appendText(s, units, provisional).state))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepCadenceSnapshotsAtLeastDouble(s, appendText(s, units, provisional).state, appendText(s, units, provisional).out))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepProgressNeverTouchesTheText(s, "appendText", appendText(s, units, provisional).state))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepAcknowledgedAtMostOnce(s, appendText(s, units, provisional).state, appendText(s, units, provisional).out))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, appendText(s, units, provisional).state, appendText(s, units, provisional).out))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepAcknowledgingNeverTouchesTheText(s, "appendText", appendText(s, units, provisional).state))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepReadyAtMostOnce(s, appendText(s, units, provisional).state, appendText(s, units, provisional).out))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepNothingAfterTheEnd(s, appendText(s, units, provisional).state, appendText(s, units, provisional).out))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "appendText", appendText(s, units, provisional).state, appendText(s, units, provisional).out))
{
  hide *;
  if inv(s) && canAppendText(s, units) {
    assert canRestartText(s) by { reveal canAppendText(); reveal canRestartText(); }
    var nextText := s.text + units;
    var nextHeld := s.held || provisional;
    var result := appendText(s, units, provisional);
    assert result == restartText(s, nextText, nextHeld) by { reveal appendText(); reveal restartText(); }
    restartText_ensures(s, nextText, nextHeld);
    ReplyStreamWriteKeepsText(false, s.(text := nextText, held := nextHeld));
    assert result.state.text == nextText by { reveal appendText(); }
    assert |result.state.text| >= |s.text|;
    reveal stepOneFrameInFlight();
    reveal stepOnlyARestartShortensTheText();
    reveal stepProgressNeverTouchesTheText();
    reveal stepAcknowledgingNeverTouchesTheText();
    reveal stepLeavingAbortsOnlyAnOwnRunningTurn();
  }
}

lemma replaceText_ensures(s: ReplyStream, units: seq<int>, provisional: bool)
  ensures (inv(s) ==> canReplaceText(s) ==> alwaysOnlyAStreamingTurnCarriesText(replaceText(s, units, provisional).state))
  ensures (inv(s) ==> canReplaceText(s) ==> alwaysCaughtUpWhenFree(replaceText(s, units, provisional).state))
  ensures (inv(s) ==> canReplaceText(s) ==> alwaysSnapshotCadence(replaceText(s, units, provisional).state))
  ensures (inv(s) ==> canReplaceText(s) ==> alwaysAnAnnouncedReplyEndsAnswered(replaceText(s, units, provisional).state))
  ensures (inv(s) ==> canReplaceText(s) ==> stepOneFrameInFlight(s, "replaceText", replaceText(s, units, provisional).state, replaceText(s, units, provisional).out))
  ensures (inv(s) ==> canReplaceText(s) ==> stepFramesRebuildTheText(s, replaceText(s, units, provisional).state, replaceText(s, units, provisional).out))
  ensures (inv(s) ==> canReplaceText(s) ==> stepAppendsNeverClearTheMark(s, replaceText(s, units, provisional).state, replaceText(s, units, provisional).out))
  ensures (inv(s) ==> canReplaceText(s) ==> stepMarkFollowsTheText(s, replaceText(s, units, provisional).state, replaceText(s, units, provisional).out))
  ensures (inv(s) ==> canReplaceText(s) ==> stepOnlyARestartShortensTheText(s, "replaceText", replaceText(s, units, provisional).state))
  ensures (inv(s) ==> canReplaceText(s) ==> stepCadenceSnapshotsAtLeastDouble(s, replaceText(s, units, provisional).state, replaceText(s, units, provisional).out))
  ensures (inv(s) ==> canReplaceText(s) ==> stepProgressNeverTouchesTheText(s, "replaceText", replaceText(s, units, provisional).state))
  ensures (inv(s) ==> canReplaceText(s) ==> stepAcknowledgedAtMostOnce(s, replaceText(s, units, provisional).state, replaceText(s, units, provisional).out))
  ensures (inv(s) ==> canReplaceText(s) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, replaceText(s, units, provisional).state, replaceText(s, units, provisional).out))
  ensures (inv(s) ==> canReplaceText(s) ==> stepAcknowledgingNeverTouchesTheText(s, "replaceText", replaceText(s, units, provisional).state))
  ensures (inv(s) ==> canReplaceText(s) ==> stepReadyAtMostOnce(s, replaceText(s, units, provisional).state, replaceText(s, units, provisional).out))
  ensures (inv(s) ==> canReplaceText(s) ==> stepNothingAfterTheEnd(s, replaceText(s, units, provisional).state, replaceText(s, units, provisional).out))
  ensures (inv(s) ==> canReplaceText(s) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "replaceText", replaceText(s, units, provisional).state, replaceText(s, units, provisional).out))
{
  hide *;
  if inv(s) && canReplaceText(s) {
    assert canRestartText(s) by { reveal canReplaceText(); reveal canRestartText(); }
    var result := replaceText(s, units, provisional);
    if core__streamUnits_unitPrefix(s.text, units) && |units| < |s.text| {
      assert result == StreamStep(s, []) by { reveal replaceText(); }
      ReplyStreamNoChange(s, result, "replaceText");
    } else {
      assert result == restartText(s, units, provisional) by { reveal replaceText(); reveal restartText(); }
      restartText_ensures(s, units, provisional);
      ReplyStreamWriteKeepsText(false, s.(text := units, held := provisional));
      assert result.state.text == units by { reveal restartText(); }
    }
    reveal stepOneFrameInFlight();
    reveal stepOnlyARestartShortensTheText();
    reveal stepProgressNeverTouchesTheText();
    reveal stepAcknowledgingNeverTouchesTheText();
    reveal stepLeavingAbortsOnlyAnOwnRunningTurn();
  }
}

lemma {:induction false} ReplyStreamWriteKeepsText(left: bool, s: ReplyStream)
  ensures writeNext(left, s).state.text == s.text
  ensures writeNext(left, s).state.held == s.held
{
  hide *;
  reveal writeNext();
}

lemma {:induction false} ReplyStreamNoChange(s: ReplyStream, result: StreamStep, via: string)
  requires inv(s) && result == StreamStep(s, []) && via != "clientLeft"
  ensures alwaysOnlyAStreamingTurnCarriesText(result.state)
  ensures alwaysCaughtUpWhenFree(result.state)
  ensures alwaysSnapshotCadence(result.state)
  ensures alwaysAnAnnouncedReplyEndsAnswered(result.state)
  ensures stepOneFrameInFlight(s, via, result.state, result.out)
  ensures stepFramesRebuildTheText(s, result.state, result.out)
  ensures stepAppendsNeverClearTheMark(s, result.state, result.out)
  ensures stepMarkFollowsTheText(s, result.state, result.out)
  ensures stepCadenceSnapshotsAtLeastDouble(s, result.state, result.out)
  ensures stepReadyAtMostOnce(s, result.state, result.out)
  ensures stepNothingAfterTheEnd(s, result.state, result.out)
  ensures stepAcknowledgedAtMostOnce(s, result.state, result.out)
  ensures stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, result.state, result.out)
{
  hide *;
  reveal inv();
  reveal stepAcknowledgedAtMostOnce();
  reveal stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame();
  reveal written();
  reveal rebuilt();
  reveal Std.Collections.Seq.FoldLeft();
  reveal stepOneFrameInFlight();
  reveal stepFramesRebuildTheText();
  reveal stepAppendsNeverClearTheMark();
  reveal stepMarkFollowsTheText();
  reveal stepCadenceSnapshotsAtLeastDouble();
  reveal stepReadyAtMostOnce();
  reveal stepNothingAfterTheEnd();
}

lemma showProgress_ensures(s: ReplyStream, progress: Progress)
  ensures (inv(s) ==> canShowProgress(s, progress) ==> alwaysOnlyAStreamingTurnCarriesText(showProgress(s, progress).state))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> alwaysCaughtUpWhenFree(showProgress(s, progress).state))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> alwaysSnapshotCadence(showProgress(s, progress).state))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> alwaysAnAnnouncedReplyEndsAnswered(showProgress(s, progress).state))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepOneFrameInFlight(s, "showProgress", showProgress(s, progress).state, showProgress(s, progress).out))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepFramesRebuildTheText(s, showProgress(s, progress).state, showProgress(s, progress).out))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepAppendsNeverClearTheMark(s, showProgress(s, progress).state, showProgress(s, progress).out))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepMarkFollowsTheText(s, showProgress(s, progress).state, showProgress(s, progress).out))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepOnlyARestartShortensTheText(s, "showProgress", showProgress(s, progress).state))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepCadenceSnapshotsAtLeastDouble(s, showProgress(s, progress).state, showProgress(s, progress).out))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepProgressNeverTouchesTheText(s, "showProgress", showProgress(s, progress).state))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepAcknowledgedAtMostOnce(s, showProgress(s, progress).state, showProgress(s, progress).out))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, showProgress(s, progress).state, showProgress(s, progress).out))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepAcknowledgingNeverTouchesTheText(s, "showProgress", showProgress(s, progress).state))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepReadyAtMostOnce(s, showProgress(s, progress).state, showProgress(s, progress).out))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepNothingAfterTheEnd(s, showProgress(s, progress).state, showProgress(s, progress).out))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "showProgress", showProgress(s, progress).state, showProgress(s, progress).out))
{
  hide *;
  if inv(s) && canShowProgress(s, progress) {
    ReplyStreamShowProgressShape(s, progress);
    ReplyStreamControlViews(s.shown, showProgress(s, progress).out, Progressed(progress));
    assert showProgress(s, progress).state.ack == s.ack;
    assert !(exists f :: f in written(showProgress(s, progress).out) && isAckFrame(f)) by { reveal isAckFrame(); }
    ReplyStreamAckKept(s, "showProgress", showProgress(s, progress).state, showProgress(s, progress).out);
    reveal inv();
    reveal alwaysOnlyAStreamingTurnCarriesText();
    reveal alwaysCaughtUpWhenFree();
    reveal alwaysSnapshotCadence();
    reveal alwaysAnAnnouncedReplyEndsAnswered();
    reveal isOpen();
    reveal isFinishing();
    reveal isSent();
    reveal stepOneFrameInFlight();
    reveal stepFramesRebuildTheText();
    reveal stepAppendsNeverClearTheMark();
    reveal stepMarkFollowsTheText();
    reveal isTextFrame();
    reveal stepOnlyARestartShortensTheText();
    reveal stepCadenceSnapshotsAtLeastDouble();
    reveal stepProgressNeverTouchesTheText();
    reveal stepReadyAtMostOnce();
    reveal isReadySent();
    reveal isReadyFrame();
    reveal stepNothingAfterTheEnd();
    reveal isEnded();
    reveal stepLeavingAbortsOnlyAnOwnRunningTurn();
  }
}

lemma announceReply_ensures(s: ReplyStream, units: seq<int>, results: int)
  ensures (inv(s) ==> canAnnounceReply(s) ==> alwaysOnlyAStreamingTurnCarriesText(announceReply(s, units, results).state))
  ensures (inv(s) ==> canAnnounceReply(s) ==> alwaysCaughtUpWhenFree(announceReply(s, units, results).state))
  ensures (inv(s) ==> canAnnounceReply(s) ==> alwaysSnapshotCadence(announceReply(s, units, results).state))
  ensures (inv(s) ==> canAnnounceReply(s) ==> alwaysAnAnnouncedReplyEndsAnswered(announceReply(s, units, results).state))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepOneFrameInFlight(s, "announceReply", announceReply(s, units, results).state, announceReply(s, units, results).out))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepFramesRebuildTheText(s, announceReply(s, units, results).state, announceReply(s, units, results).out))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepAppendsNeverClearTheMark(s, announceReply(s, units, results).state, announceReply(s, units, results).out))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepMarkFollowsTheText(s, announceReply(s, units, results).state, announceReply(s, units, results).out))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepOnlyARestartShortensTheText(s, "announceReply", announceReply(s, units, results).state))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepCadenceSnapshotsAtLeastDouble(s, announceReply(s, units, results).state, announceReply(s, units, results).out))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepProgressNeverTouchesTheText(s, "announceReply", announceReply(s, units, results).state))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepAcknowledgedAtMostOnce(s, announceReply(s, units, results).state, announceReply(s, units, results).out))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, announceReply(s, units, results).state, announceReply(s, units, results).out))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepAcknowledgingNeverTouchesTheText(s, "announceReply", announceReply(s, units, results).state))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepReadyAtMostOnce(s, announceReply(s, units, results).state, announceReply(s, units, results).out))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepNothingAfterTheEnd(s, announceReply(s, units, results).state, announceReply(s, units, results).out))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "announceReply", announceReply(s, units, results).state, announceReply(s, units, results).out))
{
  hide *;
  if inv(s) && canAnnounceReply(s) {
    ReplyStreamAnnounceReplyShape(s, units, results);
    ReplyStreamControlViews(s.shown, announceReply(s, units, results).out, ReadyFrame(units, results));
    assert announceReply(s, units, results).state.ack == s.ack;
    assert !(exists f :: f in written(announceReply(s, units, results).out) && isAckFrame(f)) by { reveal isAckFrame(); }
    ReplyStreamAckKept(s, "announceReply", announceReply(s, units, results).state, announceReply(s, units, results).out);
    reveal inv();
    reveal alwaysOnlyAStreamingTurnCarriesText();
    reveal alwaysCaughtUpWhenFree();
    reveal alwaysSnapshotCadence();
    reveal alwaysAnAnnouncedReplyEndsAnswered();
    reveal isOpen();
    reveal isFinishing();
    reveal isSent();
    reveal stepOneFrameInFlight();
    reveal stepFramesRebuildTheText();
    reveal stepAppendsNeverClearTheMark();
    reveal stepMarkFollowsTheText();
    reveal isTextFrame();
    reveal stepOnlyARestartShortensTheText();
    reveal stepCadenceSnapshotsAtLeastDouble();
    reveal stepProgressNeverTouchesTheText();
    reveal stepReadyAtMostOnce();
    reveal isReadySent();
    reveal isReadyFrame();
    reveal stepNothingAfterTheEnd();
    reveal isEnded();
    reveal stepLeavingAbortsOnlyAnOwnRunningTurn();
  }
}

lemma {:induction false} ReplyStreamShowProgressShape(s: ReplyStream, progress: Progress)
  requires inv(s) && canShowProgress(s, progress)
  ensures s.role.Streams? && s.phase.Open?
  ensures showProgress(s, progress) ==
    (if s.inFlight then StreamStep(s.(progress := progress), [])
     else StreamStep(s.(inFlight := true, progress := Progress.NoProgress), [Write(Progressed(progress))]))
{
  hide *;
  reveal canShowProgress();
  reveal isOpen();
  reveal showProgress();
  reveal writeNext();
  if !s.inFlight {
    reveal inv();
    reveal alwaysCaughtUpWhenFree();
    reveal isFinishing();
    reveal textPending();
    reveal readyPending();
    reveal ackWaiting();
  }
}

lemma {:induction false} ReplyStreamAnnounceReplyShape(s: ReplyStream, units: seq<int>, results: int)
  requires inv(s) && canAnnounceReply(s)
  ensures s.role.Streams? && s.phase.Open? && s.ready.NotReady?
  ensures announceReply(s, units, results) ==
    (if s.inFlight then StreamStep(s.(ready := ReadyPending(units, results)), [])
     else StreamStep(s.(inFlight := true, ready := ReadySent(results)), [Write(ReadyFrame(units, results))]))
{
  hide *;
  reveal canAnnounceReply();
  reveal isOpen();
  reveal announceReply();
  reveal writeNext();
  if !s.inFlight {
    reveal inv();
    reveal alwaysCaughtUpWhenFree();
    reveal isFinishing();
    reveal textPending();
    reveal readyPending();
    reveal readySent();
    reveal readyFrame();
    reveal ackWaiting();
  }
}

lemma {:induction false} ReplyStreamControlViews(shown: seq<int>, out: seq<Effect>, frame: Frame)
  requires out == [] || out == [Write(frame)]
  requires frame.Progressed? || frame.ReadyFrame? || frame.AckFrame?
  ensures written(out) == (if out == [] then [] else [frame])
  ensures rebuilt(shown, out) == shown
  ensures !(exists e :: e in out && e.AbortTurn?)
{
  hide *;
  if out == [] {
    reveal written();
    reveal rebuilt();
    reveal Std.Collections.Seq.FoldLeft();
  } else {
    ReplyStreamTerminalFoldLeftWrites(frame);
    ReplyStreamTerminalFoldLeftApplies(shown, frame);
    reveal applyFrame();
    assert applyFrame(shown, frame) == shown;
    assert !Write(frame).AbortTurn?;
  }
}

lemma frameFlushed_ensures(s: ReplyStream)
  ensures (inv(s) ==> canFrameFlushed(s) ==> alwaysOnlyAStreamingTurnCarriesText(frameFlushed(s).state))
  ensures (inv(s) ==> canFrameFlushed(s) ==> alwaysCaughtUpWhenFree(frameFlushed(s).state))
  ensures (inv(s) ==> canFrameFlushed(s) ==> alwaysSnapshotCadence(frameFlushed(s).state))
  ensures (inv(s) ==> canFrameFlushed(s) ==> alwaysAnAnnouncedReplyEndsAnswered(frameFlushed(s).state))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepOneFrameInFlight(s, "frameFlushed", frameFlushed(s).state, frameFlushed(s).out))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepFramesRebuildTheText(s, frameFlushed(s).state, frameFlushed(s).out))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepAppendsNeverClearTheMark(s, frameFlushed(s).state, frameFlushed(s).out))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepMarkFollowsTheText(s, frameFlushed(s).state, frameFlushed(s).out))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepOnlyARestartShortensTheText(s, "frameFlushed", frameFlushed(s).state))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepCadenceSnapshotsAtLeastDouble(s, frameFlushed(s).state, frameFlushed(s).out))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepProgressNeverTouchesTheText(s, "frameFlushed", frameFlushed(s).state))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepAcknowledgedAtMostOnce(s, frameFlushed(s).state, frameFlushed(s).out))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, frameFlushed(s).state, frameFlushed(s).out))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepAcknowledgingNeverTouchesTheText(s, "frameFlushed", frameFlushed(s).state))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepReadyAtMostOnce(s, frameFlushed(s).state, frameFlushed(s).out))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepNothingAfterTheEnd(s, frameFlushed(s).state, frameFlushed(s).out))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "frameFlushed", frameFlushed(s).state, frameFlushed(s).out))
{
  hide *;
  if inv(s) && canFrameFlushed(s) {
    reveal inv();
    reveal alwaysSnapshotCadence();
    var result := frameFlushed(s);
    var free := s.(inFlight := false);
    if s.phase.Open? && ackWaiting(s.ack) {
      assert s.inFlight by { reveal canFrameFlushed(); }
      assert !s.ack.AckSent? by { reveal ackWaiting(); }
      ReplyStreamFlushedAckShape(s);
      assert s.role.Streams? by {
        reveal alwaysOnlyAStreamingTurnCarriesText();
        reveal ackWaiting();
      }
      ReplyStreamAckFrameStep(s, "frameFlushed", result.state, result.out, s.ack.cue);
    } else if s.phase.Open? && textPending(s) {
      var base := free.(text := s.shown, held := s.shownHeld, ready := Readiness.NotReady, progress := Progress.NoProgress);
      ReplyStreamFlushedTextShape(s, base);
      restartText_ensures(base, s.text, s.held);
      assert alwaysSnapshotCadence(restartText(base, s.text, s.held).state);
      assert alwaysSnapshotCadence(result.state);
      var frame := textFrame(free);
      ReplyStreamTerminalFoldLeftWrites(frame);
      assert result.state.ack == s.ack;
      assert !isAckFrame(frame) by {
        reveal textFrame();
        reveal isAckFrame();
      }
      assert !(exists f :: f in written(result.out) && isAckFrame(f));
      ReplyStreamAckKept(s, "frameFlushed", result.state, result.out);
    } else if s.phase.Finishing? {
      var end := s.phase.end;
      assert result == writeNext(false, free) by {
        reveal frameFlushed();
        reveal writeNext();
      }
      ReplyStreamTerminalWrite(free, end);
      assert alwaysSnapshotCadence(result.state) by { reveal threshold(); }
      ReplyStreamAckKept(s, "frameFlushed", result.state, result.out);
    } else {
      ReplyStreamFlushedControlShape(s);
      if s.phase.Open? && s.ready.ReadyPending? {
        ReplyStreamControlViews(s.shown, result.out, ReadyFrame(s.ready.text, s.ready.results));
      } else {
        ReplyStreamControlViews(s.shown, result.out, Progressed(s.progress));
      }
      assert result.state.ack == s.ack;
      assert !(exists f :: f in written(result.out) && isAckFrame(f)) by { reveal isAckFrame(); }
      ReplyStreamAckKept(s, "frameFlushed", result.state, result.out);
      if s.phase.Open? {
        assert !ackWaiting(result.state.ack);
      }
      if s.phase.Open? && !result.state.inFlight {
        assert s.shown == s.text && s.shownHeld == s.held by { reveal textPending(); }
      }
      assert alwaysSnapshotCadence(result.state);
    }
    reveal isOpen();
    reveal isFinishing();
    reveal isSent();
    reveal ending();
    reveal isEnded();
    reveal alwaysOnlyAStreamingTurnCarriesText();
    reveal alwaysCaughtUpWhenFree();
    reveal alwaysAnAnnouncedReplyEndsAnswered();
    reveal readyPending();
    reveal stepOneFrameInFlight();
    reveal stepFramesRebuildTheText();
    reveal stepAppendsNeverClearTheMark();
    reveal stepMarkFollowsTheText();
    reveal isTextFrame();
    reveal stepOnlyARestartShortensTheText();
    reveal stepCadenceSnapshotsAtLeastDouble();
    reveal stepProgressNeverTouchesTheText();
    reveal stepReadyAtMostOnce();
    reveal isReadySent();
    reveal isReadyFrame();
    reveal stepNothingAfterTheEnd();
    reveal stepLeavingAbortsOnlyAnOwnRunningTurn();
  }
}

lemma {:induction false} ReplyStreamFlushedTextShape(s: ReplyStream, base: ReplyStream)
  requires inv(s) && canFrameFlushed(s) && s.phase.Open? && !ackWaiting(s.ack) && textPending(s)
  requires base == s.(inFlight := false, text := s.shown, held := s.shownHeld, ready := Readiness.NotReady, progress := Progress.NoProgress)
  ensures inv(base) && canRestartText(base)
  ensures frameFlushed(s).out == restartText(base, s.text, s.held).out
  ensures frameFlushed(s).state == restartText(base, s.text, s.held).state.(ready := s.ready, progress := s.progress)
  ensures frameFlushed(s).state.inFlight
  ensures s.role.Streams? && frameFlushed(s).state.role == s.role && frameFlushed(s).state.phase == s.phase
  ensures frameFlushed(s).state.text == s.text && frameFlushed(s).state.held == s.held
  ensures frameFlushed(s).state.ready == s.ready
  ensures frameFlushed(s).out == [Write(textFrame(s.(inFlight := false)))]
  ensures !textFrame(s.(inFlight := false)).ReadyFrame? && !textFrame(s.(inFlight := false)).Final?
{
  hide *;
  reveal inv();
  reveal canFrameFlushed();
  reveal alwaysOnlyAStreamingTurnCarriesText();
  reveal isOpen();
  assert s.role.Streams?;
  reveal alwaysCaughtUpWhenFree();
  reveal readyPending();
  reveal alwaysSnapshotCadence();
  reveal alwaysAnAnnouncedReplyEndsAnswered();
  reveal isFinishing();
  reveal isSent();
  reveal canRestartText();
  assert base.ack == s.ack;
  assert inv(base) && canRestartText(base);

  reveal frameFlushed();
  reveal restartText();
  reveal writeNext();
  reveal textPending();
  reveal appendable();
  reveal cadenceDue();
  reveal textFrame();
}

lemma {:induction false} ReplyStreamFlushedControlShape(s: ReplyStream)
  requires !s.phase.Finishing? && !(s.phase.Open? && ackWaiting(s.ack)) && !(s.phase.Open? && textPending(s))
  ensures frameFlushed(s) ==
    (if s.phase.Open? && s.ready.ReadyPending? then
      StreamStep(s.(inFlight := true, ready := ReadySent(s.ready.results)), [Write(ReadyFrame(s.ready.text, s.ready.results))])
     else if s.phase.Open? && !s.progress.NoProgress? then
      StreamStep(s.(inFlight := true, progress := Progress.NoProgress), [Write(Progressed(s.progress))])
     else StreamStep(s.(inFlight := false), []))
{
  hide *;
  reveal frameFlushed();
  reveal writeNext();
  reveal textPending();
  reveal isOpen();
  reveal isFinishing();
  reveal readyPending();
  reveal readySent();
  reveal readyFrame();
  reveal ackWaiting();
}

lemma {:induction false} ReplyStreamFlushedAckShape(s: ReplyStream)
  requires s.inFlight && s.phase.Open? && ackWaiting(s.ack)
  ensures frameFlushed(s) == StreamStep(s.(ack := AckSent), [Write(AckFrame(s.ack.cue))])
{
  hide *;
  reveal frameFlushed();
  ReplyStreamWriteNextAck(true, s);
  assert s.(inFlight := true, ack := AckSent) == s.(ack := AckSent);
}

lemma {:induction false} ReplyStreamAckFrameStep(before: ReplyStream, via: string, after: ReplyStream, out: seq<Effect>, cue: seq<int>)
  requires out == [Write(AckFrame(cue))]
  requires after == before.(inFlight := true, ack := AckSent)
  requires !before.ack.AckSent?
  requires before.role.Streams? && before.phase.Open?
  requires !before.inFlight || via == "frameFlushed"
  requires via != "clientLeft"
  requires alwaysSnapshotCadence(before)
  ensures alwaysOnlyAStreamingTurnCarriesText(after)
  ensures alwaysCaughtUpWhenFree(after)
  ensures alwaysSnapshotCadence(after)
  ensures alwaysAnAnnouncedReplyEndsAnswered(after)
  ensures stepOneFrameInFlight(before, via, after, out)
  ensures stepFramesRebuildTheText(before, after, out)
  ensures stepAppendsNeverClearTheMark(before, after, out)
  ensures stepMarkFollowsTheText(before, after, out)
  ensures stepOnlyARestartShortensTheText(before, via, after)
  ensures stepCadenceSnapshotsAtLeastDouble(before, after, out)
  ensures stepProgressNeverTouchesTheText(before, via, after)
  ensures stepAcknowledgingNeverTouchesTheText(before, via, after)
  ensures stepAcknowledgedAtMostOnce(before, after, out)
  ensures stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(before, after, out)
  ensures stepReadyAtMostOnce(before, after, out)
  ensures stepNothingAfterTheEnd(before, after, out)
  ensures stepLeavingAbortsOnlyAnOwnRunningTurn(before, via, after, out)
{
  hide *;
  var frame := AckFrame(cue);
  ReplyStreamControlViews(before.shown, out, frame);
  assert written(out) == [frame];
  assert frame in written(out) && isAckFrame(frame) by { reveal isAckFrame(); }
  reveal alwaysOnlyAStreamingTurnCarriesText();
  reveal alwaysCaughtUpWhenFree();
  reveal alwaysSnapshotCadence();
  reveal alwaysAnAnnouncedReplyEndsAnswered();
  reveal isOpen();
  reveal isFinishing();
  reveal isSent();
  reveal stepOneFrameInFlight();
  reveal stepFramesRebuildTheText();
  reveal stepAppendsNeverClearTheMark();
  reveal stepMarkFollowsTheText();
  reveal isTextFrame();
  reveal stepOnlyARestartShortensTheText();
  reveal stepCadenceSnapshotsAtLeastDouble();
  reveal stepProgressNeverTouchesTheText();
  reveal stepAcknowledgingNeverTouchesTheText();
  reveal stepAcknowledgedAtMostOnce();
  reveal stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame();
  reveal isAckFrame();
  reveal stepReadyAtMostOnce();
  reveal isReadySent();
  reveal isReadyFrame();
  reveal stepNothingAfterTheEnd();
  reveal isEnded();
  reveal stepLeavingAbortsOnlyAnOwnRunningTurn();
}

lemma acknowledge_ensures(s: ReplyStream, units: seq<int>)
  ensures (inv(s) ==> canAcknowledge(s, units) ==> alwaysOnlyAStreamingTurnCarriesText(acknowledge(s, units).state))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> alwaysCaughtUpWhenFree(acknowledge(s, units).state))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> alwaysSnapshotCadence(acknowledge(s, units).state))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> alwaysAnAnnouncedReplyEndsAnswered(acknowledge(s, units).state))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepOneFrameInFlight(s, "acknowledge", acknowledge(s, units).state, acknowledge(s, units).out))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepFramesRebuildTheText(s, acknowledge(s, units).state, acknowledge(s, units).out))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepAppendsNeverClearTheMark(s, acknowledge(s, units).state, acknowledge(s, units).out))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepMarkFollowsTheText(s, acknowledge(s, units).state, acknowledge(s, units).out))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepOnlyARestartShortensTheText(s, "acknowledge", acknowledge(s, units).state))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepCadenceSnapshotsAtLeastDouble(s, acknowledge(s, units).state, acknowledge(s, units).out))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepProgressNeverTouchesTheText(s, "acknowledge", acknowledge(s, units).state))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepAcknowledgedAtMostOnce(s, acknowledge(s, units).state, acknowledge(s, units).out))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, acknowledge(s, units).state, acknowledge(s, units).out))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepAcknowledgingNeverTouchesTheText(s, "acknowledge", acknowledge(s, units).state))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepReadyAtMostOnce(s, acknowledge(s, units).state, acknowledge(s, units).out))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepNothingAfterTheEnd(s, acknowledge(s, units).state, acknowledge(s, units).out))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "acknowledge", acknowledge(s, units).state, acknowledge(s, units).out))
{
  hide *;
  if inv(s) && canAcknowledge(s, units) {
    var next := s.(ack := AckWaiting(units));
    var result := acknowledge(s, units);
    assert result == writeNext(false, next) by { reveal acknowledge(); }
    assert s.role.Streams? && s.phase.Open? && s.ack.Unacknowledged? by {
      reveal canAcknowledge();
      reveal isOpen();
    }
    assert ackWaiting(next.ack) by { reveal ackWaiting(); }
    ReplyStreamWriteNextAck(false, next);
    reveal inv();
    if s.inFlight {
      assert result == StreamStep(next, []) by { reveal writeNext(); }
      assert written(result.out) == [] by {
        reveal written();
        reveal Std.Collections.Seq.FoldLeft();
      }
      assert rebuilt(s.shown, result.out) == s.shown by {
        reveal rebuilt();
        reveal written();
        reveal Std.Collections.Seq.FoldLeft();
      }
      assert !(exists e :: e in result.out && e.AbortTurn?);
      reveal alwaysOnlyAStreamingTurnCarriesText();
      reveal alwaysCaughtUpWhenFree();
      reveal alwaysSnapshotCadence();
      reveal alwaysAnAnnouncedReplyEndsAnswered();
      reveal isOpen();
      reveal isFinishing();
      reveal isSent();
      reveal stepOneFrameInFlight();
      reveal stepFramesRebuildTheText();
      reveal stepAppendsNeverClearTheMark();
      reveal stepMarkFollowsTheText();
      reveal stepOnlyARestartShortensTheText();
      reveal stepCadenceSnapshotsAtLeastDouble();
      reveal stepProgressNeverTouchesTheText();
      reveal stepAcknowledgingNeverTouchesTheText();
      reveal stepAcknowledgedAtMostOnce();
      reveal stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame();
      reveal ackWaiting();
      reveal stepReadyAtMostOnce();
      reveal stepNothingAfterTheEnd();
      reveal isEnded();
      reveal stepLeavingAbortsOnlyAnOwnRunningTurn();
    } else {
      assert result == StreamStep(s.(inFlight := true, ack := AckSent), [Write(AckFrame(units))]);
      ReplyStreamAckFrameStep(s, "acknowledge", result.state, result.out, units);
    }
  }
}
