lemma TokenIds(t: Tokenizers)
  ensures alwaysLoadNumbersAreIssuedOnce(t) == (t.nextLoad >= 0 && forall l :: l in t.loads ==> l.load >= 0 && l.load < t.nextLoad && |ProofLib.Filter((o: EncoderLoad) => (o.load == l.load), t.loads)| == 1)
{}

lemma TokenCallers(t: Tokenizers)
  ensures alwaysOneWaitPerCaller(t) == (forall w :: w in t.waits ==> |ProofLib.Filter((v: EncoderWait) => (v.caller == w.caller), t.waits)| == 1)
{}

lemma TokenLoadAt(t: Tokenizers, load: int)
  requires alwaysLoadNumbersAreIssuedOnce(t)
  ensures forall i :: 0 <= i < |t.loads| && t.loads[i].load == load ==> loadAt(t, load) == t.loads[i]
  ensures (forall i :: 0 <= i < |t.loads| ==> t.loads[i].load != load) ==> loadAt(t, load) == noLoad
{
  TokenIds(t);
  assert loadAt(t, load) == (if 0 < |ProofLib.Filter((l: EncoderLoad) => (l.load == load), t.loads)| then ProofLib.Filter((l: EncoderLoad) => (l.load == load), t.loads)[0] else noLoad);
  forall i | 0 <= i < |t.loads| && t.loads[i].load == load ensures loadAt(t, load) == t.loads[i] {
    var m := t.loads[i];
    assert m in t.loads;
    ProofLib.FilterSamePredicate((o: EncoderLoad) => (o.load == m.load), (l: EncoderLoad) => (l.load == load), t.loads);
    ProofLib.FilterMember((l: EncoderLoad) => (l.load == load), t.loads, m);
  }
  ProofLib.FilterNone((l: EncoderLoad) => (l.load == load), t.loads);
}

lemma TokenSameCaller(t: Tokenizers, a: EncoderWait, b: EncoderWait)
  requires alwaysOneWaitPerCaller(t)
  requires a in t.waits && b in t.waits && a.caller == b.caller
  ensures a == b
{
  TokenCallers(t);
  var f := ProofLib.Filter((v: EncoderWait) => (v.caller == a.caller), t.waits);
  ProofLib.FilterMember((v: EncoderWait) => (v.caller == a.caller), t.waits, a);
  ProofLib.FilterMember((v: EncoderWait) => (v.caller == a.caller), t.waits, b);
  assert |f| == 1;
}

lemma TokenMapLoads(t: Tokenizers, u: Tokenizers, load: int)
  requires alwaysLoadNumbersAreIssuedOnce(t)
  requires u.nextLoad == t.nextLoad && |u.loads| == |t.loads|
  requires forall i :: 0 <= i < |t.loads| ==> u.loads[i].load == t.loads[i].load && u.loads[i].encoding == t.loads[i].encoding && (t.loads[i].load != load ==> u.loads[i] == t.loads[i])
  ensures alwaysLoadNumbersAreIssuedOnce(u)
  ensures forall x :: loadAt(u, x).load == loadAt(t, x).load && loadAt(u, x).encoding == loadAt(t, x).encoding
  ensures forall x :: x != load ==> loadAt(u, x) == loadAt(t, x)
  ensures forall i :: 0 <= i < |t.loads| && t.loads[i].load == load ==> loadAt(u, load) == u.loads[i] && loadAt(t, load) == t.loads[i]
{
  TokenIds(t); TokenIds(u);
  forall l | l in u.loads ensures l.load >= 0 && l.load < u.nextLoad && |ProofLib.Filter((o: EncoderLoad) => (o.load == l.load), u.loads)| == 1 {
    var i :| 0 <= i < |u.loads| && u.loads[i] == l;
    var k := t.loads[i];
    assert k in t.loads;
    ProofLib.FilterSamePredicate((o: EncoderLoad) => (o.load == l.load), (o: EncoderLoad) => (o.load == k.load), t.loads);
    ProofLib.FilterLengthPointwise((o: EncoderLoad) => (o.load == l.load), (o: EncoderLoad) => (o.load == l.load), t.loads, u.loads);
  }
  forall x ensures loadAt(u, x).load == loadAt(t, x).load && loadAt(u, x).encoding == loadAt(t, x).encoding && (x != load ==> loadAt(u, x) == loadAt(t, x)) {
    TokenLoadAt(t, x); TokenLoadAt(u, x);
    if exists i :: 0 <= i < |t.loads| && t.loads[i].load == x {
      var i :| 0 <= i < |t.loads| && t.loads[i].load == x;
    }
  }
  TokenLoadAt(t, load); TokenLoadAt(u, load);
}

lemma TokenCacheSame(t: Tokenizers, u: Tokenizers)
  requires alwaysCacheCoherent(t)
  requires u.slots == t.slots && u.loads == t.loads
  ensures alwaysCacheCoherent(u)
{
  assert slotOf(u, 0) == slotOf(t, 0) && slotOf(u, 1) == slotOf(t, 1);
  forall x ensures loadAt(u, x) == loadAt(t, x) {}
  forall e ensures slotOf(u, e) == slotOf(t, e) {}
}

lemma observeEncoder_ensures(t: Tokenizers, caller: int)
  ensures (inv(t) ==> canObserveEncoder(t, caller) ==> alwaysLoadNumbersAreIssuedOnce(observeEncoder(t, caller)))
  ensures (inv(t) ==> canObserveEncoder(t, caller) ==> alwaysOneWaitPerCaller(observeEncoder(t, caller)))
  ensures (inv(t) ==> canObserveEncoder(t, caller) ==> alwaysCallersOwnTheirLoad(observeEncoder(t, caller)))
  ensures (inv(t) ==> canObserveEncoder(t, caller) ==> alwaysCacheCoherent(observeEncoder(t, caller)))
{
  if inv(t) && canObserveEncoder(t, caller) {
    var after := observeEncoder(t, caller);
    var w0 :| w0 in t.waits && (((w0.caller == caller) && w0.phase.Waiting?) && (loadAt(t, w0.load).phase.LoadReady? || loadAt(t, w0.load).phase.LoadFailed?));
    forall x ensures loadAt(after, x) == loadAt(t, x) {}
    TokenCacheSame(t, after);
    forall w | w in after.waits ensures loadAt(after, w.load).load == w.load && loadAt(after, w.load).encoding == w.encoding && (w.phase.Resolved? ==> loadAt(after, w.load).phase.LoadReady?) && (w.phase.Failed? ==> loadAt(after, w.load).phase.LoadFailed?) {
      var i :| 0 <= i < |after.waits| && after.waits[i] == w;
      var v := t.waits[i];
      assert v in t.waits;
      if v.caller == caller && v.phase.Waiting? { TokenSameCaller(t, v, w0); }
    }
    TokenCallers(t); TokenCallers(after);
    forall w | w in after.waits ensures |ProofLib.Filter((v: EncoderWait) => (v.caller == w.caller), after.waits)| == 1 {
      var i :| 0 <= i < |after.waits| && after.waits[i] == w;
      var k := t.waits[i];
      assert k in t.waits;
      ProofLib.FilterSamePredicate((v: EncoderWait) => (v.caller == w.caller), (v: EncoderWait) => (v.caller == k.caller), t.waits);
      ProofLib.FilterLengthPointwise((v: EncoderWait) => (v.caller == w.caller), (v: EncoderWait) => (v.caller == w.caller), t.waits, after.waits);
    }
  }
}

lemma requestEncoder_ensures(t: Tokenizers, caller: int, encoding: int)
  ensures (inv(t) ==> canRequestEncoder(t, caller, encoding) ==> alwaysLoadNumbersAreIssuedOnce(requestEncoder(t, caller, encoding)))
  ensures (inv(t) ==> canRequestEncoder(t, caller, encoding) ==> alwaysOneWaitPerCaller(requestEncoder(t, caller, encoding)))
  ensures (inv(t) ==> canRequestEncoder(t, caller, encoding) ==> alwaysCallersOwnTheirLoad(requestEncoder(t, caller, encoding)))
  ensures (inv(t) ==> canRequestEncoder(t, caller, encoding) ==> alwaysCacheCoherent(requestEncoder(t, caller, encoding)))
{
  if inv(t) && canRequestEncoder(t, caller, encoding) {
    var after := requestEncoder(t, caller, encoding);
    var hit := slotOf(t, encoding) >= 0;
    var load := if hit then slotOf(t, encoding) else t.nextLoad;
    var joined := EncoderWait(caller, encoding, load, WaitPhase.Waiting);
    var kept := ProofLib.Filter((w: EncoderWait) => (w.caller != caller), t.waits);
    assert after.waits == kept + [joined];
    assert t.slots == [t.slots[0], t.slots[1]];
    TokenIds(t); TokenIds(after);
    forall w | w in kept ensures w in t.waits && w.caller != caller { ProofLib.FilterMember((w: EncoderWait) => (w.caller != caller), t.waits, w); }
    TokenCallers(t); TokenCallers(after);
    forall w | w in after.waits ensures |ProofLib.Filter((v: EncoderWait) => (v.caller == w.caller), after.waits)| == 1 {
      ProofLib.FilterAppend((v: EncoderWait) => (v.caller == w.caller), kept, joined);
      if w == joined {
        forall i | 0 <= i < |kept| ensures kept[i].caller != w.caller { assert kept[i] in kept; }
        ProofLib.FilterNone((v: EncoderWait) => (v.caller == w.caller), kept);
      } else {
        assert w in kept;
        ProofLib.FilterOfFilterShorter((w: EncoderWait) => (w.caller != caller), (v: EncoderWait) => (v.caller == w.caller), t.waits);
        ProofLib.FilterMember((v: EncoderWait) => (v.caller == w.caller), kept, w);
      }
    }
    if hit {
      assert after.slots == t.slots && after.loads == t.loads;
      TokenCacheSame(t, after);
      forall x ensures loadAt(after, x) == loadAt(t, x) {}
    } else {
      var added := EncoderLoad(t.nextLoad, encoding, LoadPhase.LoadPending);
      assert after.loads == t.loads + [added];
      assert slotOf(t, encoding) == -1 by {
        TokenLoadAt(t, slotOf(t, encoding));
        assert slotCoherent(t, encoding);
        if slotOf(t, encoding) != -1 {
          var i :| 0 <= i < |t.loads| && t.loads[i].load == slotOf(t, encoding);
          assert t.loads[i] in t.loads;
        }
      }
      forall l | l in after.loads ensures l.load >= 0 && l.load < after.nextLoad && |ProofLib.Filter((o: EncoderLoad) => (o.load == l.load), after.loads)| == 1 {
        ProofLib.FilterAppend((o: EncoderLoad) => (o.load == l.load), t.loads, added);
        if l == added {
          forall i | 0 <= i < |t.loads| ensures t.loads[i].load != l.load { assert t.loads[i] in t.loads; }
          ProofLib.FilterNone((o: EncoderLoad) => (o.load == l.load), t.loads);
        }
      }
      forall x ensures (x == t.nextLoad ==> loadAt(after, x) == added) && (x != t.nextLoad ==> loadAt(after, x) == loadAt(t, x)) {
        TokenLoadAt(t, x); TokenLoadAt(after, x);
        assert after.loads[|t.loads|] == added;
        if exists i :: 0 <= i < |t.loads| && t.loads[i].load == x {
          var i :| 0 <= i < |t.loads| && t.loads[i].load == x;
          assert t.loads[i] in t.loads;
          assert after.loads[i] == t.loads[i];
        } else if x != t.nextLoad {
          forall i | 0 <= i < |after.loads| ensures after.loads[i].load != x { if i < |t.loads| { assert after.loads[i] == t.loads[i]; } }
        }
      }
      forall w | w in t.waits ensures w.load != t.nextLoad {
        TokenLoadAt(t, t.nextLoad);
        forall i | 0 <= i < |t.loads| ensures t.loads[i].load != t.nextLoad { assert t.loads[i] in t.loads; }
      }
      assert slotOf(after, encoding) == t.nextLoad;
      forall e | 0 <= e < 2 && e != encoding ensures slotOf(after, e) == slotOf(t, e) && slotOf(t, e) != t.nextLoad {
        if slotOf(t, e) != -1 {
          TokenLoadAt(t, t.nextLoad);
          forall i | 0 <= i < |t.loads| ensures t.loads[i].load != t.nextLoad { assert t.loads[i] in t.loads; }
        }
      }
      forall l | l in after.loads ensures retained(l.phase) == (slotOf(after, l.encoding) == l.load) {
        if l != added {
          assert l in t.loads;
          assert l.load < t.nextLoad;
        }
      }
    }
  }
}

lemma finishLoad_ensures(t: Tokenizers, load: int, ok: bool)
  ensures (inv(t) ==> canFinishLoad(t, load, ok) ==> alwaysLoadNumbersAreIssuedOnce(finishLoad(t, load, ok)))
  ensures (inv(t) ==> canFinishLoad(t, load, ok) ==> alwaysOneWaitPerCaller(finishLoad(t, load, ok)))
  ensures (inv(t) ==> canFinishLoad(t, load, ok) ==> alwaysCallersOwnTheirLoad(finishLoad(t, load, ok)))
  ensures (inv(t) ==> canFinishLoad(t, load, ok) ==> alwaysCacheCoherent(finishLoad(t, load, ok)))
{
  if inv(t) && canFinishLoad(t, load, ok) {
    var after := finishLoad(t, load, ok);
    TokenMapLoads(t, after, load);
    TokenLoadAt(t, load);
    forall i | 0 <= i < |t.loads| && t.loads[i].load == load ensures t.loads[i].phase.LoadPending? {}
    forall x ensures retained(loadAt(after, x).phase) == retained(loadAt(t, x).phase) && (loadAt(after, x).phase.LoadReady? ==> loadAt(t, x).phase.LoadReady? || x == load) && (loadAt(after, x).phase.LoadFailed? ==> loadAt(t, x).phase.LoadFailed?) && (x == load ==> !loadAt(t, x).phase.LoadReady? && !loadAt(t, x).phase.LoadFailed?) {
      if x == load && exists i :: 0 <= i < |t.loads| && t.loads[i].load == load {
        var i :| 0 <= i < |t.loads| && t.loads[i].load == load;
      }
    }
    forall l | l in after.loads ensures retained(l.phase) == (slotOf(after, l.encoding) == l.load) {
      var i :| 0 <= i < |after.loads| && after.loads[i] == l;
      assert t.loads[i] in t.loads;
    }
    forall e | 0 <= e < 2 ensures slotCoherent(after, e) {}
  }
}

lemma clearRejection_ensures(t: Tokenizers, load: int)
  ensures (inv(t) ==> canClearRejection(t, load) ==> alwaysLoadNumbersAreIssuedOnce(clearRejection(t, load)))
  ensures (inv(t) ==> canClearRejection(t, load) ==> alwaysOneWaitPerCaller(clearRejection(t, load)))
  ensures (inv(t) ==> canClearRejection(t, load) ==> alwaysCallersOwnTheirLoad(clearRejection(t, load)))
  ensures (inv(t) ==> canClearRejection(t, load) ==> alwaysCacheCoherent(clearRejection(t, load)))
{
  if inv(t) && canClearRejection(t, load) {
    var after := clearRejection(t, load);
    TokenMapLoads(t, after, load);
    TokenLoadAt(t, load);
    var target := loadAt(t, load);
    var i :| 0 <= i < |t.loads| && t.loads[i].load == load;
    assert target == t.loads[i] && target in t.loads;
    var enc := target.encoding;
    assert slotOf(t, enc) == load;
    assert t.slots == [t.slots[0], t.slots[1]];
    assert slotOf(after, enc) == -1;
    forall e | 0 <= e < 2 && e != enc ensures slotOf(after, e) == slotOf(t, e) {}
    forall x | x != load ensures loadAt(after, x) == loadAt(t, x) {}
    assert loadAt(after, load).phase.LoadFailed?;
    forall l | l in after.loads ensures retained(l.phase) == (slotOf(after, l.encoding) == l.load) {
      var j :| 0 <= j < |after.loads| && after.loads[j] == l;
      assert t.loads[j] in t.loads;
      TokenIds(t);
      if l.encoding == enc && t.loads[j].load != load {
        assert slotOf(t, enc) != t.loads[j].load;
      }
    }
    forall e | 0 <= e < 2 ensures slotCoherent(after, e) {
      if e != enc && slotOf(t, e) != -1 {
        assert slotOf(t, e) != load;
      }
    }
  }
}
