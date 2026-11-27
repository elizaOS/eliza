lemma NewestFirstFold(f: (seq<string>, string) -> seq<string>, acc: seq<string>, xs: seq<string>)
  requires forall a, x :: f(a, x) == [x] + a
  ensures var res := Std.Collections.Seq.FoldLeft(f, acc, xs);
    |res| == |xs| + |acc|
    && (forall i :: 0 <= i < |xs| ==> res[i] == xs[|xs| - 1 - i])
    && (forall i :: 0 <= i < |acc| ==> res[|xs| + i] == acc[i])
  decreases |xs|
{
  if |xs| > 0 {
    var next := [xs[0]] + acc;
    assert f(acc, xs[0]) == next;
    NewestFirstFold(f, next, xs[1..]);
    var res := Std.Collections.Seq.FoldLeft(f, next, xs[1..]);
    forall i | 0 <= i < |xs| ensures res[i] == xs[|xs| - 1 - i] {
      if i < |xs| - 1 {
        assert xs[1..][|xs| - 2 - i] == xs[|xs| - 1 - i];
      } else {
        assert res[|xs[1..]| + 0] == next[0];
      }
    }
    forall i | 0 <= i < |acc| ensures res[|xs| + i] == acc[i] {
      assert res[|xs[1..]| + (i + 1)] == next[i + 1];
    }
  }
}

lemma NewestFirstStoreLast(xs: seq<string>)
  requires forall i :: 1 <= i < |xs| ==> xs[i] != "store"
  ensures var rev := agent__host__resources_newestFirst(xs);
    |rev| == |xs| && (forall i :: 0 <= i < |rev| - 1 ==> rev[i] != "store")
{
  var f := (acc: seq<string>, x: string) => ([x] + acc);
  NewestFirstFold(f, [], xs);
}

lemma releaseNext_ensures(s: AgentProcess, ok: bool)
  ensures (inv(s) ==> canReleaseNext(s, ok) ==> (refinesR(releaseNext(s, ok)) == refinesR(s)))
  ensures (inv(s) ==> canReleaseNext(s, ok) ==> alwaysLaunchRefusalHoldsNothing(releaseNext(s, ok)))
  ensures (inv(s) ==> canReleaseNext(s, ok) ==> alwaysAdmissionFollowsBoot(releaseNext(s, ok)))
  ensures (inv(s) ==> canReleaseNext(s, ok) ==> alwaysHeldFollowsBoot(releaseNext(s, ok)))
  ensures (inv(s) ==> canReleaseNext(s, ok) ==> alwaysHealthyMeansServing(releaseNext(s, ok)))
  ensures (inv(s) ==> canReleaseNext(s, ok) ==> alwaysRunningIffHealthy(releaseNext(s, ok)))
  ensures (inv(s) ==> canReleaseNext(s, ok) ==> alwaysStopFollowsRequests(releaseNext(s, ok)))
  ensures (inv(s) ==> canReleaseNext(s, ok) ==> alwaysReleaseFollowsCoreStop(releaseNext(s, ok)))
  ensures (inv(s) ==> canReleaseNext(s, ok) ==> alwaysExitCodeHonest(releaseNext(s, ok)))
  ensures (inv(s) ==> canReleaseNext(s, ok) ==> stepBootAdvancesOnePhaseAtATime(s, releaseNext(s, ok)))
  ensures (inv(s) ==> canReleaseNext(s, ok) ==> stepFailureIsFinal(s, releaseNext(s, ok)))
  ensures (inv(s) ==> canReleaseNext(s, ok) ==> stepRepeatedSignalJoinsTheStop(s, "releaseNext", releaseNext(s, ok)))
  ensures (inv(s) ==> canReleaseNext(s, ok) ==> stepNoReboot(s, releaseNext(s, ok)))
{
  if inv(s) && canReleaseNext(s, ok) {
    var after := releaseNext(s, ok);
    var held := s.resources.held;
    assert held == bootHeld(s);
    assert forall i :: 1 <= i < |held| ==> held[i] != "store";
    NewestFirstStoreLast(held);
    var rev := agent__host__resources_newestFirst(held);
    assert s.resources.released + s.resources.pending == rev;
    assert after.resources.released + after.resources.pending == rev;
    var next := s.resources.pending[0];
    if next == "store" {
      if |s.resources.pending| == 1 {
        assert s.resources.pending == ["store"];
        assert false;
      } else {
        var idx := |s.resources.released|;
        assert 0 <= idx < |rev| - 1;
        assert rev[idx] == "store";
        assert false;
      }
    }
    assert next != "store";
  }
}
