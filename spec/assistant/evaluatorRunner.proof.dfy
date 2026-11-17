lemma EvalLaneBounds(s: Evaluators)
  ensures alwaysProcessorProgressBounded(s) ==
    (forall lane :: lane in s.lanes ==>
      (0 <= lane.completed <= lane.candidate.processorCount && 0 <= lane.processorErrors <= lane.completed))
  ensures alwaysSuccessfulEvaluatorCompletedProcessors(s) ==
    (forall lane :: lane in s.lanes && lane.phase.SettledLane? ==>
      (lane.completed == lane.candidate.processorCount && lane.processorErrors == 0))
  ensures alwaysIncrementalEffectsAreStaged(s) ==
    (forall lane :: (lane in s.lanes && s.route.IncrementalEvidence? &&
      (lane.phase.ProcessingLane? || lane.phase.SettledLane?)) ==> lane.staged)
{}

lemma EvalInitialLanes(acc: seq<EvalLane>, candidates: seq<Candidate>)
  requires forall lane :: lane in acc ==>
    (lane.completed == 0 && lane.processorErrors == 0 &&
      lane.candidate.processorCount >= 0 && !lane.phase.SettledLane? && !lane.phase.ProcessingLane?)
  requires forall candidate :: candidate in candidates ==> candidate.processorCount >= 0
  ensures forall lane :: lane in Std.Collections.Seq.FoldLeft(
    (lanes: seq<EvalLane>, candidate: Candidate) => (lanes + [capturedLane(candidate, |lanes|)]), acc, candidates) ==>
    (lane.completed == 0 && lane.processorErrors == 0 &&
      lane.candidate.processorCount >= 0 && !lane.phase.SettledLane? && !lane.phase.ProcessingLane?)
  decreases |candidates|
{
  reveal Std.Collections.Seq.FoldLeft();
  if |candidates| > 0 {
    assert candidates[0] in candidates;
    var lane := capturedLane(candidates[0], |acc|);
    forall prior | prior in acc + [lane]
      ensures prior.completed == 0 && prior.processorErrors == 0 &&
        prior.candidate.processorCount >= 0 && !prior.phase.SettledLane? && !prior.phase.ProcessingLane?
    {
      if prior != lane { assert prior in acc; }
    }
    forall candidate | candidate in candidates[1..]
      ensures candidate.processorCount >= 0
    {
      assert candidate in candidates;
    }
    EvalInitialLanes(acc + [lane], candidates[1..]);
  }
}

lemma openBatch_ensures(s: Evaluators, route: EvaluatorInput, background: bool, candidates: seq<Candidate>)
  ensures (inv(s) ==> canOpenBatch(s, route, background, candidates) ==> alwaysProcessorProgressBounded(openBatch(s, route, background, candidates)))
  ensures (inv(s) ==> canOpenBatch(s, route, background, candidates) ==> alwaysSuccessfulEvaluatorCompletedProcessors(openBatch(s, route, background, candidates)))
  ensures (inv(s) ==> canOpenBatch(s, route, background, candidates) ==> alwaysIncrementalEffectsAreStaged(openBatch(s, route, background, candidates)))
{
  if inv(s) && canOpenBatch(s, route, background, candidates) {
    EvalInitialLanes([], candidates);
    EvalLaneBounds(openBatch(s, route, background, candidates));
  }
}
