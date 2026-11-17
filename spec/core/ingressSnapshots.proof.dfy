// The rule alwaysOneObjectAndBindingPerReference says that no two objects
// and no two bindings share a reference. The helpers below show it is the
// same as ProofLib.DistinctBy on the reference.

lemma CountsGiveDistinct(xs: seq<MessageObject>)
  requires !((exists entry :: entry in xs && !((|ProofLib.Filter((other: MessageObject) => (other.reference == entry.reference), xs)| == 1))))
  ensures ProofLib.DistinctBy(xs, (m: MessageObject) => m.reference)
{
  forall i, k | 0 <= i < |xs| && 0 <= k < |xs| && i != k
    ensures xs[i].reference != xs[k].reference
  {
    var entry := xs[i];
    ProofLib.FilterCountOneIffUnique((other: MessageObject) => (other.reference == entry.reference), xs, (m: MessageObject) => m.reference, i);
  }
}

lemma DistinctGivesCounts(xs: seq<MessageObject>)
  requires ProofLib.DistinctBy(xs, (m: MessageObject) => m.reference)
  ensures !((exists entry :: entry in xs && !((|ProofLib.Filter((other: MessageObject) => (other.reference == entry.reference), xs)| == 1))))
{
  forall entry | entry in xs
    ensures |ProofLib.Filter((other: MessageObject) => (other.reference == entry.reference), xs)| == 1
  {
    var i :| 0 <= i < |xs| && xs[i] == entry;
    ProofLib.FilterCountOneIffUnique((other: MessageObject) => (other.reference == entry.reference), xs, (m: MessageObject) => m.reference, i);
  }
}

lemma InvDistinct(s: IngressSnapshots)
  requires alwaysOneObjectAndBindingPerReference(s)
  ensures ProofLib.DistinctBy(s.objects, (m: MessageObject) => m.reference)
  ensures ProofLib.DistinctBy(s.bindings, (m: MessageObject) => m.reference)
{
  CountsGiveDistinct(s.objects);
  CountsGiveDistinct(s.bindings);
}

lemma DistinctInv(s: IngressSnapshots)
  requires ProofLib.DistinctBy(s.objects, (m: MessageObject) => m.reference)
  requires ProofLib.DistinctBy(s.bindings, (m: MessageObject) => m.reference)
  ensures alwaysOneObjectAndBindingPerReference(s)
{
  DistinctGivesCounts(s.objects);
  DistinctGivesCounts(s.bindings);
}

lemma AppendFresh(xs: seq<MessageObject>, x: MessageObject)
  requires ProofLib.DistinctBy(xs, (m: MessageObject) => m.reference)
  requires forall y :: y in xs ==> y.reference != x.reference
  ensures ProofLib.DistinctBy(xs + [x], (m: MessageObject) => m.reference)
{
  ProofLib.DistinctByConcat(xs, [x], (m: MessageObject) => m.reference);
}

lemma InstallKeepsReferences(s: IngressSnapshots, reference: string, identity: MessageIdentity, content: string)
  requires alwaysOneObjectAndBindingPerReference(s)
  ensures alwaysOneObjectAndBindingPerReference(installObject(s, reference, identity, content))
{
  InvDistinct(s);
  var after := installObject(s, reference, identity, content);
  if !exists entry :: entry in s.objects && (entry.reference == reference) {
    AppendFresh(s.objects, MessageObject(reference, identity, content));
  }
  DistinctInv(after);
}

lemma BindKeepsReferences(s: IngressSnapshots, reference: string, identity: MessageIdentity, content: string)
  requires alwaysOneObjectAndBindingPerReference(s)
  ensures alwaysOneObjectAndBindingPerReference(bindSnapshot(s, reference, identity, content))
{
  InvDistinct(s);
  var after := bindSnapshot(s, reference, identity, content);
  var kept := ProofLib.Filter((entry: MessageObject) => (entry.reference != reference), s.bindings);
  ProofLib.FilterKeepsDistinctBy((entry: MessageObject) => (entry.reference != reference), s.bindings, (m: MessageObject) => m.reference);
  AppendFresh(kept, MessageObject(reference, identity, content));
  DistinctInv(after);
}

lemma installObject_ensures(s: IngressSnapshots, reference: string, identity: MessageIdentity, content: string)
  ensures (inv(s) ==> alwaysOneObjectAndBindingPerReference(installObject(s, reference, identity, content)))
  ensures (inv(s) ==> stepPromptMutationLeavesSnapshot(s, "installObject", installObject(s, reference, identity, content)))
{
  if inv(s) {
    InstallKeepsReferences(s, reference, identity, content);
  }
}

lemma bindSnapshot_ensures(s: IngressSnapshots, reference: string, identity: MessageIdentity, content: string)
  ensures (inv(s) ==> canBindSnapshot(s, reference, identity) ==> alwaysOneObjectAndBindingPerReference(bindSnapshot(s, reference, identity, content)))
  ensures (inv(s) ==> canBindSnapshot(s, reference, identity) ==> stepPromptMutationLeavesSnapshot(s, "bindSnapshot", bindSnapshot(s, reference, identity, content)))
{
  if inv(s) {
    BindKeepsReferences(s, reference, identity, content);
  }
}

lemma inheritSnapshot_ensures(s: IngressSnapshots, sourceReference: string, targetReference: string)
  ensures (inv(s) ==> canInheritSnapshot(s, sourceReference, targetReference) ==> alwaysOneObjectAndBindingPerReference(inheritSnapshot(s, sourceReference, targetReference)))
  ensures (inv(s) ==> canInheritSnapshot(s, sourceReference, targetReference) ==> stepPromptMutationLeavesSnapshot(s, "inheritSnapshot", inheritSnapshot(s, sourceReference, targetReference)))
{
  if inv(s) {
    BindKeepsReferences(s, targetReference, bindingAt(s, sourceReference).identity, bindingAt(s, sourceReference).content);
  }
}
