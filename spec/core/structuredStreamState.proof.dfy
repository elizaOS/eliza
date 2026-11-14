// Unique field ownership, callback deduplication and selected output preservation.

lemma configure_ensures(s: StructuredState, schema: seq<string>, selected: seq<string>, level: int, revision: int)
  ensures (inv(s) ==> canConfigure(s, level, revision) ==> alwaysFieldKeysUnique(configure(s, schema, selected, level, revision)))
  ensures (inv(s) ==> canConfigure(s, level, revision) ==> alwaysDoneValuesUnique(configure(s, schema, selected, level, revision)))
  ensures (inv(s) ==> canConfigure(s, level, revision) ==> alwaysEmissionNamesSelected(configure(s, schema, selected, level, revision)))
  ensures (inv(s) ==> canConfigure(s, level, revision) ==> alwaysActiveFieldSelected(configure(s, schema, selected, level, revision)))
  ensures (inv(s) ==> canConfigure(s, level, revision) ==> alwaysUnconfiguredEmpty(configure(s, schema, selected, level, revision)))
{
  if inv(s) && canConfigure(s, level, revision) {
    var after := configure(s, schema, selected, level, revision);
    StructuredConfigureFold(schema, []);
    StructuredFieldsDistinct(after.fieldRows);
    StructuredFieldInvariant(after);
  }
}

lemma reset_ensures(s: StructuredState, revision: int)
  ensures (inv(s) ==> canReset(s, revision) ==> alwaysFieldKeysUnique(reset(s, revision)))
  ensures (inv(s) ==> canReset(s, revision) ==> alwaysDoneValuesUnique(reset(s, revision)))
  ensures (inv(s) ==> canReset(s, revision) ==> alwaysEmissionNamesSelected(reset(s, revision)))
  ensures (inv(s) ==> canReset(s, revision) ==> alwaysActiveFieldSelected(reset(s, revision)))
  ensures (inv(s) ==> canReset(s, revision) ==> alwaysUnconfiguredEmpty(reset(s, revision)))
{
  if inv(s) && canReset(s, revision) {
    var after := reset(s, revision);
    StructuredFieldInvariant(s);
    StructuredFieldsDistinct(s.fieldRows);
    forall i, j | 0 <= i < |after.fieldRows| && 0 <= j < |after.fieldRows| && i != j ensures after.fieldRows[i].name != after.fieldRows[j].name {}
    StructuredFieldsDistinct(after.fieldRows);
    StructuredFieldInvariant(after);
  }
}

lemma applyContinuation_ensures(s: StructuredState)
  ensures (inv(s) ==> canApplyContinuation(s) ==> alwaysFieldKeysUnique(applyContinuation(s)))
  ensures (inv(s) ==> canApplyContinuation(s) ==> alwaysDoneValuesUnique(applyContinuation(s)))
  ensures (inv(s) ==> canApplyContinuation(s) ==> alwaysEmissionNamesSelected(applyContinuation(s)))
  ensures (inv(s) ==> canApplyContinuation(s) ==> alwaysActiveFieldSelected(applyContinuation(s)))
  ensures (inv(s) ==> canApplyContinuation(s) ==> alwaysUnconfiguredEmpty(applyContinuation(s)))
{
  if inv(s) && canApplyContinuation(s) {
    var after := applyContinuation(s);
    StructuredFieldInvariant(s);
    StructuredFieldsDistinct(s.fieldRows);
    if s.currentTracked != "" { StructuredAppendUnique(s.fieldRows, s.currentTracked, normalizeContinuation(s.line)); }
    StructuredFieldsDistinct(after.fieldRows);
    StructuredFieldInvariant(after);
  }
}

lemma finishFlush_ensures(s: StructuredState)
  ensures (inv(s) ==> canFinishFlush(s) ==> alwaysFieldKeysUnique(finishFlush(s)))
  ensures (inv(s) ==> canFinishFlush(s) ==> alwaysDoneValuesUnique(finishFlush(s)))
  ensures (inv(s) ==> canFinishFlush(s) ==> alwaysEmissionNamesSelected(finishFlush(s)))
  ensures (inv(s) ==> canFinishFlush(s) ==> alwaysActiveFieldSelected(finishFlush(s)))
  ensures (inv(s) ==> canFinishFlush(s) ==> alwaysUnconfiguredEmpty(finishFlush(s)))
{
  if inv(s) && canFinishFlush(s) {
    var after := finishFlush(s);
    StructuredFieldInvariant(s);
    StructuredFieldsDistinct(s.fieldRows);
    StructuredCompleteUnique(s.fieldRows, s.currentField, s.level);
    var closed := completedFields(s.fieldRows, s.currentField, s.level);
    StructuredEmissionNames(s.fieldRows, s.currentField, s.revision);
    var earlier := s.chunks + (if s.level <= 1 then emitChunks(s.fieldRows, s.currentField, s.revision) else []);
    if s.level >= 2 { StructuredFlushFold(s.selected, s.selected, Emission(closed, earlier), s.revision); }
    StructuredFieldsDistinct(after.fieldRows);
    StructuredFieldInvariant(after);
    StructuredDoneFacts(s);
    if s.currentTracked != "" {
      StructuredAddName(s.done, s.currentTracked);
      if s.currentTracked !in s.done { StructuredAppendDone(s.doneValues, s.done, s.currentTracked, fieldAt(closed, s.currentTracked).content); }
    }
    StructuredDoneFacts(after);
  }
}

lemma applyHeader_ensures(s: StructuredState, name: string, decodedValue: seq<int>, inline: bool)
  ensures (inv(s) ==> canApplyHeader(s, name) ==> alwaysFieldKeysUnique(applyHeader(s, name, decodedValue, inline)))
  ensures (inv(s) ==> canApplyHeader(s, name) ==> alwaysDoneValuesUnique(applyHeader(s, name, decodedValue, inline)))
  ensures (inv(s) ==> canApplyHeader(s, name) ==> alwaysEmissionNamesSelected(applyHeader(s, name, decodedValue, inline)))
  ensures (inv(s) ==> canApplyHeader(s, name) ==> alwaysActiveFieldSelected(applyHeader(s, name, decodedValue, inline)))
  ensures (inv(s) ==> canApplyHeader(s, name) ==> alwaysUnconfiguredEmpty(applyHeader(s, name, decodedValue, inline)))
{
  if inv(s) && canApplyHeader(s, name) {
    var after := applyHeader(s, name, decodedValue, inline);
    StructuredFieldInvariant(s);
    StructuredFieldsDistinct(s.fieldRows);
    StructuredCompleteUnique(s.fieldRows, s.currentField, s.level);
    var closed := completedFields(s.fieldRows, s.currentField, s.level);
    StructuredLookupName(closed, name);
    StructuredPutUnique(closed, fieldAt(closed, name).(status := FieldStatus.PartialField));
    var openedRows := putField(closed, fieldAt(closed, name).(status := FieldStatus.PartialField));
    if inline { StructuredAppendUnique(openedRows, name, decodedValue); }
    var appended := if inline then appendedFields(openedRows, name, decodedValue) else openedRows;
    if inline && name in s.selected { StructuredCompleteUnique(appended, name, s.level); }
    else if inline {
      StructuredLookupName(appended, name);
      StructuredPutUnique(appended, fieldAt(appended, name).(status := FieldStatus.CompleteField));
    }
    StructuredFieldsDistinct(after.fieldRows);
    StructuredFieldInvariant(after);
    StructuredEmissionNames(s.fieldRows, s.currentField, s.revision);
    StructuredEmissionNames(appended, name, s.revision);
    StructuredDoneFacts(s);
    var priorDone := if s.currentTracked != "" && s.currentTracked !in s.done then s.doneValues + [FieldDone(s.currentTracked, fieldAt(closed, s.currentTracked).content)] else s.doneValues;
    var doneNames := if s.currentTracked != "" then s.done + ProofLib.Filter((set_x: string) => !((set_x in s.done)), [s.currentTracked]) else s.done;
    if s.currentTracked != "" {
      StructuredAddName(s.done, s.currentTracked);
      if s.currentTracked !in s.done { StructuredAppendDone(s.doneValues, s.done, s.currentTracked, fieldAt(closed, s.currentTracked).content); }
    }
    if inline {
      StructuredAddName(doneNames, name);
      if name !in doneNames { StructuredAppendDone(priorDone, doneNames, name, fieldAt(after.fieldRows, name).content); }
    }
    StructuredDoneFacts(after);
  }
}

lemma StructuredFieldInvariant(s: StructuredState)
  ensures alwaysFieldKeysUnique(s) == (forall entry :: entry in s.fieldRows ==> |ProofLib.Filter((other: FieldRecord) => (other.name == entry.name), s.fieldRows)| == 1)
{}

lemma StructuredFieldsDistinct(rows: seq<FieldRecord>)
  ensures (forall entry :: entry in rows ==> |ProofLib.Filter((other: FieldRecord) => (other.name == entry.name), rows)| == 1) <==> ProofLib.DistinctBy(rows, (entry: FieldRecord) => entry.name)
{
  if forall entry :: entry in rows ==> |ProofLib.Filter((other: FieldRecord) => (other.name == entry.name), rows)| == 1 {
    forall i, j | 0 <= i < |rows| && 0 <= j < |rows| && i != j ensures rows[i].name != rows[j].name {
      ProofLib.FilterCountOneIffUnique((other: FieldRecord) => (other.name == rows[i].name), rows, (entry: FieldRecord) => entry.name, i);
    }
  } else if ProofLib.DistinctBy(rows, (entry: FieldRecord) => entry.name) {
    forall entry | entry in rows ensures |ProofLib.Filter((other: FieldRecord) => (other.name == entry.name), rows)| == 1 {
      var i :| 0 <= i < |rows| && rows[i] == entry;
      ProofLib.FilterOne((other: FieldRecord) => (other.name == entry.name), rows, i);
    }
  }
}

lemma StructuredLookupName(rows: seq<FieldRecord>, name: string)
  ensures fieldAt(rows, name).name == name
{
  StructuredLookupShape(rows, name);
  var selected := ProofLib.Filter((entry: FieldRecord) => (entry.name == name), rows);
  if |selected| > 0 {
    ProofLib.FilterMember((entry: FieldRecord) => (entry.name == name), rows, selected[0]);
  }
}

lemma StructuredLookupShape(rows: seq<FieldRecord>, name: string)
  ensures fieldAt(rows, name) == (if |ProofLib.Filter((entry: FieldRecord) => (entry.name == name), rows)| > 0 then ProofLib.Filter((entry: FieldRecord) => (entry.name == name), rows)[0] else noField.(name := name))
{}

lemma StructuredPutUnique(rows: seq<FieldRecord>, value: FieldRecord)
  requires ProofLib.DistinctBy(rows, (entry: FieldRecord) => entry.name)
  ensures ProofLib.DistinctBy(putField(rows, value), (entry: FieldRecord) => entry.name)
{
  if exists entry :: entry in rows && entry.name == value.name {
    var after := putField(rows, value);
    forall i, j | 0 <= i < |after| && 0 <= j < |after| && i != j ensures after[i].name != after[j].name {}
  } else {
    ProofLib.DistinctByConcat(rows, [value], (entry: FieldRecord) => entry.name);
  }
}

lemma StructuredConfigureFold(names: seq<string>, rows: seq<FieldRecord>)
  requires ProofLib.DistinctBy(rows, (entry: FieldRecord) => entry.name)
  ensures ProofLib.DistinctBy(Std.Collections.Seq.FoldLeft((fieldRows: seq<FieldRecord>, name: string) => putField(fieldRows, noField.(name := name)), rows, names), (entry: FieldRecord) => entry.name)
  decreases |names|
{
  if |names| > 0 {
    StructuredPutUnique(rows, noField.(name := names[0]));
    StructuredConfigureFold(names[1..], putField(rows, noField.(name := names[0])));
  }
}

lemma StructuredCompleteUnique(rows: seq<FieldRecord>, name: string, level: int)
  requires ProofLib.DistinctBy(rows, (entry: FieldRecord) => entry.name)
  ensures ProofLib.DistinctBy(completedFields(rows, name, level), (entry: FieldRecord) => entry.name)
{
  StructuredLookupName(rows, name);
  if name != "" {
    var entry := fieldAt(rows, name);
    StructuredPutUnique(rows, entry.(status := FieldStatus.CompleteField, hasEmitted := (entry.hasEmitted || (level <= 1 && |entry.content| > 0)), emitted := (if level <= 1 && |entry.content| > 0 then entry.content else entry.emitted)));
  }
}

lemma StructuredAppendUnique(rows: seq<FieldRecord>, name: string, value: seq<int>)
  requires ProofLib.DistinctBy(rows, (entry: FieldRecord) => entry.name)
  ensures ProofLib.DistinctBy(appendedFields(rows, name, value), (entry: FieldRecord) => entry.name)
{
  StructuredLookupName(rows, name);
  var entry := fieldAt(rows, name);
  StructuredPutUnique(rows, entry.(hasContent := true, content := (if |entry.content| == 0 then value else entry.content + [10] + value)));
}

lemma StructuredEmissionNames(rows: seq<FieldRecord>, name: string, revision: int)
  ensures forall chunk :: chunk in emitChunks(rows, name, revision) ==> chunk.name == name
{}

lemma StructuredEmittedUnique(rows: seq<FieldRecord>, name: string)
  requires ProofLib.DistinctBy(rows, (entry: FieldRecord) => entry.name)
  ensures ProofLib.DistinctBy(emittedFields(rows, name), (entry: FieldRecord) => entry.name)
{
  StructuredLookupName(rows, name);
  if |fieldAt(rows, name).content| > 0 {
    StructuredPutUnique(rows, fieldAt(rows, name).(emitted := fieldAt(rows, name).content, hasEmitted := true));
  }
}

lemma StructuredFlushFold(names: seq<string>, selected: seq<string>, emission: Emission, revision: int)
  requires ProofLib.DistinctBy(emission.fieldRows, (entry: FieldRecord) => entry.name)
  requires forall chunk :: chunk in emission.chunks ==> chunk.name in selected
  requires forall name :: name in names ==> name in selected
  ensures ProofLib.DistinctBy(Std.Collections.Seq.FoldLeft((emission: Emission, name: string) => flushSelected(emission, name, revision), emission, names).fieldRows, (entry: FieldRecord) => entry.name)
  ensures forall chunk :: chunk in Std.Collections.Seq.FoldLeft((emission: Emission, name: string) => flushSelected(emission, name, revision), emission, names).chunks ==> chunk.name in selected
  decreases |names|
{
  if |names| > 0 {
    StructuredEmittedUnique(emission.fieldRows, names[0]);
    StructuredEmissionNames(emission.fieldRows, names[0], revision);
    StructuredFlushFold(names[1..], selected, flushSelected(emission, names[0], revision), revision);
  }
}

lemma StructuredDoneFacts(s: StructuredState)
  ensures alwaysDoneValuesUnique(s) == ((forall entry :: entry in s.doneValues ==> entry.name in s.done) && ProofLib.DistinctBy(s.doneValues, (entry: FieldDone) => entry.name))
{
  StructuredDoneShape(s);
  if alwaysDoneValuesUnique(s) {
    forall i, j | 0 <= i < |s.doneValues| && 0 <= j < |s.doneValues| && i != j ensures s.doneValues[i].name != s.doneValues[j].name {
      ProofLib.FilterCountOneIffUnique((other: FieldDone) => (other.name == s.doneValues[i].name), s.doneValues, (entry: FieldDone) => entry.name, i);
    }
  } else if (forall entry :: entry in s.doneValues ==> entry.name in s.done) && ProofLib.DistinctBy(s.doneValues, (entry: FieldDone) => entry.name) {
    forall entry | entry in s.doneValues ensures |ProofLib.Filter((other: FieldDone) => (other.name == entry.name), s.doneValues)| == 1 {
      var i :| 0 <= i < |s.doneValues| && s.doneValues[i] == entry;
      ProofLib.FilterOne((other: FieldDone) => (other.name == entry.name), s.doneValues, i);
    }
  }
}

lemma StructuredDoneShape(s: StructuredState)
  ensures alwaysDoneValuesUnique(s) == (forall entry :: entry in s.doneValues ==> entry.name in s.done && |ProofLib.Filter((other: FieldDone) => (other.name == entry.name), s.doneValues)| == 1)
{}

lemma StructuredAddName(values: seq<string>, name: string)
  ensures name in values + ProofLib.Filter((set_x: string) => !((set_x in values)), [name])
{
  ProofLib.FilterCons((set_x: string) => !((set_x in values)), [name]);
  ProofLib.FilterNil((set_x: string) => !((set_x in values)), []);
}

lemma StructuredAppendDone(rows: seq<FieldDone>, names: seq<string>, name: string, units: seq<int>)
  requires ProofLib.DistinctBy(rows, (entry: FieldDone) => entry.name)
  requires forall entry :: entry in rows ==> entry.name in names
  requires name !in names
  ensures ProofLib.DistinctBy(rows + [FieldDone(name, units)], (entry: FieldDone) => entry.name)
{
  ProofLib.DistinctByConcat(rows, [FieldDone(name, units)], (entry: FieldDone) => entry.name);
}
