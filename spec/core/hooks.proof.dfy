lemma PipelineIdsBridge(rows: seq<Hook>)
  ensures uniqueHookIds(rows) <==> (forall h :: h in rows ==> h.id > 0 && |ProofLib.Filter((x: Hook) => x.id == h.id,rows)| == 1)
{}

lemma PipelineIdsDistinct(rows: seq<Hook>)
  requires uniqueHookIds(rows)
  ensures ProofLib.DistinctBy(rows,(x: Hook) => x.id)
{
  PipelineIdsBridge(rows);
  forall i,j | 0 <= i < |rows| && 0 <= j < |rows| && i != j
    ensures rows[i].id != rows[j].id
  {
    var id := rows[i].id;
    assert rows[i] in rows;
    ProofLib.FilterCountOneIffUnique((x: Hook) => x.id == id,rows,(x: Hook) => x.id,i);
  }
}

lemma PipelineFromDistinct(rows: seq<Hook>)
  requires ProofLib.DistinctBy(rows,(x: Hook) => x.id)
  requires forall h :: h in rows ==> h.id > 0
  ensures uniqueHookIds(rows)
{
  PipelineIdsBridge(rows);
  forall h | h in rows ensures h.id > 0 && |ProofLib.Filter((x: Hook) => x.id == h.id,rows)| == 1
  {
    var i :| 0 <= i < |rows| && rows[i] == h;
    ProofLib.FilterOne((x: Hook) => x.id == h.id,rows,i);
  }
}

lemma PipelineFiltered(rows: seq<Hook>, p: Hook -> bool)
  requires uniqueHookIds(rows)
  ensures uniqueHookIds(ProofLib.Filter(p,rows))
{
  PipelineIdsDistinct(rows);
  ProofLib.FilterKeepsDistinctBy(p,rows,(x: Hook) => x.id);
  ProofLib.FilterSubset(p,rows);
  PipelineFromDistinct(ProofLib.Filter(p,rows));
}

lemma PipelineInsertPreserves(rows: seq<Hook>, row: Hook)
  requires uniqueHookIds(rows)
  requires row.id > 0 && (forall h :: h in rows ==> h.id != row.id)
  ensures uniqueHookIds(insertPipelineHook(rows,row))
  ensures forall h :: h in insertPipelineHook(rows,row) ==> h in rows || h == row
{
  var before := (h: Hook) => pipelineComesBefore(h,row);
  var after := (h: Hook) => !pipelineComesBefore(h,row);
  var lhs := ProofLib.Filter(before,rows);
  var rhs := ProofLib.Filter(after,rows);
  PipelineFiltered(rows,before);
  PipelineFiltered(rows,after);
  PipelineIdsDistinct(lhs);
  PipelineIdsDistinct(rhs);
  forall h | h in lhs ensures h in rows && before(h)
  {
    ProofLib.FilterMember(before,rows,h);
  }
  forall h | h in rhs ensures h in rows && after(h)
  {
    ProofLib.FilterMember(after,rows,h);
  }
  forall x,y | x in lhs && y in rhs ensures x.id != y.id
  {
    if x.id == y.id {
      var pos :| 0 <= pos < |rows| && rows[pos] == x;
      var otherPos :| 0 <= otherPos < |rows| && rows[otherPos] == y;
      PipelineIdsDistinct(rows);
      assert pos == otherPos;
    }
  }
  ProofLib.DistinctByConcat(lhs,[row],(h: Hook) => h.id);
  ProofLib.DistinctByConcat(lhs+[row],rhs,(h: Hook) => h.id);
  assert insertPipelineHook(rows,row) == lhs+[row]+rhs;
  PipelineFromDistinct(insertPipelineHook(rows,row));
}

lemma PipelineFoldSortUnique(rows: seq<Hook>, acc: seq<Hook>)
  requires uniqueHookIds(rows) && uniqueHookIds(acc)
  requires forall a,b :: a in rows && b in acc ==> a.id != b.id
  ensures uniqueHookIds(Std.Collections.Seq.FoldLeft((left: seq<Hook>, entry: Hook) => insertPipelineHook(left,entry),acc,rows))
  decreases |rows|
{
  reveal Std.Collections.Seq.FoldLeft();
  if |rows| > 0 {
    var first := rows[0];
    var rest := rows[1..];
    PipelineIdsBridge(rows);
    PipelineIdsDistinct(rows);
    forall i,j | 0 <= i < |rest| && 0 <= j < |rest| && i != j ensures rest[i].id != rest[j].id
    {
      assert rest[i] == rows[i+1] && rest[j] == rows[j+1];
    }
    PipelineFromDistinct(rest);
    var inserted := insertPipelineHook(acc,first);
    PipelineInsertPreserves(acc,first);
    forall a,b | a in rest && b in inserted ensures a.id != b.id
    {
      if b == first {
        var pos :| 0 <= pos < |rest| && rest[pos] == a;
        assert rows[pos+1] == a;
      } else {
        assert b in acc;
      }
    }
    PipelineFoldSortUnique(rest,inserted);
  }
}

lemma PipelineSnapshotFold(first: seq<Hook>, second: seq<Hook>, cursor: PipelineOrderCheck)
  requires cursor.matches && 0 <= cursor.position && cursor.position + |first| <= |second|
  requires forall i :: 0 <= i < |first| ==> first[i] == second[cursor.position+i]
  ensures Std.Collections.Seq.FoldLeft((point: PipelineOrderCheck, entry: Hook) =>
    PipelineOrderCheck(point.position+1,point.matches && samePipelineHook(entry,(if 0 <= point.position < |second| then second[point.position] else missingHook))),cursor,first).matches
  decreases |first|
{
  reveal Std.Collections.Seq.FoldLeft();
  if |first| > 0 {
    var remainder := first[1..];
    var advanced := PipelineOrderCheck(cursor.position+1,true);
    forall i | 0 <= i < |remainder| ensures remainder[i] == second[advanced.position+i]
    {
      assert remainder[i] == first[i+1];
    }
    PipelineSnapshotFold(remainder,second,advanced);
  }
}

lemma PipelineSameSelection(rows: seq<Hook>)
  ensures samePipelineOrder(rows,rows)
{
  PipelineSnapshotFold(rows,rows,initialPipelineOrderCheck);
}

lemma PipelineLookup(phase: string, s: HookState)
  requires phase in pipelinePhases
  ensures memoAt(s,phase) == noPhaseMemo || (memoAt(s,phase) in s.memo && memoAt(s,phase).phase == phase)
  ensures memoAt(s,phase) == noPhaseMemo <==> (forall row :: row in s.memo ==> row.phase != phase)
{
  var p := (row: PhaseMemo) => row.phase == phase;
  var found := ProofLib.Filter(p,s.memo);
  if |found| > 0 {
    ProofLib.FilterMember(p,s.memo,found[0]);
    assert phase != noPhaseMemo.phase;
    assert found[0] != noPhaseMemo;
  } else {
    forall row | row in s.memo ensures row.phase != phase
    {
      if p(row) { ProofLib.FilterMember(p,s.memo,row); }
    }
  }
}

lemma PipelineLookedUp(phase: string, s: HookState)
  requires alwaysMemoGeneration(s)
  requires phase in pipelinePhases
  ensures memoAt(cachedPhase(phase,s),phase) in cachedPhase(phase,s).memo
{
  PipelineLookup(phase,s);
  if memoAt(s,phase).arrayRef <= 0 {
    assert memoAt(s,phase) == noPhaseMemo;
    var t := cachedPhase(phase,s);
    var row := t.memo[|s.memo|];
    var p := (item: PhaseMemo) => item.phase == phase;
    ProofLib.FilterNone(p,s.memo);
    ProofLib.FilterAppend(p,s.memo,row);
    assert ProofLib.Filter(p,t.memo) == [row];
    assert memoAt(t,phase) == row;
    assert row in t.memo;
  }
}

lemma PipelineMemoFill(phase: string, s: HookState)
  requires inv(s)
  requires phase in pipelinePhases
  ensures alwaysMemoSelection(cachedPhase(phase,s)) && alwaysMemoGeneration(cachedPhase(phase,s))
{
  if memoAt(s,phase).arrayRef <= 0 {
    PipelineLookup(phase,s);
    assert memoAt(s,phase) == noPhaseMemo;
    var t := cachedPhase(phase,s);
    var addedMemo := t.memo[|s.memo|];
    var filtered := ProofLib.Filter((h: Hook) => h.phase == phase,s.registry);
    PipelineFiltered(s.registry,(h: Hook) => h.phase == phase);
    PipelineFoldSortUnique(filtered,noPipelineHooks);
    PipelineSameSelection(addedMemo.selected);
    forall row | row in t.memo
      ensures uniqueHookIds(row.selected) && samePipelineOrder(row.selected,phaseSelection(t.registry,row.phase))
      ensures row.epoch == t.epoch && 0 < row.arrayRef < t.nextArray
      ensures |ProofLib.Filter((other: PhaseMemo) => other.phase == row.phase,t.memo)| == 1
      ensures |ProofLib.Filter((other: PhaseMemo) => other.arrayRef == row.arrayRef,t.memo)| == 1
    {
      var phaseKey := (other: PhaseMemo) => other.phase == row.phase;
      var refKey := (other: PhaseMemo) => other.arrayRef == row.arrayRef;
      ProofLib.FilterAppend(phaseKey,s.memo,addedMemo);
      ProofLib.FilterAppend(refKey,s.memo,addedMemo);
      if row == addedMemo {
        ProofLib.FilterNone(phaseKey,s.memo);
        ProofLib.FilterNone(refKey,s.memo);
      } else {
        assert row in s.memo;
      }
    }
  }
}

lemma unregisterHook_ensures(s: HookState, id: int)
  ensures (inv(s) ==> alwaysSnapshotResultsAgree(unregisterHook(s, id)))
  ensures (inv(s) ==> alwaysHookIdentifiersUnique(unregisterHook(s, id)))
  ensures (inv(s) ==> alwaysMemoGeneration(unregisterHook(s, id)))
  ensures (inv(s) ==> alwaysMemoSelection(unregisterHook(s, id)))
  ensures (inv(s) ==> alwaysHookStatuses(unregisterHook(s, id)))
  ensures (inv(s) ==> alwaysCompletedHooksSettled(unregisterHook(s, id)))
  ensures (inv(s) ==> alwaysRejectedIsLocalAdmission(unregisterHook(s, id)))
  ensures (inv(s) ==> stepMemoEpochNondecreasing(s, unregisterHook(s, id)))
  ensures (inv(s) ==> stepSnapshotStableDuringDispatch(s, "unregisterHook", unregisterHook(s, id)))
{
  if inv(s) {
    var t := unregisterHook(s, id);
    PipelineSameSelection(s.snapshot);
    if t.registry != s.registry {
      PipelineFiltered(s.registry,(h: Hook) => h.id != id);
    }
  }
}

lemma registerHook_ensures(s: HookState, id: int, phase: string, position: int, collation: int, handler: int, kind: HookKind)
  ensures (inv(s) ==> canRegisterHook(s, id, phase, position, collation, handler, kind) ==> alwaysSnapshotResultsAgree(registerHook(s, id, phase, position, collation, handler, kind)))
  ensures (inv(s) ==> canRegisterHook(s, id, phase, position, collation, handler, kind) ==> alwaysHookIdentifiersUnique(registerHook(s, id, phase, position, collation, handler, kind)))
  ensures (inv(s) ==> canRegisterHook(s, id, phase, position, collation, handler, kind) ==> alwaysMemoGeneration(registerHook(s, id, phase, position, collation, handler, kind)))
  ensures (inv(s) ==> canRegisterHook(s, id, phase, position, collation, handler, kind) ==> alwaysMemoSelection(registerHook(s, id, phase, position, collation, handler, kind)))
  ensures (inv(s) ==> canRegisterHook(s, id, phase, position, collation, handler, kind) ==> alwaysHookStatuses(registerHook(s, id, phase, position, collation, handler, kind)))
  ensures (inv(s) ==> canRegisterHook(s, id, phase, position, collation, handler, kind) ==> alwaysCompletedHooksSettled(registerHook(s, id, phase, position, collation, handler, kind)))
  ensures (inv(s) ==> canRegisterHook(s, id, phase, position, collation, handler, kind) ==> alwaysRejectedIsLocalAdmission(registerHook(s, id, phase, position, collation, handler, kind)))
  ensures (inv(s) ==> canRegisterHook(s, id, phase, position, collation, handler, kind) ==> stepMemoEpochNondecreasing(s, registerHook(s, id, phase, position, collation, handler, kind)))
  ensures (inv(s) ==> canRegisterHook(s, id, phase, position, collation, handler, kind) ==> stepSnapshotStableDuringDispatch(s, "registerHook", registerHook(s, id, phase, position, collation, handler, kind)))
{
  if inv(s) && canRegisterHook(s, id, phase, position, collation, handler, kind) {
    var t := registerHook(s, id, phase, position, collation, handler, kind);
    PipelineSameSelection(s.snapshot);
    PipelineIdsBridge(s.registry);
    PipelineIdsDistinct(s.registry);
    var matches := ProofLib.Filter((h: Hook) => h.id == id,s.registry);
    if |matches| == 0 {
      ProofLib.FilterNone((h: Hook) => h.id == id,s.registry);
      forall h | h in s.registry ensures h.id != id
      {
        if h.id == id { ProofLib.FilterMember((h: Hook) => h.id == id,s.registry,h); }
      }
      var row := t.registry[|s.registry|];
      assert t.registry == s.registry + [row];
      ProofLib.DistinctByConcat(s.registry,[row],(h: Hook) => h.id);
    } else {
      forall i,j | 0 <= i < |t.registry| && 0 <= j < |t.registry| && i != j ensures t.registry[i].id != t.registry[j].id
      {
        assert t.registry[i].id == s.registry[i].id;
        assert t.registry[j].id == s.registry[j].id;
      }
    }
    forall h | h in t.registry ensures h.id > 0
    {
      var i :| 0 <= i < |t.registry| && t.registry[i] == h;
      if i < |s.registry| { assert s.registry[i] in s.registry; }
    }
    PipelineFromDistinct(t.registry);
  }
}

lemma lookupPhase_ensures(s: HookState, phase: string)
  ensures (inv(s) ==> canLookupPhase(s, phase) ==> alwaysSnapshotResultsAgree(lookupPhase(s, phase)))
  ensures (inv(s) ==> canLookupPhase(s, phase) ==> alwaysHookIdentifiersUnique(lookupPhase(s, phase)))
  ensures (inv(s) ==> canLookupPhase(s, phase) ==> alwaysMemoGeneration(lookupPhase(s, phase)))
  ensures (inv(s) ==> canLookupPhase(s, phase) ==> alwaysMemoSelection(lookupPhase(s, phase)))
  ensures (inv(s) ==> canLookupPhase(s, phase) ==> alwaysHookStatuses(lookupPhase(s, phase)))
  ensures (inv(s) ==> canLookupPhase(s, phase) ==> alwaysCompletedHooksSettled(lookupPhase(s, phase)))
  ensures (inv(s) ==> canLookupPhase(s, phase) ==> alwaysRejectedIsLocalAdmission(lookupPhase(s, phase)))
  ensures (inv(s) ==> canLookupPhase(s, phase) ==> stepMemoEpochNondecreasing(s, lookupPhase(s, phase)))
  ensures (inv(s) ==> canLookupPhase(s, phase) ==> stepSnapshotStableDuringDispatch(s, "lookupPhase", lookupPhase(s, phase)))
{
  if inv(s) && canLookupPhase(s, phase) {
    var t := lookupPhase(s, phase);
    PipelineSameSelection(s.snapshot);
    PipelineMemoFill(phase,s);
  }
}

lemma beginHooks_ensures(s: HookState, phase: string, localAdmission: bool)
  ensures (inv(s) ==> canBeginHooks(s, phase, localAdmission) ==> alwaysSnapshotResultsAgree(beginHooks(s, phase, localAdmission)))
  ensures (inv(s) ==> canBeginHooks(s, phase, localAdmission) ==> alwaysHookIdentifiersUnique(beginHooks(s, phase, localAdmission)))
  ensures (inv(s) ==> canBeginHooks(s, phase, localAdmission) ==> alwaysMemoGeneration(beginHooks(s, phase, localAdmission)))
  ensures (inv(s) ==> canBeginHooks(s, phase, localAdmission) ==> alwaysMemoSelection(beginHooks(s, phase, localAdmission)))
  ensures (inv(s) ==> canBeginHooks(s, phase, localAdmission) ==> alwaysHookStatuses(beginHooks(s, phase, localAdmission)))
  ensures (inv(s) ==> canBeginHooks(s, phase, localAdmission) ==> alwaysCompletedHooksSettled(beginHooks(s, phase, localAdmission)))
  ensures (inv(s) ==> canBeginHooks(s, phase, localAdmission) ==> alwaysRejectedIsLocalAdmission(beginHooks(s, phase, localAdmission)))
  ensures (inv(s) ==> canBeginHooks(s, phase, localAdmission) ==> stepMemoEpochNondecreasing(s, beginHooks(s, phase, localAdmission)))
  ensures (inv(s) ==> canBeginHooks(s, phase, localAdmission) ==> stepSnapshotStableDuringDispatch(s, "beginHooks", beginHooks(s, phase, localAdmission)))
{
  if inv(s) && canBeginHooks(s, phase, localAdmission) {
    var t := beginHooks(s, phase, localAdmission);
    PipelineMemoFill(phase,s);
    var filled := cachedPhase(phase,s);
    PipelineLookedUp(phase,s);
    var cached := memoAt(filled,phase);
    assert alwaysMemoSelection(filled);
    assert cached in filled.memo && uniqueHookIds(cached.selected);
    forall h | h in t.snapshot ensures exists r :: r in t.results && r.id == h.id
    {
      var i :| 0 <= i < |t.snapshot| && t.snapshot[i] == h;
      assert t.results[i].id == h.id && t.results[i] in t.results;
    }
  }
}

lemma startHook_ensures(s: HookState, id: int)
  ensures (inv(s) ==> canStartHook(s, id) ==> alwaysSnapshotResultsAgree(startHook(s, id)))
  ensures (inv(s) ==> canStartHook(s, id) ==> alwaysHookIdentifiersUnique(startHook(s, id)))
  ensures (inv(s) ==> canStartHook(s, id) ==> alwaysMemoGeneration(startHook(s, id)))
  ensures (inv(s) ==> canStartHook(s, id) ==> alwaysMemoSelection(startHook(s, id)))
  ensures (inv(s) ==> canStartHook(s, id) ==> alwaysHookStatuses(startHook(s, id)))
  ensures (inv(s) ==> canStartHook(s, id) ==> alwaysCompletedHooksSettled(startHook(s, id)))
  ensures (inv(s) ==> canStartHook(s, id) ==> alwaysRejectedIsLocalAdmission(startHook(s, id)))
  ensures (inv(s) ==> canStartHook(s, id) ==> stepMemoEpochNondecreasing(s, startHook(s, id)))
  ensures (inv(s) ==> canStartHook(s, id) ==> stepSnapshotStableDuringDispatch(s, "startHook", startHook(s, id)))
{
  if inv(s) && canStartHook(s, id) {
    var t := startHook(s, id);
    PipelineSameSelection(s.snapshot);
    forall h | h in t.snapshot ensures exists r :: r in t.results && r.id == h.id
    {
      var i :| 0 <= i < |s.results| && s.results[i].id == h.id;
      assert t.results[i] in t.results && t.results[i].id == h.id;
    }
  }
}

lemma finishHook_ensures(s: HookState, id: int, ok: bool, admissionRefused: bool)
  ensures (inv(s) ==> canFinishHook(s, id, ok, admissionRefused) ==> alwaysSnapshotResultsAgree(finishHook(s, id, ok, admissionRefused)))
  ensures (inv(s) ==> canFinishHook(s, id, ok, admissionRefused) ==> alwaysHookIdentifiersUnique(finishHook(s, id, ok, admissionRefused)))
  ensures (inv(s) ==> canFinishHook(s, id, ok, admissionRefused) ==> alwaysMemoGeneration(finishHook(s, id, ok, admissionRefused)))
  ensures (inv(s) ==> canFinishHook(s, id, ok, admissionRefused) ==> alwaysMemoSelection(finishHook(s, id, ok, admissionRefused)))
  ensures (inv(s) ==> canFinishHook(s, id, ok, admissionRefused) ==> alwaysHookStatuses(finishHook(s, id, ok, admissionRefused)))
  ensures (inv(s) ==> canFinishHook(s, id, ok, admissionRefused) ==> alwaysCompletedHooksSettled(finishHook(s, id, ok, admissionRefused)))
  ensures (inv(s) ==> canFinishHook(s, id, ok, admissionRefused) ==> alwaysRejectedIsLocalAdmission(finishHook(s, id, ok, admissionRefused)))
  ensures (inv(s) ==> canFinishHook(s, id, ok, admissionRefused) ==> stepMemoEpochNondecreasing(s, finishHook(s, id, ok, admissionRefused)))
  ensures (inv(s) ==> canFinishHook(s, id, ok, admissionRefused) ==> stepSnapshotStableDuringDispatch(s, "finishHook", finishHook(s, id, ok, admissionRefused)))
{
  if inv(s) && canFinishHook(s, id, ok, admissionRefused) {
    var t := finishHook(s, id, ok, admissionRefused);
    PipelineSameSelection(s.snapshot);
    forall h | h in t.snapshot ensures exists r :: r in t.results && r.id == h.id
    {
      var i :| 0 <= i < |s.results| && s.results[i].id == h.id;
      assert t.results[i] in t.results && t.results[i].id == h.id;
    }
  }
}

lemma finishHooks_ensures(s: HookState)
  ensures (inv(s) ==> canFinishHooks(s) ==> alwaysSnapshotResultsAgree(finishHooks(s)))
  ensures (inv(s) ==> canFinishHooks(s) ==> alwaysHookIdentifiersUnique(finishHooks(s)))
  ensures (inv(s) ==> canFinishHooks(s) ==> alwaysMemoGeneration(finishHooks(s)))
  ensures (inv(s) ==> canFinishHooks(s) ==> alwaysMemoSelection(finishHooks(s)))
  ensures (inv(s) ==> canFinishHooks(s) ==> alwaysHookStatuses(finishHooks(s)))
  ensures (inv(s) ==> canFinishHooks(s) ==> alwaysCompletedHooksSettled(finishHooks(s)))
  ensures (inv(s) ==> canFinishHooks(s) ==> alwaysRejectedIsLocalAdmission(finishHooks(s)))
  ensures (inv(s) ==> canFinishHooks(s) ==> stepMemoEpochNondecreasing(s, finishHooks(s)))
  ensures (inv(s) ==> canFinishHooks(s) ==> stepSnapshotStableDuringDispatch(s, "finishHooks", finishHooks(s)))
{
  if inv(s) && canFinishHooks(s) {
    var t := finishHooks(s);
    PipelineSameSelection(s.snapshot);
  }
}

lemma lawSelectionReflexive_ensures(hooks: seq<Hook>)
  ensures (lawSelectionReflexive(hooks) == true)
{
  PipelineSameSelection(hooks);
}
