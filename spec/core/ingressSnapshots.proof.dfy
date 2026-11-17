lemma IngressFilters(s: IngressSnapshots)
  ensures alwaysOneObjectAndBindingPerReference(s) == ((forall entry :: entry in s.objects ==> |ProofLib.Filter((other: MessageObject) => (other.reference == entry.reference), s.objects)| == 1) && (forall entry :: entry in s.bindings ==> |ProofLib.Filter((other: MessageObject) => (other.reference == entry.reference), s.bindings)| == 1))
{}

lemma IngressDistinct(rows: seq<MessageObject>)
  ensures (forall row :: row in rows ==> |ProofLib.Filter((other: MessageObject) => (other.reference == row.reference), rows)| == 1) <==> ProofLib.DistinctBy(rows, (row: MessageObject) => row.reference)
{
  if forall row :: row in rows ==> |ProofLib.Filter((other: MessageObject) => (other.reference == row.reference), rows)| == 1 {
    forall i, j | 0 <= i < |rows| && 0 <= j < |rows| && i != j
      ensures rows[i].reference != rows[j].reference
    {
      ProofLib.FilterCountOneIffUnique((other: MessageObject) => (other.reference == rows[i].reference), rows, (row: MessageObject) => row.reference, i);
    }
  } else if ProofLib.DistinctBy(rows, (row: MessageObject) => row.reference) {
    forall row | row in rows
      ensures |ProofLib.Filter((other: MessageObject) => (other.reference == row.reference), rows)| == 1
    {
      var i :| 0 <= i < |rows| && rows[i] == row;
      ProofLib.FilterOne((other: MessageObject) => (other.reference == row.reference), rows, i);
    }
  }
}

lemma IngressBindParts(s: IngressSnapshots, reference: string, identity: MessageIdentity, content: string)
  ensures bindSnapshot(s, reference, identity, content) == s.(bindings := ProofLib.Filter((entry: MessageObject) => (entry.reference != reference), s.bindings) + [MessageObject(reference, identity, content)])
{}

lemma installObject_ensures(s: IngressSnapshots, reference: string, identity: MessageIdentity, content: string)
  ensures (inv(s) ==> alwaysOneObjectAndBindingPerReference(installObject(s, reference, identity, content)))
  ensures (inv(s) ==> stepPromptMutationLeavesSnapshot(s, "installObject", installObject(s, reference, identity, content)))
{
  if inv(s) {
    var after := installObject(s, reference, identity, content);
    IngressFilters(s);
    IngressFilters(after);
    IngressDistinct(s.objects);
    if exists entry :: entry in s.objects && entry.reference == reference {
      assert |after.objects| == |s.objects|;
      forall i, j | 0 <= i < |after.objects| && 0 <= j < |after.objects| && i != j
        ensures after.objects[i].reference != after.objects[j].reference
      {
        assert after.objects[i].reference == s.objects[i].reference;
        assert after.objects[j].reference == s.objects[j].reference;
      }
    } else {
      ProofLib.DistinctByConcat(s.objects, [MessageObject(reference, identity, content)], (row: MessageObject) => row.reference);
    }
    IngressDistinct(after.objects);
  }
}

lemma bindSnapshot_ensures(s: IngressSnapshots, reference: string, identity: MessageIdentity, content: string)
  ensures (inv(s) ==> canBindSnapshot(s, reference, identity) ==> alwaysOneObjectAndBindingPerReference(bindSnapshot(s, reference, identity, content)))
  ensures (inv(s) ==> canBindSnapshot(s, reference, identity) ==> stepPromptMutationLeavesSnapshot(s, "bindSnapshot", bindSnapshot(s, reference, identity, content)))
{
  if inv(s) && canBindSnapshot(s, reference, identity) {
    var after := bindSnapshot(s, reference, identity, content);
    IngressFilters(s);
    IngressFilters(after);
    IngressDistinct(s.bindings);
    IngressBindParts(s, reference, identity, content);
    var keep := (entry: MessageObject) => (entry.reference != reference);
    var kept := ProofLib.Filter(keep, s.bindings);
    ProofLib.FilterKeepsDistinctBy(keep, s.bindings, (row: MessageObject) => row.reference);
    forall entry | entry in kept ensures entry.reference != reference {
      ProofLib.FilterMember(keep, s.bindings, entry);
    }
    ProofLib.DistinctByConcat(kept, [MessageObject(reference, identity, content)], (row: MessageObject) => row.reference);
    IngressDistinct(after.bindings);
  }
}

lemma inheritSnapshot_ensures(s: IngressSnapshots, sourceReference: string, targetReference: string)
  ensures (inv(s) ==> canInheritSnapshot(s, sourceReference, targetReference) ==> alwaysOneObjectAndBindingPerReference(inheritSnapshot(s, sourceReference, targetReference)))
  ensures (inv(s) ==> canInheritSnapshot(s, sourceReference, targetReference) ==> stepPromptMutationLeavesSnapshot(s, "inheritSnapshot", inheritSnapshot(s, sourceReference, targetReference)))
{
  if inv(s) && canInheritSnapshot(s, sourceReference, targetReference) {
    bindSnapshot_ensures(s, targetReference, bindingAt(s, sourceReference).identity, bindingAt(s, sourceReference).content);
  }
}
