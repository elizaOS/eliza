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
  ensures (inv(f) ==> canParseField(f, name) ==> stepQuotedFieldNeverBecomesOuter(f, "parseField", parseField(f, name, parseResult, hasHandler)))
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
  ensures (inv(f) ==> canHandleField(f, name) ==> stepQuotedFieldNeverBecomesOuter(f, "handleField", handleField(f, name, failed, preempt, cancelled)))
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
