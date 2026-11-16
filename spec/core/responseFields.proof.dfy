lemma FieldUnionMembership(xs: seq<string>, name: string)
  ensures name in xs + ProofLib.Filter((set_x: string) => !((set_x in xs)), [name])
  ensures forall item :: item in xs + ProofLib.Filter((set_x: string) => !((set_x in xs)), [name]) ==> item in xs || item == name
{
  ProofLib.FilterMember((set_x: string) => !((set_x in xs)), [name], name);
  forall item | item in xs + ProofLib.Filter((set_x: string) => !((set_x in xs)), [name])
    ensures item in xs || item == name
  {
    ProofLib.FilterMember((set_x: string) => !((set_x in xs)), [name], item);
  }
}

lemma FieldExcludedMembership(xs: seq<string>, name: string)
  ensures forall item :: item in ProofLib.Filter((set_x: string) => !((set_x in [name])), xs) ==> item in xs && item != name
{
  forall item | item in ProofLib.Filter((set_x: string) => !((set_x in [name])), xs)
    ensures item in xs && item != name
  {
    ProofLib.FilterMember((set_x: string) => !((set_x in [name])), xs, item);
  }
}

lemma FieldDisjointMembers(ready: seq<string>, attempted: seq<string>)
  requires |ProofLib.Filter((set_x: string) => (set_x in attempted), ready)| == 0
  ensures forall item :: item in ready ==> item !in attempted
{
  forall item | item in ready ensures item !in attempted {
    ProofLib.FilterMember((set_x: string) => (set_x in attempted), ready, item);
  }
}

lemma FieldParseFieldView(f: FieldDispatch, name: string, parseResult: ParseOutcome, hasHandler: bool)
  ensures parseField(f, name, parseResult, hasHandler) == (f.(pending := ProofLib.Filter((set_x: string) => !((set_x in [name])), f.pending), ready := (if (parseResult.ParsedOk? && hasHandler) then (f.ready + ProofLib.Filter((set_x: string) => !((set_x in f.ready)), [name])) else f.ready), errors := (if (parseResult.SoftParseFailure? || parseResult.HardParseFailure?) then (f.errors + ProofLib.Filter((set_x: string) => !((set_x in f.errors)), [name])) else f.errors), aborted := parseResult.CancelledField?))
{
}

lemma FieldHandleFieldView(f: FieldDispatch, name: string, handlerResult: HandlerOutcome)
  ensures handleField(f, name, handlerResult) == (f.(ready := ProofLib.Filter((set_x: string) => !((set_x in [name])), f.ready), attempted := (f.attempted + ProofLib.Filter((set_x: string) => !((set_x in f.attempted)), [name])), handled := (if completedCallback(handlerResult) then (f.handled + ProofLib.Filter((set_x: string) => !((set_x in f.handled)), [name])) else f.handled), errors := (if failedHandler(handlerResult) then (f.errors + ProofLib.Filter((set_x: string) => !((set_x in f.errors)), [name])) else f.errors), preemption := handlerPreemption(name, handlerResult), aborted := cancelledHandler(handlerResult)))
{
}

lemma FieldAlwaysAttemptedOnceView(f: FieldDispatch)
  ensures alwaysAttemptedOnce(f) == ((|ProofLib.Filter((set_x: string) => (set_x in f.attempted), f.ready)| == 0))
{
}

lemma parseField_ensures(f: FieldDispatch, name: string, parseResult: ParseOutcome, hasHandler: bool)
  ensures (inv(f) ==> canParseField(f, name) ==> alwaysOnlySnapshotHandled(parseField(f, name, parseResult, hasHandler)))
  ensures (inv(f) ==> canParseField(f, name) ==> alwaysHandlersAfterParse(parseField(f, name, parseResult, hasHandler)))
  ensures (inv(f) ==> canParseField(f, name) ==> alwaysAttemptedOnce(parseField(f, name, parseResult, hasHandler)))
  ensures (inv(f) ==> canParseField(f, name) ==> alwaysPreemptionNamesHandledField(parseField(f, name, parseResult, hasHandler)))
  ensures (inv(f) ==> canParseField(f, name) ==> alwaysPendingBelongsToSnapshot(parseField(f, name, parseResult, hasHandler)))
  ensures (inv(f) ==> canParseField(f, name) ==> stepPreemptionPersistsUntilNextDispatch(f, "parseField", parseField(f, name, parseResult, hasHandler)))
{
  if inv(f) && canParseField(f, name) {
    FieldParseFieldView(f, name, parseResult, hasHandler);
    var after := parseField(f, name, parseResult, hasHandler);
    FieldAlwaysAttemptedOnceView(after);
    FieldExcludedMembership(f.pending, name);
    FieldUnionMembership(f.ready, name);
    assert name in f.snapshot;
    assert |f.pending| > 0;
    assert |f.attempted| == 0;
    ProofLib.FilterNone((set_x: string) => (set_x in after.attempted), after.ready);
  }
}

lemma handleField_ensures(f: FieldDispatch, name: string, handlerResult: HandlerOutcome)
  ensures (inv(f) ==> canHandleField(f, name) ==> alwaysOnlySnapshotHandled(handleField(f, name, handlerResult)))
  ensures (inv(f) ==> canHandleField(f, name) ==> alwaysHandlersAfterParse(handleField(f, name, handlerResult)))
  ensures (inv(f) ==> canHandleField(f, name) ==> alwaysAttemptedOnce(handleField(f, name, handlerResult)))
  ensures (inv(f) ==> canHandleField(f, name) ==> alwaysPreemptionNamesHandledField(handleField(f, name, handlerResult)))
  ensures (inv(f) ==> canHandleField(f, name) ==> alwaysPendingBelongsToSnapshot(handleField(f, name, handlerResult)))
  ensures (inv(f) ==> canHandleField(f, name) ==> stepPreemptionPersistsUntilNextDispatch(f, "handleField", handleField(f, name, handlerResult)))
{
  if inv(f) && canHandleField(f, name) {
    FieldHandleFieldView(f, name, handlerResult);
    FieldAlwaysAttemptedOnceView(f);
    FieldDisjointMembers(f.ready, f.attempted);
    FieldUnionMembership(f.attempted, name);
    FieldUnionMembership(f.handled, name);
    FieldExcludedMembership(f.ready, name);
    var after := handleField(f, name, handlerResult);
    FieldAlwaysAttemptedOnceView(after);
    forall item | item in after.ready ensures item !in after.attempted {
      assert item in f.ready && item != name;
    }
    ProofLib.FilterNone((set_x: string) => (set_x in after.attempted), after.ready);
  }
}

lemma lawFailedHandlerDoesNotPreempt_ensures(f: FieldDispatch, name: string)
  ensures (lawFailedHandlerDoesNotPreempt(f, name) == true)
{
  FieldHandleFieldView(f, name, HandlerOutcome.HandlerCallbackFailed);
  FieldUnionMembership(f.errors, name);
  FieldUnionMembership(f.handled, name);
}

lemma lawEffectFailureDoesNotPreempt_ensures(f: FieldDispatch, name: string)
  ensures (lawEffectFailureDoesNotPreempt(f, name) == true)
{
  FieldHandleFieldView(f, name, HandlerOutcome.HandlerEffectFailed);
  FieldUnionMembership(f.errors, name);
  FieldUnionMembership(f.handled, name);
}

lemma lawEffectCancellationKeepsHandledTrace_ensures(f: FieldDispatch, name: string)
  ensures (lawEffectCancellationKeepsHandledTrace(f, name) == true)
{
  FieldHandleFieldView(f, name, HandlerOutcome.HandlerEffectCancelled);
  FieldUnionMembership(f.errors, name);
  FieldUnionMembership(f.handled, name);
}
