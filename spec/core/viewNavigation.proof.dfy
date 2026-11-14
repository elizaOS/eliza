lemma dispatchHandoff_ensures(s: Navigation, id: string, handledByShell: bool, handlerNavigates: bool, pathAfterHandler: string)
  ensures (inv(s) ==> alwaysBoundedNavigationIndexes(dispatchHandoff(s, id, handledByShell, handlerNavigates, pathAfterHandler)))
  ensures (inv(s) ==> alwaysUniqueNavigationIndexes(dispatchHandoff(s, id, handledByShell, handlerNavigates, pathAfterHandler)))
{
  if inv(s) {
    var prior := pendingAt(s, id);
    var stale := id != "" && prior.id == id && (prior.epoch != s.epoch || prior.path != s.path);
    var refused := s.windowId == "" || (id != "" && id in s.handled) || stale;
    var observed := s.(lastId := id, lastEmitted := !refused);
    var delivered := if handlerNavigates && !refused then observed.(epoch := s.epoch + 1, path := pathAfterHandler) else observed;
    if stale {
      NavigationHandle(observed, id);
    } else if !refused && id != "" {
      if handledByShell { NavigationHandle(delivered, id); }
      else if prior.id == "" { NavigationRemember(delivered, PendingHandoff(id, s.epoch, s.path)); }
    }
  }
}

lemma NavigationHandledDistinct(ids: seq<string>)
  ensures ProofLib.DistinctBy(ids, (item: string) => item) <==> (forall id :: id in ids ==> |ProofLib.Filter((other: string) => other == id, ids)| == 1)
{
  var key := (value: string) => value;
  if ProofLib.DistinctBy(ids, key) {
    forall id | id in ids ensures |ProofLib.Filter((other: string) => other == id, ids)| == 1 {
      var i :| 0 <= i < |ids| && ids[i] == id;
      ProofLib.FilterCountOneIffUnique((other: string) => other == id, ids, key, i);
    }
  } else if forall id :: id in ids ==> |ProofLib.Filter((other: string) => other == id, ids)| == 1 {
    forall i, j | 0 <= i < |ids| && 0 <= j < |ids| && i != j ensures ids[i] != ids[j] {
      assert ids[i] in ids;
      var p := (other: string) => other == ids[i];
      assert |ProofLib.Filter(p, ids)| == 1;
      ProofLib.FilterCountOneIffUnique(p, ids, key, i);
    }
  }
}

lemma NavigationPendingDistinct(rows: seq<PendingHandoff>)
  ensures ProofLib.DistinctBy(rows, (item: PendingHandoff) => item.id) <==> (forall row :: row in rows ==> |ProofLib.Filter((other: PendingHandoff) => other.id == row.id, rows)| == 1)
{
  var key := (row: PendingHandoff) => row.id;
  if ProofLib.DistinctBy(rows, key) {
    forall row | row in rows ensures |ProofLib.Filter((other: PendingHandoff) => other.id == row.id, rows)| == 1 {
      var i :| 0 <= i < |rows| && rows[i] == row;
      ProofLib.FilterCountOneIffUnique((other: PendingHandoff) => other.id == row.id, rows, key, i);
    }
  } else if forall row :: row in rows ==> |ProofLib.Filter((other: PendingHandoff) => other.id == row.id, rows)| == 1 {
    forall i, j | 0 <= i < |rows| && 0 <= j < |rows| && i != j ensures rows[i].id != rows[j].id {
      assert rows[i] in rows;
      var p := (other: PendingHandoff) => other.id == rows[i].id;
      assert |ProofLib.Filter(p, rows)| == 1;
      ProofLib.FilterCountOneIffUnique(p, rows, key, i);
    }
  }
}

lemma NavigationHandle(s: Navigation, id: string)
  requires alwaysUniqueNavigationIndexes(s)
  ensures alwaysUniqueNavigationIndexes(rememberHandled(id, s))
{
  var after := rememberHandled(id, s);
  NavigationHandledDistinct(s.handled);
  NavigationPendingDistinct(s.pending);
  var keepHandled := (other: string) => other != id;
  var keepPending := (other: PendingHandoff) => other.id != id;
  var source := ProofLib.Filter(keepHandled, s.handled);
  ProofLib.FilterKeepsDistinctBy(keepPending, s.pending, (row: PendingHandoff) => row.id);
  ProofLib.FilterKeepsDistinctBy(keepHandled, s.handled, (value: string) => value);
  ProofLib.FilterMember(keepHandled, s.handled, id);
  ProofLib.DistinctByConcat(source, [id], (value: string) => value);
  NavigationDropOneKeepsKeys(source + [id], after.handled, (value: string) => value);
  NavigationPendingDistinct(after.pending);
  NavigationHandledDistinct(after.handled);
  forall row | row in after.pending ensures row.id !in after.handled {
    ProofLib.FilterMember(keepPending, s.pending, row);
    if row.id in after.handled {
      assert row.id in source + [id];
      ProofLib.FilterMember(keepHandled, s.handled, row.id);
    }
  }
}

lemma NavigationRemember(s: Navigation, entry: PendingHandoff)
  requires alwaysUniqueNavigationIndexes(s) && entry.id !in s.handled
  ensures alwaysUniqueNavigationIndexes(rememberPending(entry, s))
{
  var after := rememberPending(entry, s);
  NavigationPendingDistinct(s.pending);
  var keep := (prior: PendingHandoff) => prior.id != entry.id;
  var source := ProofLib.Filter(keep, s.pending);
  ProofLib.FilterKeepsDistinctBy(keep, s.pending, (row: PendingHandoff) => row.id);
  forall i | 0 <= i < |source| ensures source[i].id != entry.id {
    ProofLib.FilterMember(keep, s.pending, source[i]);
  }
  ProofLib.DistinctByConcat(source, [entry], (row: PendingHandoff) => row.id);
  NavigationDropOneKeepsKeys(source + [entry], after.pending, (row: PendingHandoff) => row.id);
  NavigationPendingDistinct(after.pending);
  forall row | row in after.pending && row != entry ensures row.id !in after.handled {
    assert row in source + [entry];
    ProofLib.FilterMember(keep, s.pending, row);
  }
}

lemma NavigationDropOneKeepsKeys<T, K>(rows: seq<T>, kept: seq<T>, key: T -> K)
  requires kept == rows || (|rows| > 0 && kept == rows[1..])
  requires ProofLib.DistinctBy(rows, key)
  ensures ProofLib.DistinctBy(kept, key)
{
  if kept != rows {
    forall i, j | 0 <= i < |kept| && 0 <= j < |kept| && i != j ensures key(kept[i]) != key(kept[j]) {
      assert kept[i] == rows[i+1] && kept[j] == rows[j+1];
    }
  }
}
