lemma FieldsAttemptedOnce(f: FieldDispatch)
  ensures alwaysAttemptedOnce(f) == (|ProofLib.Filter((set_x: string) => (set_x in f.attempted), f.ready)| == 0)
{}

lemma FieldsNoneAttempted(f: FieldDispatch)
  ensures alwaysAttemptedOnce(f) == (forall i :: 0 <= i < |f.ready| ==> f.ready[i] !in f.attempted)
{
  FieldsAttemptedOnce(f);
  ProofLib.FilterNone((set_x: string) => (set_x in f.attempted), f.ready);
}

lemma FieldsParse(f: FieldDispatch, name: string, parseResult: ParseOutcome, hasHandler: bool)
  ensures parseField(f, name, parseResult, hasHandler).pending == ProofLib.Filter((set_x: string) => !((set_x in [name])), f.pending)
  ensures parseField(f, name, parseResult, hasHandler).ready == (if (parseResult.ParsedOk? && hasHandler) then (f.ready + ProofLib.Filter((set_x: string) => !((set_x in f.ready)), [name])) else f.ready)
{}

lemma FieldsHandle(f: FieldDispatch, name: string, failed: bool, preempt: bool, cancelled: bool)
  ensures handleField(f, name, failed, preempt, cancelled).ready == ProofLib.Filter((set_x: string) => !((set_x in [name])), f.ready)
  ensures handleField(f, name, failed, preempt, cancelled).attempted == f.attempted + ProofLib.Filter((set_x: string) => !((set_x in f.attempted)), [name])
  ensures handleField(f, name, failed, preempt, cancelled).handled == (if (failed || cancelled) then f.handled else (f.handled + ProofLib.Filter((set_x: string) => !((set_x in f.handled)), [name])))
{}

lemma parseField_ensures(f: FieldDispatch, name: string, parseResult: ParseOutcome, hasHandler: bool)
  ensures (inv(f) ==> canParseField(f, name) ==> alwaysFenceWidthMatchesKind(parseField(f, name, parseResult, hasHandler)))
  ensures (inv(f) ==> canParseField(f, name) ==> alwaysCursorBounded(parseField(f, name, parseResult, hasHandler)))
  ensures (inv(f) ==> canParseField(f, name) ==> alwaysOnlySnapshotHandled(parseField(f, name, parseResult, hasHandler)))
  ensures (inv(f) ==> canParseField(f, name) ==> alwaysPendingFromSnapshot(parseField(f, name, parseResult, hasHandler)))
  ensures (inv(f) ==> canParseField(f, name) ==> alwaysHandlersAfterParse(parseField(f, name, parseResult, hasHandler)))
  ensures (inv(f) ==> canParseField(f, name) ==> alwaysAttemptedOnce(parseField(f, name, parseResult, hasHandler)))
  ensures (inv(f) ==> canParseField(f, name) ==> alwaysPreemptionNamesHandledField(parseField(f, name, parseResult, hasHandler)))
  ensures (inv(f) ==> canParseField(f, name) ==> stepQuotedFieldNeverBecomesOuter(f, "parseField", parseField(f, name, parseResult, hasHandler)))
  ensures (inv(f) ==> canParseField(f, name) ==> stepPreemptionPersistsUntilNextDispatch(f, "parseField", parseField(f, name, parseResult, hasHandler)))
{
  if inv(f) && canParseField(f, name) {
    var after := parseField(f, name, parseResult, hasHandler);
    FieldsParse(f, name, parseResult, hasHandler);
    assert |f.pending| > 0;
    assert |f.attempted| == 0;
    forall x | x in after.pending ensures x in f.snapshot {
      ProofLib.FilterMember((set_x: string) => !((set_x in [name])), f.pending, x);
    }
    forall x | x in after.ready ensures x in f.snapshot {
      if x !in f.ready { ProofLib.FilterMember((set_x: string) => !((set_x in f.ready)), [name], x); }
    }
    FieldsNoneAttempted(after);
  }
}

lemma handleField_ensures(f: FieldDispatch, name: string, failed: bool, preempt: bool, cancelled: bool)
  ensures (inv(f) ==> canHandleField(f, name) ==> alwaysFenceWidthMatchesKind(handleField(f, name, failed, preempt, cancelled)))
  ensures (inv(f) ==> canHandleField(f, name) ==> alwaysCursorBounded(handleField(f, name, failed, preempt, cancelled)))
  ensures (inv(f) ==> canHandleField(f, name) ==> alwaysOnlySnapshotHandled(handleField(f, name, failed, preempt, cancelled)))
  ensures (inv(f) ==> canHandleField(f, name) ==> alwaysPendingFromSnapshot(handleField(f, name, failed, preempt, cancelled)))
  ensures (inv(f) ==> canHandleField(f, name) ==> alwaysHandlersAfterParse(handleField(f, name, failed, preempt, cancelled)))
  ensures (inv(f) ==> canHandleField(f, name) ==> alwaysAttemptedOnce(handleField(f, name, failed, preempt, cancelled)))
  ensures (inv(f) ==> canHandleField(f, name) ==> alwaysPreemptionNamesHandledField(handleField(f, name, failed, preempt, cancelled)))
  ensures (inv(f) ==> canHandleField(f, name) ==> stepQuotedFieldNeverBecomesOuter(f, "handleField", handleField(f, name, failed, preempt, cancelled)))
  ensures (inv(f) ==> canHandleField(f, name) ==> stepPreemptionPersistsUntilNextDispatch(f, "handleField", handleField(f, name, failed, preempt, cancelled)))
{
  if inv(f) && canHandleField(f, name) {
    var after := handleField(f, name, failed, preempt, cancelled);
    FieldsHandle(f, name, failed, preempt, cancelled);
    FieldsNoneAttempted(f);
    forall x | x in after.ready ensures x in f.ready && x != name {
      ProofLib.FilterMember((set_x: string) => !((set_x in [name])), f.ready, x);
    }
    forall x | x in after.attempted ensures x in f.attempted || x == name {
      if x !in f.attempted { ProofLib.FilterMember((set_x: string) => !((set_x in f.attempted)), [name], x); }
    }
    forall x | x in after.handled ensures x in f.handled || x == name {
      if !(failed || cancelled) && x !in f.handled { ProofLib.FilterMember((set_x: string) => !((set_x in f.handled)), [name], x); }
    }
    assert name in after.attempted by { ProofLib.FilterMember((set_x: string) => !((set_x in f.attempted)), [name], name); }
    forall i | 0 <= i < |after.ready| ensures after.ready[i] !in after.attempted {
      assert after.ready[i] in after.ready;
      var j :| 0 <= j < |f.ready| && f.ready[j] == after.ready[i];
    }
    FieldsNoneAttempted(after);
  }
}

lemma FieldsHandleOutcome(f: FieldDispatch, name: string, handlerResult: HandlerOutcome)
  ensures handleFieldOutcome(f, name, handlerResult).ready == ProofLib.Filter((set_x: string) => !((set_x in [name])), f.ready)
  ensures handleFieldOutcome(f, name, handlerResult).attempted == f.attempted + ProofLib.Filter((set_x: string) => !((set_x in f.attempted)), [name])
  ensures handleFieldOutcome(f, name, handlerResult).handled == (if completedCallback(handlerResult) then (f.handled + ProofLib.Filter((set_x: string) => !((set_x in f.handled)), [name])) else f.handled)
  ensures handleFieldOutcome(f, name, handlerResult).errors == (if failedHandler(handlerResult) then (f.errors + ProofLib.Filter((set_x: string) => !((set_x in f.errors)), [name])) else f.errors)
{}

// Adding a name to a set kept as a sequence keeps every old member and contains the name.
lemma FieldsAddedName(xs: seq<string>, name: string)
  ensures name in xs + ProofLib.Filter((set_x: string) => !((set_x in xs)), [name])
  ensures forall x :: x in xs + ProofLib.Filter((set_x: string) => !((set_x in xs)), [name]) ==> x in xs || x == name
{
  if name !in xs { ProofLib.FilterMember((set_x: string) => !((set_x in xs)), [name], name); }
  forall x | x in xs + ProofLib.Filter((set_x: string) => !((set_x in xs)), [name]) ensures x in xs || x == name {
    if x !in xs { ProofLib.FilterMember((set_x: string) => !((set_x in xs)), [name], x); }
  }
}

lemma handleFieldOutcome_ensures(f: FieldDispatch, name: string, handlerResult: HandlerOutcome)
  ensures (inv(f) ==> canHandleFieldOutcome(f, name) ==> alwaysFenceWidthMatchesKind(handleFieldOutcome(f, name, handlerResult)))
  ensures (inv(f) ==> canHandleFieldOutcome(f, name) ==> alwaysCursorBounded(handleFieldOutcome(f, name, handlerResult)))
  ensures (inv(f) ==> canHandleFieldOutcome(f, name) ==> alwaysOnlySnapshotHandled(handleFieldOutcome(f, name, handlerResult)))
  ensures (inv(f) ==> canHandleFieldOutcome(f, name) ==> alwaysPendingFromSnapshot(handleFieldOutcome(f, name, handlerResult)))
  ensures (inv(f) ==> canHandleFieldOutcome(f, name) ==> alwaysHandlersAfterParse(handleFieldOutcome(f, name, handlerResult)))
  ensures (inv(f) ==> canHandleFieldOutcome(f, name) ==> alwaysAttemptedOnce(handleFieldOutcome(f, name, handlerResult)))
  ensures (inv(f) ==> canHandleFieldOutcome(f, name) ==> alwaysPreemptionNamesHandledField(handleFieldOutcome(f, name, handlerResult)))
  ensures (inv(f) ==> canHandleFieldOutcome(f, name) ==> stepQuotedFieldNeverBecomesOuter(f, "handleFieldOutcome", handleFieldOutcome(f, name, handlerResult)))
  ensures (inv(f) ==> canHandleFieldOutcome(f, name) ==> stepPreemptionPersistsUntilNextDispatch(f, "handleFieldOutcome", handleFieldOutcome(f, name, handlerResult)))
{
  if inv(f) && canHandleFieldOutcome(f, name) {
    var after := handleFieldOutcome(f, name, handlerResult);
    FieldsHandleOutcome(f, name, handlerResult);
    FieldsNoneAttempted(f);
    FieldsAddedName(f.attempted, name);
    FieldsAddedName(f.handled, name);
    FieldsAddedName(f.errors, name);
    forall x | x in after.ready ensures x in f.ready && x != name {
      ProofLib.FilterMember((set_x: string) => !((set_x in [name])), f.ready, x);
    }
    forall i | 0 <= i < |after.ready| ensures after.ready[i] !in after.attempted {
      assert after.ready[i] in after.ready;
      var j :| 0 <= j < |f.ready| && f.ready[j] == after.ready[i];
    }
    FieldsNoneAttempted(after);
    // A preemption is only installed by a returned effect, whose callback completed, so the field is handled.
    if after.preemption.PreemptedField? {
      assert handlerResult.HandlerReturned?;
      assert after.preemption.part == name;
    }
  }
}

lemma lawFailedHandlerDoesNotPreempt_ensures(f: FieldDispatch, name: string)
  ensures (lawFailedHandlerDoesNotPreempt(f, name) == true)
{
  FieldsHandleOutcome(f, name, HandlerCallbackFailed);
  FieldsAddedName(f.errors, name);
}

lemma lawEffectFailureDoesNotPreempt_ensures(f: FieldDispatch, name: string)
  ensures (lawEffectFailureDoesNotPreempt(f, name) == true)
{
  FieldsHandleOutcome(f, name, HandlerEffectFailed);
  FieldsAddedName(f.errors, name);
  FieldsAddedName(f.handled, name);
}

lemma lawEffectCancellationKeepsHandledTrace_ensures(f: FieldDispatch, name: string)
  ensures (lawEffectCancellationKeepsHandledTrace(f, name) == true)
{
  FieldsHandleOutcome(f, name, HandlerEffectCancelled);
  FieldsAddedName(f.handled, name);
}

lemma lawRequestedPreemptionRetained_ensures(f: FieldDispatch, name: string, mode: PreemptMode, reason: string)
  ensures (lawRequestedPreemptionRetained(f, name, mode, reason) == true)
{
  FieldsHandleOutcome(f, name, HandlerReturned(RequestPreempt(mode, reason)));
  FieldsAddedName(f.handled, name);
}

lemma lawThrowingPreemptReadIsEffectFailure_ensures(f: FieldDispatch, name: string, mode: PreemptMode, reason: string, thrown: PreemptGetterThrow)
  ensures (lawThrowingPreemptReadIsEffectFailure(f, name, mode, reason, thrown) == true)
{
  if !thrown.NoGetterThrows? {
    assert preemptReadOutcome(applyPreemptReads(RequestPreempt(mode, reason), thrown)) == HandlerEffectFailed;
    lawEffectFailureDoesNotPreempt_ensures(f, name);
  }
}
