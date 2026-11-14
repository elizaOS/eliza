lemma SkeletonPrefixPlusTail(prefix: seq<int>, suffix: seq<int>)
  requires |suffix| <= 1
  ensures core__streamUnits_unitPrefix(prefix + suffix, prefix)
  ensures |prefix + suffix| - |prefix| <= 1
{
  SkeletonPrefixFold(prefix + suffix, 0, |prefix|, []);
  assert (prefix + suffix)[..|prefix|] == prefix;
}

lemma {:induction false} SkeletonPrefixFold(xs: seq<int>, offset: int, end: int, acc: seq<int>)
  requires 0 <= offset <= end <= offset + |xs|
  ensures Std.Collections.Seq.FoldLeft((walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= 0) && (walk.offset < end)) then (walk.units + [code]) else walk.units)), core__streamUnits_SliceWalk(offset, acc), xs).units == acc + xs[..end - offset]
  decreases |xs|
{
  if |xs| > 0 {
    var f := (walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= 0) && (walk.offset < end)) then (walk.units + [code]) else walk.units));
    var next := f(core__streamUnits_SliceWalk(offset, acc), xs[0]);
    assert Std.Collections.Seq.FoldLeft(f, core__streamUnits_SliceWalk(offset, acc), xs) == Std.Collections.Seq.FoldLeft(f, next, xs[1..]);
    if offset < end {
      SkeletonPrefixFold(xs[1..], offset + 1, end, acc + [xs[0]]);
      assert xs[..end - offset] == [xs[0]] + xs[1..][..end - offset - 1];
    } else {
      SkeletonPrefixFoldPastEnd(xs[1..], offset + 1, end, acc);
    }
  }
}

lemma SkeletonPrefixFoldPastEnd(xs: seq<int>, offset: int, end: int, acc: seq<int>)
  requires offset >= end
  ensures Std.Collections.Seq.FoldLeft((walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= 0) && (walk.offset < end)) then (walk.units + [code]) else walk.units)), core__streamUnits_SliceWalk(offset, acc), xs).units == acc
  decreases |xs|
{
  if |xs| > 0 {
    SkeletonPrefixFoldPastEnd(xs[1..], offset + 1, end, acc);
  }
}

lemma SkeletonRowsPreservePrefix(rows: seq<SkeletonField>, row: SkeletonField)
  requires forall existing :: existing in rows ==> core__streamUnits_unitPrefix(existing.content, existing.emitted) && |existing.content| - |existing.emitted| <= 1
  requires core__streamUnits_unitPrefix(row.content, row.emitted) && |row.content| - |row.emitted| <= 1
  ensures forall after :: after in writeRow(rows, row) ==> core__streamUnits_unitPrefix(after.content, after.emitted) && |after.content| - |after.emitted| <= 1
{
  var result := writeRow(rows, row);
  forall after | after in result ensures core__streamUnits_unitPrefix(after.content, after.emitted) && |after.content| - |after.emitted| <= 1 {
    if after != row {
      if exists previous :: previous in rows && previous.name == row.name {
        var i :| 0 <= i < |result| && result[i] == after;
        assert after == rows[i];
      }
      assert after in rows;
    }
  }
}

lemma SkeletonLookupPrefix(s: SkeletonState, name: string)
  requires alwaysEmittedPrefixIsRetained(s)
  ensures core__streamUnits_unitPrefix(rowAt(s.fieldRows, name).content, rowAt(s.fieldRows, name).emitted)
  ensures |rowAt(s.fieldRows, name).content| - |rowAt(s.fieldRows, name).emitted| <= 1
{
  var rows := s.fieldRows;
  var sameName := (row: SkeletonField) => row.name == name;
  var matches := Std.Collections.Seq.Filter(sameName, rows);
  reveal ProofLib.Filter();
  if |matches| > 0 {
    assert rowAt(rows, name) == matches[0];
    ProofLib.FilterMember(sameName, rows, matches[0]);
    assert matches[0] in rows;
  } else {
    assert rowAt(rows, name) == noField.(name := name);
    SkeletonPrefixPlusTail([], []);
  }
}

lemma searchUnordered_ensures(s: SkeletonState, finalChunk: bool, prefixDecodable: bool, resultTrue: bool)
  ensures (inv(s) ==> canSearchUnordered(s) ==> alwaysEmittedPrefixIsRetained(searchUnordered(s, finalChunk, prefixDecodable, resultTrue)))
  ensures (inv(s) ==> canSearchUnordered(s) ==> alwaysEscapePrefixIsRecognized(searchUnordered(s, finalChunk, prefixDecodable, resultTrue)))
  ensures (inv(s) ==> canSearchUnordered(s) ==> alwaysHeldBuffersAreEmpty(searchUnordered(s, finalChunk, prefixDecodable, resultTrue)))
{
  if inv(s) && canSearchUnordered(s) {
    var after := searchUnordered(s, finalChunk, prefixDecodable, resultTrue);
    assert after == heldState(s) || after == heldState(s.(gateDecided := true)) || !after.held;
    assert after.fieldRows == s.fieldRows && after.pendingEscape == s.pendingEscape;
  }
}

lemma SkeletonAppendPrefix(s: SkeletonState, name: string, units: seq<int>, finalChunk: bool)
  requires alwaysEmittedPrefixIsRetained(s)
  ensures alwaysEmittedPrefixIsRetained(appendFiltered(s, name, units, finalChunk))
{
  var prior := rowAt(s.fieldRows, name);
  var f := filtered(prior, units, finalChunk);
  var updated := prior.(hasFilter := true, insideReasoning := f.inside, filterPending := f.pending, closeTag := f.closing);
  var row := if |f.visible| > 0 then visibleRow(updated, f.visible) else updated;
  if |f.visible| > 0 {
    var raw := updated.content + f.visible;
    var chunk := core__streamUnits_sliceUnits(raw, |updated.emitted|, |raw|);
    var tail := if |chunk| > 0 then chunk[|chunk|-1] else -1;
    var residue := if core__streamUnits_high(tail) then [tail] else [];
    assert row.content == row.emitted + residue;
    SkeletonPrefixPlusTail(row.emitted, residue);
  } else {
    SkeletonLookupPrefix(s, name);
  }
  SkeletonRowsPreservePrefix(s.fieldRows, row);
}

lemma appendFiltered_ensures(s: SkeletonState, name: string, units: seq<int>, finalChunk: bool)
  ensures (inv(s) ==> canAppendFiltered(s, name) ==> alwaysEmittedPrefixIsRetained(appendFiltered(s, name, units, finalChunk)))
  ensures (inv(s) ==> canAppendFiltered(s, name) ==> alwaysEscapePrefixIsRecognized(appendFiltered(s, name, units, finalChunk)))
  ensures (inv(s) ==> canAppendFiltered(s, name) ==> alwaysHeldBuffersAreEmpty(appendFiltered(s, name, units, finalChunk)))
{
  if inv(s) && canAppendFiltered(s, name) {
    SkeletonAppendPrefix(s, name, units, finalChunk);
  }
}

lemma flushFilter_ensures(s: SkeletonState, name: string)
  ensures (inv(s) ==> canFlushFilter(s, name) ==> alwaysEmittedPrefixIsRetained(flushFilter(s, name)))
  ensures (inv(s) ==> canFlushFilter(s, name) ==> alwaysEscapePrefixIsRecognized(flushFilter(s, name)))
  ensures (inv(s) ==> canFlushFilter(s, name) ==> alwaysHeldBuffersAreEmpty(flushFilter(s, name)))
{
  if inv(s) && canFlushFilter(s, name) {
    SkeletonAppendPrefix(s, name, [], true);
  }
}

lemma flushSurrogate_ensures(s: SkeletonState, name: string)
  ensures (inv(s) ==> canFlushSurrogate(s, name) ==> alwaysEmittedPrefixIsRetained(flushSurrogate(s, name)))
  ensures (inv(s) ==> canFlushSurrogate(s, name) ==> alwaysEscapePrefixIsRecognized(flushSurrogate(s, name)))
  ensures (inv(s) ==> canFlushSurrogate(s, name) ==> alwaysHeldBuffersAreEmpty(flushSurrogate(s, name)))
{
  if inv(s) && canFlushSurrogate(s, name) {
    var prior := rowAt(s.fieldRows, name);
    var accumulated := prior.emitted + core__streamUnits_wellFormed(core__streamUnits_sliceUnits(prior.content, |prior.emitted|, |prior.content|));
    SkeletonPrefixPlusTail(accumulated, []);
    SkeletonRowsPreservePrefix(s.fieldRows, prior.(content := accumulated, emitted := accumulated, hasContent := true, hasEmitted := true));
  }
}

lemma stringStep_ensures(s: SkeletonState)
  ensures (inv(s) ==> canStringStep(s) ==> alwaysEmittedPrefixIsRetained(stringStep(s)))
  ensures (inv(s) ==> canStringStep(s) ==> alwaysEscapePrefixIsRecognized(stringStep(s)))
  ensures (inv(s) ==> canStringStep(s) ==> alwaysHeldBuffersAreEmpty(stringStep(s)))
{
  if inv(s) && canStringStep(s) {
    var local_21 := (if ((0 <= 0) && (0 < |s.buffer|)) then s.buffer[0] else -1);
    var local_22 := (if (s.pendingEscape == [92, 117]) then 4 else 1);
    var local_23 := core__streamUnits_findUnits(s.buffer, [34]);
    var local_24 := core__streamUnits_findUnits(s.buffer, [92]);
    var local_25 := (if (local_23 < 0) then (if (local_24 < 0) then |s.buffer| else local_24) else (if ((local_24 < 0) || (local_23 < local_24)) then local_23 else local_24));
    if |s.pendingEscape| > 0 && !(s.pendingEscape == [92] && local_21 == 117) && |s.buffer| >= local_22 {
      SkeletonAppendPrefix(s.(pendingEscape := [], buffer := core__streamUnits_sliceUnits(s.buffer, local_22, |s.buffer|)), s.activeField, core__streamUnits_decodeEscape(s.pendingEscape + core__streamUnits_sliceUnits(s.buffer, 0, local_22)), false);
    } else if |s.pendingEscape| == 0 && local_25 > 0 {
      SkeletonAppendPrefix(s.(buffer := core__streamUnits_sliceUnits(s.buffer, local_25, |s.buffer|)), s.activeField, core__streamUnits_sliceUnits(s.buffer, 0, local_25), false);
    } else if |s.pendingEscape| == 0 && local_25 <= 0 && local_21 == 34 {
      SkeletonAppendPrefix(s.(activeField := "", buffer := core__streamUnits_sliceUnits(s.buffer, 1, |s.buffer|), spanIndex := (s.spanIndex + (if s.unordered then 0 else 1))), s.activeField, [], true);
    }
  }
}

lemma partsStep_ensures(s: SkeletonState, finalChunk: bool, keyIsKind: bool, keyIsValue: bool, decodedKind: seq<int>, validKindString: bool)
  ensures (inv(s) ==> canPartsStep(s, keyIsKind, keyIsValue) ==> alwaysEmittedPrefixIsRetained(partsStep(s, finalChunk, keyIsKind, keyIsValue, decodedKind, validKindString)))
  ensures (inv(s) ==> canPartsStep(s, keyIsKind, keyIsValue) ==> alwaysEscapePrefixIsRecognized(partsStep(s, finalChunk, keyIsKind, keyIsValue, decodedKind, validKindString)))
  ensures (inv(s) ==> canPartsStep(s, keyIsKind, keyIsValue) ==> alwaysHeldBuffersAreEmpty(partsStep(s, finalChunk, keyIsKind, keyIsValue, decodedKind, validKindString)))
{
  if inv(s) && canPartsStep(s, keyIsKind, keyIsValue) {
    var after := partsStep(s, finalChunk, keyIsKind, keyIsValue, decodedKind, validKindString);
    assert after.fieldRows == s.fieldRows;
    assert after.pendingEscape == s.pendingEscape;
    assert after.held ==> after.buffer == [] && after.gateHead == [] && after.activeField == "" && after.partsField == "";
  }
}
