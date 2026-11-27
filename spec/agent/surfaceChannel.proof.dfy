lemma OrderedFoldFrom(f: (int, Pending) -> int, acc: int, xs: seq<Pending>)
  requires forall prior, c :: f(prior, c) == (if ((prior >= 0) && (c.id > prior)) then c.id else -1)
  ensures var res := Std.Collections.Seq.FoldLeft(f, acc, xs);
    (res >= 0 <==> (acc >= 0 && (|xs| > 0 ==> xs[0].id > acc) && (forall i :: 1 <= i < |xs| ==> xs[i].id > xs[i - 1].id)))
    && (res >= 0 ==> res == (if |xs| == 0 then acc else xs[|xs| - 1].id))
    && (res >= 0 ==> forall i, j :: 0 <= i < j < |xs| ==> xs[i].id < xs[j].id)
  decreases |xs|
{
  if |xs| > 0 {
    var next := f(acc, xs[0]);
    OrderedFoldFrom(f, next, xs[1..]);
    if acc >= 0 && xs[0].id > acc && (forall i :: 1 <= i < |xs| ==> xs[i].id > xs[i - 1].id) {
      assert next == xs[0].id && next >= 0;
      if |xs[1..]| > 0 {
        assert xs[1..][0] == xs[1] && xs[1].id > xs[0].id;
      }
      forall i | 1 <= i < |xs[1..]| ensures xs[1..][i].id > xs[1..][i - 1].id {
        assert xs[1..][i] == xs[i + 1] && xs[1..][i - 1] == xs[i];
      }
    }
    var res := Std.Collections.Seq.FoldLeft(f, next, xs[1..]);
    if res >= 0 {
      assert next >= 0;
      assert acc >= 0 && xs[0].id > acc;
      forall i | 1 <= i < |xs| ensures xs[i].id > xs[i - 1].id {
        if i == 1 {
          assert xs[1..][0] == xs[1];
        } else {
          assert xs[1..][i - 1] == xs[i] && xs[1..][i - 2] == xs[i - 1];
        }
      }
      forall i, j | 0 <= i < j < |xs| ensures xs[i].id < xs[j].id {
        if i == 0 {
          if j == 1 {
            assert xs[1..][0] == xs[1];
          } else {
            assert xs[1..][0] == xs[1] && xs[1..][j - 1] == xs[j];
          }
        } else {
          assert xs[1..][i - 1] == xs[i] && xs[1..][j - 1] == xs[j];
        }
      }
    }
  }
}

lemma PendingOrderSpec(s: Channel)
  ensures alwaysPendingInSendOrder(s) <==> ((|s.pending| > 0 ==> s.pending[0].id > 0) && (forall i :: 1 <= i < |s.pending| ==> s.pending[i].id > s.pending[i - 1].id))
  ensures alwaysPendingInSendOrder(s) ==> forall i, j :: 0 <= i < j < |s.pending| ==> s.pending[i].id < s.pending[j].id
{
  var f := (prior: int, c: Pending) => (if ((prior >= 0) && (c.id > prior)) then c.id else -1);
  OrderedFoldFrom(f, 0, s.pending);
}

lemma FilterPreservesOrdered(p: Pending -> bool, xs: seq<Pending>, lo: int)
  requires lo >= 0
  requires |xs| > 0 ==> xs[0].id > lo
  requires forall i :: 1 <= i < |xs| ==> xs[i].id > xs[i - 1].id
  requires forall i, j :: 0 <= i < j < |xs| ==> xs[i].id < xs[j].id
  ensures var ys := ProofLib.Filter(p, xs);
    (|ys| > 0 ==> ys[0].id > lo) && (forall i :: 1 <= i < |ys| ==> ys[i].id > ys[i - 1].id)
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    var tail := xs[1..];
    var ft := ProofLib.Filter(p, tail);
    if |tail| > 0 {
      assert tail[0] == xs[1] && xs[1].id > xs[0].id;
    }
    forall i | 1 <= i < |tail| ensures tail[i].id > tail[i - 1].id {
      assert tail[i] == xs[i + 1] && tail[i - 1] == xs[i];
    }
    forall i, j | 0 <= i < j < |tail| ensures tail[i].id < tail[j].id {
      assert tail[i] == xs[i + 1] && tail[j] == xs[j + 1];
    }
    FilterPreservesOrdered(p, tail, xs[0].id);
    if p(xs[0]) {
      var ys := [xs[0]] + ft;
      assert ProofLib.Filter(p, xs) == ys;
      forall i | 1 <= i < |ys| ensures ys[i].id > ys[i - 1].id {
        if i == 1 {
          assert ys[1] == ft[0];
        } else {
          assert ys[i] == ft[i - 1] && ys[i - 1] == ft[i - 2];
        }
      }
    } else {
      assert ProofLib.Filter(p, xs) == ft;
    }
  }
}

lemma FilterFirstIsMin(p: Pending -> bool, xs: seq<Pending>)
  requires forall i, j :: 0 <= i < j < |xs| ==> xs[i].id < xs[j].id
  requires |ProofLib.Filter(p, xs)| > 0
  ensures var first := ProofLib.Filter(p, xs)[0];
    first in xs && p(first) && (forall c :: c in xs && p(c) ==> first.id <= c.id)
  decreases |xs|
{
  ProofLib.FilterCons(p, xs);
  var tail := xs[1..];
  assert forall i, j :: 0 <= i < j < |tail| ==> tail[i].id < tail[j].id;
  if p(xs[0]) {
    assert ProofLib.Filter(p, xs)[0] == xs[0];
    forall c | c in xs && p(c) ensures xs[0].id <= c.id {
      var k :| 0 <= k < |xs| && xs[k] == c;
      if k > 0 {
        assert xs[0].id < xs[k].id;
      }
    }
  } else {
    FilterFirstIsMin(p, tail);
  }
}

lemma FilterLengthBound<T>(p: T -> bool, xs: seq<T>)
  ensures |ProofLib.Filter(p, xs)| <= |xs|
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    FilterLengthBound(p, xs[1..]);
  }
}

lemma RetirementStep(close: bool, s: Channel)
  requires inv(s)
  ensures var after := retirement(close, s);
    stepNoCommandVanishes(s, after.state, after.out)
    && stepEverySettlementIsHonest(s, after.state, after.out)
    && stepSettledCommandsLeave(s, after.state, after.out)
{
  var after := retirement(close, s);
  forall c | c in s.pending ensures exists o :: o in after.out && o.id == c.id {
    var i :| 0 <= i < |s.pending| && s.pending[i] == c;
    assert after.out[i] in after.out && after.out[i].id == c.id;
  }
}

lemma HandOverDropPreserves(s: Channel, next: Pending)
  requires inv(s) && next in s.pending && next.id > s.lastSequence && next.deadline <= s.now
  ensures var neq := (c: Pending) => (c.id != next.id);
    var afterPending := ProofLib.Filter(neq, s.pending);
    var afterState := s.(holding := false, cancellations := [], expiresAt := (s.now + connectionTtlMs), pending := afterPending);
    var out := [Settlement(next.id, Outcome.Stale)];
    alwaysIdsAreFresh(afterState)
    && alwaysPendingInSendOrder(afterState)
    && alwaysCancellationsFitTheQueue(afterState)
    && stepNoCommandVanishes(s, afterState, out)
    && stepEverySettlementIsHonest(s, afterState, out)
    && stepSettledCommandsLeave(s, afterState, out)
{
  PendingOrderSpec(s);
  var neq := (c: Pending) => (c.id != next.id);
  var afterPending := ProofLib.Filter(neq, s.pending);
  var afterState := s.(holding := false, cancellations := [], expiresAt := (s.now + connectionTtlMs), pending := afterPending);
  var out := [Settlement(next.id, Outcome.Stale)];
  FilterPreservesOrdered(neq, s.pending, 0);
  PendingOrderSpec(afterState);
  FilterLengthBound(neq, s.pending);
  FilterLengthBound((c: Pending) => handedOver(c, afterState.lastSequence), afterPending);
  forall c | c in s.pending ensures (exists d :: d in afterPending && d.id == c.id) || (exists o :: o in out && o.id == c.id) {
    ProofLib.FilterMember(neq, s.pending, c);
    if c.id == next.id {
      assert out[0] in out && out[0].id == c.id;
    }
  }
  forall c | c in afterPending ensures c in s.pending && c.id != next.id {
    ProofLib.FilterMember(neq, s.pending, c);
  }
}

lemma HandOverPreserves(connection: int, s: Channel)
  requires inv(s) && isCurrent(s, connection)
  ensures var after := handOver(connection, s);
    alwaysPendingNeedsAConnection(after.state)
    && alwaysIdsAreFresh(after.state)
    && alwaysPendingInSendOrder(after.state)
    && alwaysCancellationsFitTheQueue(after.state)
    && stepEpochsOnlyRise(s, after.state)
    && stepNoCommandVanishes(s, after.state, after.out)
    && stepSequenceOnlyRises(s, after.state)
    && stepHandsOverOldestOnly(s, after.state)
    && stepEverySettlementIsHonest(s, after.state, after.out)
    && stepSettledCommandsLeave(s, after.state, after.out)
{
  PendingOrderSpec(s);
  var gt := (c: Pending) => (c.id > s.lastSequence);
  var waiting := ProofLib.Filter(gt, s.pending);
  var next := nextToHand(s);
  var after := handOver(connection, s);
  if |waiting| == 0 {
    assert next == noCommand && next.id == 0;
  } else {
    FilterFirstIsMin(gt, s.pending);
    assert next == waiting[0];
    assert next in s.pending && next.id > s.lastSequence && next.id >= 1 && next.id < s.nextId;
    if next.deadline > s.now {
      FilterLengthBound((c: Pending) => handedOver(c, after.state.lastSequence), after.state.pending);
    } else {
      HandOverDropPreserves(s, next);
    }
  }
}

lemma connect_ensures(s: Channel, epoch: int)
  ensures (inv(s) ==> canConnect(s, epoch) ==> alwaysPendingNeedsAConnection(connect(s, epoch).state))
  ensures (inv(s) ==> canConnect(s, epoch) ==> alwaysIdsAreFresh(connect(s, epoch).state))
  ensures (inv(s) ==> canConnect(s, epoch) ==> alwaysPendingInSendOrder(connect(s, epoch).state))
  ensures (inv(s) ==> canConnect(s, epoch) ==> alwaysCancellationsFitTheQueue(connect(s, epoch).state))
  ensures (inv(s) ==> canConnect(s, epoch) ==> stepEpochsOnlyRise(s, connect(s, epoch).state))
  ensures (inv(s) ==> canConnect(s, epoch) ==> stepNoCommandVanishes(s, connect(s, epoch).state, connect(s, epoch).out))
  ensures (inv(s) ==> canConnect(s, epoch) ==> stepSequenceOnlyRises(s, connect(s, epoch).state))
  ensures (inv(s) ==> canConnect(s, epoch) ==> stepHandsOverOldestOnly(s, connect(s, epoch).state))
  ensures (inv(s) ==> canConnect(s, epoch) ==> stepEverySettlementIsHonest(s, connect(s, epoch).state, connect(s, epoch).out))
  ensures (inv(s) ==> canConnect(s, epoch) ==> stepSettledCommandsLeave(s, connect(s, epoch).state, connect(s, epoch).out))
{
  if inv(s) && canConnect(s, epoch) {
    RetirementStep(false, s);
  }
}

lemma closeConnection_ensures(s: Channel, connection: int)
  ensures (inv(s) ==> canCloseConnection(s, connection) ==> alwaysPendingNeedsAConnection(closeConnection(s, connection).state))
  ensures (inv(s) ==> canCloseConnection(s, connection) ==> alwaysIdsAreFresh(closeConnection(s, connection).state))
  ensures (inv(s) ==> canCloseConnection(s, connection) ==> alwaysPendingInSendOrder(closeConnection(s, connection).state))
  ensures (inv(s) ==> canCloseConnection(s, connection) ==> alwaysCancellationsFitTheQueue(closeConnection(s, connection).state))
  ensures (inv(s) ==> canCloseConnection(s, connection) ==> stepEpochsOnlyRise(s, closeConnection(s, connection).state))
  ensures (inv(s) ==> canCloseConnection(s, connection) ==> stepNoCommandVanishes(s, closeConnection(s, connection).state, closeConnection(s, connection).out))
  ensures (inv(s) ==> canCloseConnection(s, connection) ==> stepSequenceOnlyRises(s, closeConnection(s, connection).state))
  ensures (inv(s) ==> canCloseConnection(s, connection) ==> stepHandsOverOldestOnly(s, closeConnection(s, connection).state))
  ensures (inv(s) ==> canCloseConnection(s, connection) ==> stepEverySettlementIsHonest(s, closeConnection(s, connection).state, closeConnection(s, connection).out))
  ensures (inv(s) ==> canCloseConnection(s, connection) ==> stepSettledCommandsLeave(s, closeConnection(s, connection).state, closeConnection(s, connection).out))
{
  if inv(s) && canCloseConnection(s, connection) {
    RetirementStep(false, s);
  }
}

lemma lapse_ensures(s: Channel)
  ensures (inv(s) ==> canLapse(s) ==> alwaysPendingNeedsAConnection(lapse(s).state))
  ensures (inv(s) ==> canLapse(s) ==> alwaysIdsAreFresh(lapse(s).state))
  ensures (inv(s) ==> canLapse(s) ==> alwaysPendingInSendOrder(lapse(s).state))
  ensures (inv(s) ==> canLapse(s) ==> alwaysCancellationsFitTheQueue(lapse(s).state))
  ensures (inv(s) ==> canLapse(s) ==> stepEpochsOnlyRise(s, lapse(s).state))
  ensures (inv(s) ==> canLapse(s) ==> stepNoCommandVanishes(s, lapse(s).state, lapse(s).out))
  ensures (inv(s) ==> canLapse(s) ==> stepSequenceOnlyRises(s, lapse(s).state))
  ensures (inv(s) ==> canLapse(s) ==> stepHandsOverOldestOnly(s, lapse(s).state))
  ensures (inv(s) ==> canLapse(s) ==> stepEverySettlementIsHonest(s, lapse(s).state, lapse(s).out))
  ensures (inv(s) ==> canLapse(s) ==> stepSettledCommandsLeave(s, lapse(s).state, lapse(s).out))
{
  if inv(s) && canLapse(s) {
    RetirementStep(false, s);
  }
}

lemma shutdown_ensures(s: Channel)
  ensures (inv(s) ==> canShutdown(s) ==> alwaysPendingNeedsAConnection(shutdown(s).state))
  ensures (inv(s) ==> canShutdown(s) ==> alwaysIdsAreFresh(shutdown(s).state))
  ensures (inv(s) ==> canShutdown(s) ==> alwaysPendingInSendOrder(shutdown(s).state))
  ensures (inv(s) ==> canShutdown(s) ==> alwaysCancellationsFitTheQueue(shutdown(s).state))
  ensures (inv(s) ==> canShutdown(s) ==> stepEpochsOnlyRise(s, shutdown(s).state))
  ensures (inv(s) ==> canShutdown(s) ==> stepNoCommandVanishes(s, shutdown(s).state, shutdown(s).out))
  ensures (inv(s) ==> canShutdown(s) ==> stepSequenceOnlyRises(s, shutdown(s).state))
  ensures (inv(s) ==> canShutdown(s) ==> stepHandsOverOldestOnly(s, shutdown(s).state))
  ensures (inv(s) ==> canShutdown(s) ==> stepEverySettlementIsHonest(s, shutdown(s).state, shutdown(s).out))
  ensures (inv(s) ==> canShutdown(s) ==> stepSettledCommandsLeave(s, shutdown(s).state, shutdown(s).out))
{
  if inv(s) && canShutdown(s) {
    RetirementStep(true, s);
  }
}

lemma send_ensures(s: Channel, connection: int, effect: bool)
  ensures (inv(s) ==> canSend(s, connection) ==> alwaysPendingNeedsAConnection(send(s, connection, effect)))
  ensures (inv(s) ==> canSend(s, connection) ==> alwaysIdsAreFresh(send(s, connection, effect)))
  ensures (inv(s) ==> canSend(s, connection) ==> alwaysPendingInSendOrder(send(s, connection, effect)))
  ensures (inv(s) ==> canSend(s, connection) ==> alwaysCancellationsFitTheQueue(send(s, connection, effect)))
  ensures (inv(s) ==> canSend(s, connection) ==> stepEpochsOnlyRise(s, send(s, connection, effect)))
  ensures (inv(s) ==> canSend(s, connection) ==> stepNoCommandVanishes(s, send(s, connection, effect), []))
  ensures (inv(s) ==> canSend(s, connection) ==> stepSequenceOnlyRises(s, send(s, connection, effect)))
  ensures (inv(s) ==> canSend(s, connection) ==> stepHandsOverOldestOnly(s, send(s, connection, effect)))
  ensures (inv(s) ==> canSend(s, connection) ==> stepEverySettlementIsHonest(s, send(s, connection, effect), []))
  ensures (inv(s) ==> canSend(s, connection) ==> stepSettledCommandsLeave(s, send(s, connection, effect), []))
{
  if inv(s) && canSend(s, connection) {
    var added := Pending(s.nextId, effect, s.now + commandTimeoutMs);
    var f := (prior: int, c: Pending) => (if ((prior >= 0) && (c.id > prior)) then c.id else -1);
    OrderedFoldFrom(f, 0, s.pending);
    ProofLib.FoldLeftAppend(f, 0, s.pending, added);
    if |s.pending| > 0 {
      assert s.pending[|s.pending| - 1] in s.pending;
    }
    var h := (c: Pending) => handedOver(c, s.lastSequence);
    ProofLib.FilterAppend(h, s.pending, added);
  }
}

lemma pull_ensures(s: Channel, connection: int)
  ensures (inv(s) ==> canPull(s, connection) ==> alwaysPendingNeedsAConnection(pull(s, connection).state))
  ensures (inv(s) ==> canPull(s, connection) ==> alwaysIdsAreFresh(pull(s, connection).state))
  ensures (inv(s) ==> canPull(s, connection) ==> alwaysPendingInSendOrder(pull(s, connection).state))
  ensures (inv(s) ==> canPull(s, connection) ==> alwaysCancellationsFitTheQueue(pull(s, connection).state))
  ensures (inv(s) ==> canPull(s, connection) ==> stepEpochsOnlyRise(s, pull(s, connection).state))
  ensures (inv(s) ==> canPull(s, connection) ==> stepNoCommandVanishes(s, pull(s, connection).state, pull(s, connection).out))
  ensures (inv(s) ==> canPull(s, connection) ==> stepSequenceOnlyRises(s, pull(s, connection).state))
  ensures (inv(s) ==> canPull(s, connection) ==> stepHandsOverOldestOnly(s, pull(s, connection).state))
  ensures (inv(s) ==> canPull(s, connection) ==> stepEverySettlementIsHonest(s, pull(s, connection).state, pull(s, connection).out))
  ensures (inv(s) ==> canPull(s, connection) ==> stepSettledCommandsLeave(s, pull(s, connection).state, pull(s, connection).out))
{
  if inv(s) && canPull(s, connection) && hasWork(s) {
    HandOverPreserves(connection, s);
  }
}

lemma answerHeldPull_ensures(s: Channel, connection: int)
  ensures (inv(s) ==> canAnswerHeldPull(s, connection) ==> alwaysPendingNeedsAConnection(answerHeldPull(s, connection).state))
  ensures (inv(s) ==> canAnswerHeldPull(s, connection) ==> alwaysIdsAreFresh(answerHeldPull(s, connection).state))
  ensures (inv(s) ==> canAnswerHeldPull(s, connection) ==> alwaysPendingInSendOrder(answerHeldPull(s, connection).state))
  ensures (inv(s) ==> canAnswerHeldPull(s, connection) ==> alwaysCancellationsFitTheQueue(answerHeldPull(s, connection).state))
  ensures (inv(s) ==> canAnswerHeldPull(s, connection) ==> stepEpochsOnlyRise(s, answerHeldPull(s, connection).state))
  ensures (inv(s) ==> canAnswerHeldPull(s, connection) ==> stepNoCommandVanishes(s, answerHeldPull(s, connection).state, answerHeldPull(s, connection).out))
  ensures (inv(s) ==> canAnswerHeldPull(s, connection) ==> stepSequenceOnlyRises(s, answerHeldPull(s, connection).state))
  ensures (inv(s) ==> canAnswerHeldPull(s, connection) ==> stepHandsOverOldestOnly(s, answerHeldPull(s, connection).state))
  ensures (inv(s) ==> canAnswerHeldPull(s, connection) ==> stepEverySettlementIsHonest(s, answerHeldPull(s, connection).state, answerHeldPull(s, connection).out))
  ensures (inv(s) ==> canAnswerHeldPull(s, connection) ==> stepSettledCommandsLeave(s, answerHeldPull(s, connection).state, answerHeldPull(s, connection).out))
{
  if inv(s) && canAnswerHeldPull(s, connection) {
    HandOverPreserves(connection, s);
  }
}

lemma reply_ensures(s: Channel, connection: int, id: int, succeeded: bool)
  ensures (inv(s) ==> canReply(s, connection, id, succeeded) ==> alwaysPendingNeedsAConnection(reply(s, connection, id, succeeded).state))
  ensures (inv(s) ==> canReply(s, connection, id, succeeded) ==> alwaysIdsAreFresh(reply(s, connection, id, succeeded).state))
  ensures (inv(s) ==> canReply(s, connection, id, succeeded) ==> alwaysPendingInSendOrder(reply(s, connection, id, succeeded).state))
  ensures (inv(s) ==> canReply(s, connection, id, succeeded) ==> alwaysCancellationsFitTheQueue(reply(s, connection, id, succeeded).state))
  ensures (inv(s) ==> canReply(s, connection, id, succeeded) ==> stepEpochsOnlyRise(s, reply(s, connection, id, succeeded).state))
  ensures (inv(s) ==> canReply(s, connection, id, succeeded) ==> stepNoCommandVanishes(s, reply(s, connection, id, succeeded).state, reply(s, connection, id, succeeded).out))
  ensures (inv(s) ==> canReply(s, connection, id, succeeded) ==> stepSequenceOnlyRises(s, reply(s, connection, id, succeeded).state))
  ensures (inv(s) ==> canReply(s, connection, id, succeeded) ==> stepHandsOverOldestOnly(s, reply(s, connection, id, succeeded).state))
  ensures (inv(s) ==> canReply(s, connection, id, succeeded) ==> stepEverySettlementIsHonest(s, reply(s, connection, id, succeeded).state, reply(s, connection, id, succeeded).out))
  ensures (inv(s) ==> canReply(s, connection, id, succeeded) ==> stepSettledCommandsLeave(s, reply(s, connection, id, succeeded).state, reply(s, connection, id, succeeded).out))
{
  if inv(s) && canReply(s, connection, id, succeeded) {
    var after := reply(s, connection, id, succeeded);
    var neq := (c: Pending) => (c.id != id);
    var h := (c: Pending) => handedOver(c, s.lastSequence);
    PendingOrderSpec(s);
    FilterPreservesOrdered(neq, s.pending, 0);
    PendingOrderSpec(after.state);
    FilterLengthBound(neq, s.pending);
    ProofLib.FilterOfFilterLength(neq, h, h, s.pending);
    forall c | c in s.pending ensures (exists d :: d in after.state.pending && d.id == c.id) || (exists o :: o in after.out && o.id == c.id) {
      ProofLib.FilterMember(neq, s.pending, c);
      if c.id == id {
        assert after.out[0] in after.out && after.out[0].id == c.id;
      }
    }
    forall c | c in after.state.pending ensures c in s.pending && c.id != id {
      ProofLib.FilterMember(neq, s.pending, c);
    }
  }
}

lemma cancel_ensures(s: Channel, id: int)
  ensures (inv(s) ==> canCancel(s, id) ==> alwaysPendingNeedsAConnection(cancel(s, id).state))
  ensures (inv(s) ==> canCancel(s, id) ==> alwaysIdsAreFresh(cancel(s, id).state))
  ensures (inv(s) ==> canCancel(s, id) ==> alwaysPendingInSendOrder(cancel(s, id).state))
  ensures (inv(s) ==> canCancel(s, id) ==> alwaysCancellationsFitTheQueue(cancel(s, id).state))
  ensures (inv(s) ==> canCancel(s, id) ==> stepEpochsOnlyRise(s, cancel(s, id).state))
  ensures (inv(s) ==> canCancel(s, id) ==> stepNoCommandVanishes(s, cancel(s, id).state, cancel(s, id).out))
  ensures (inv(s) ==> canCancel(s, id) ==> stepSequenceOnlyRises(s, cancel(s, id).state))
  ensures (inv(s) ==> canCancel(s, id) ==> stepHandsOverOldestOnly(s, cancel(s, id).state))
  ensures (inv(s) ==> canCancel(s, id) ==> stepEverySettlementIsHonest(s, cancel(s, id).state, cancel(s, id).out))
  ensures (inv(s) ==> canCancel(s, id) ==> stepSettledCommandsLeave(s, cancel(s, id).state, cancel(s, id).out))
{
  if inv(s) && canCancel(s, id) {
    var after := cancel(s, id);
    var neq := (c: Pending) => (c.id != id);
    var h := (c: Pending) => handedOver(c, s.lastSequence);
    PendingOrderSpec(s);
    FilterPreservesOrdered(neq, s.pending, 0);
    PendingOrderSpec(after.state);
    FilterLengthBound(neq, s.pending);
    ProofLib.FilterOfFilterLength(neq, h, h, s.pending);
    var idx :| 0 <= idx < |s.pending| && s.pending[idx].id == id;
    var target := s.pending[idx];
    if id <= s.lastSequence {
      assert h(target) && !neq(target);
      assert |ProofLib.Filter(h, after.state.pending)| < |ProofLib.Filter(h, s.pending)|;
    }
    forall c | c in s.pending && c.id == id ensures c == target {
      var j :| 0 <= j < |s.pending| && s.pending[j] == c;
      if j != idx {
        assert false;
      }
    }
    forall c | c in s.pending ensures (exists d :: d in after.state.pending && d.id == c.id) || (exists o :: o in after.out && o.id == c.id) {
      ProofLib.FilterMember(neq, s.pending, c);
      if c.id == id {
        assert after.out[0] in after.out && after.out[0].id == c.id;
      }
    }
    forall c | c in after.state.pending ensures c in s.pending && c.id != id {
      ProofLib.FilterMember(neq, s.pending, c);
    }
  }
}
