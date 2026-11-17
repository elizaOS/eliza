lemma installObject_ensures(s: IngressSnapshots, reference: string, identity: MessageIdentity, content: string)
  ensures (inv(s) ==> alwaysOneObjectAndBindingPerReference(installObject(s, reference, identity, content)))
  ensures (inv(s) ==> stepPromptMutationLeavesSnapshot(s, "installObject", installObject(s, reference, identity, content)))
{
  if inv(s) {
    var after := installObject(s, reference, identity, content);
    OneRefRule(s);
    OneRefRule(after);
    if !(exists entry :: entry in s.objects && (entry.reference == reference)) {
      ProofLib.DistinctByConcat(s.objects, [MessageObject(reference, identity, content)], (m: MessageObject) => m.reference);
    }
  }
}

lemma bindSnapshot_ensures(s: IngressSnapshots, reference: string, identity: MessageIdentity, content: string)
  ensures (inv(s) ==> canBindSnapshot(s, reference, identity) ==> alwaysOneObjectAndBindingPerReference(bindSnapshot(s, reference, identity, content)))
  ensures (inv(s) ==> canBindSnapshot(s, reference, identity) ==> stepPromptMutationLeavesSnapshot(s, "bindSnapshot", bindSnapshot(s, reference, identity, content)))
{
  if inv(s) {
    BindKeepsOneRef(s, reference, identity, content);
  }
}

lemma inheritSnapshot_ensures(s: IngressSnapshots, sourceReference: string, targetReference: string)
  ensures (inv(s) ==> canInheritSnapshot(s, sourceReference, targetReference) ==> alwaysOneObjectAndBindingPerReference(inheritSnapshot(s, sourceReference, targetReference)))
  ensures (inv(s) ==> canInheritSnapshot(s, sourceReference, targetReference) ==> stepPromptMutationLeavesSnapshot(s, "inheritSnapshot", inheritSnapshot(s, sourceReference, targetReference)))
{
  if inv(s) {
    BindKeepsOneRef(s, targetReference, bindingAt(s, sourceReference).identity, bindingAt(s, sourceReference).content);
  }
}

lemma BindKeepsOneRef(s: IngressSnapshots, reference: string, identity: MessageIdentity, content: string)
  requires alwaysOneObjectAndBindingPerReference(s)
  ensures alwaysOneObjectAndBindingPerReference(bindSnapshot(s, reference, identity, content))
{
  var after := bindSnapshot(s, reference, identity, content);
  var kept := ProofLib.Filter((entry: MessageObject) => (entry.reference != reference), s.bindings);
  OneRefRule(s);
  OneRefRule(after);
  assert after.bindings == kept + [MessageObject(reference, identity, content)];
  ProofLib.FilterKeepsDistinctBy((entry: MessageObject) => (entry.reference != reference), s.bindings, (m: MessageObject) => m.reference);
  forall x | x in kept ensures x.reference != reference {
    ProofLib.FilterMember((entry: MessageObject) => (entry.reference != reference), s.bindings, x);
  }
  ProofLib.DistinctByConcat(kept, [MessageObject(reference, identity, content)], (m: MessageObject) => m.reference);
}

lemma OneRefRule(s: IngressSnapshots)
  ensures alwaysOneObjectAndBindingPerReference(s) <==> ProofLib.DistinctBy(s.objects, (m: MessageObject) => m.reference) && ProofLib.DistinctBy(s.bindings, (m: MessageObject) => m.reference)
{
  OneRefFilter(s);
  UniqueRefs(s.objects);
  UniqueRefs(s.bindings);
}

lemma OneRefFilter(s: IngressSnapshots)
  ensures alwaysOneObjectAndBindingPerReference(s) == (!((exists entry :: entry in s.objects && !((|ProofLib.Filter((other: MessageObject) => (other.reference == entry.reference), s.objects)| == 1)))) && !((exists entry :: entry in s.bindings && !((|ProofLib.Filter((other: MessageObject) => (other.reference == entry.reference), s.bindings)| == 1)))))
{
}

lemma UniqueRefs(xs: seq<MessageObject>)
  ensures !((exists entry :: entry in xs && !((|ProofLib.Filter((other: MessageObject) => (other.reference == entry.reference), xs)| == 1)))) <==> ProofLib.DistinctBy(xs, (m: MessageObject) => m.reference)
{
  forall i | 0 <= i < |xs|
    ensures |ProofLib.Filter((other: MessageObject) => (other.reference == xs[i].reference), xs)| == 1 <==> forall j :: 0 <= j < |xs| && j != i ==> xs[j].reference != xs[i].reference
  {
    ProofLib.FilterCountOneIffUnique((other: MessageObject) => (other.reference == xs[i].reference), xs, (m: MessageObject) => m.reference, i);
  }
  if ProofLib.DistinctBy(xs, (m: MessageObject) => m.reference) {
    forall entry | entry in xs ensures |ProofLib.Filter((other: MessageObject) => (other.reference == entry.reference), xs)| == 1 {
      var i :| 0 <= i < |xs| && xs[i] == entry;
    }
  } else {
    var i, j :| 0 <= i < |xs| && 0 <= j < |xs| && i != j && xs[i].reference == xs[j].reference;
    assert xs[i] in xs;
  }
}
