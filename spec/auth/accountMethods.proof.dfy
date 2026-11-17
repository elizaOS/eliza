lemma MethodsBridge(s: AccountMethods)
  ensures alwaysIdentitiesUnique(s) <==> ProofLib.DistinctBy(s.methods, (o: LinkedMethod) => o.identity) && ProofLib.DistinctBy(s.methods, (o: LinkedMethod) => o.kind)
{
  var ms := s.methods;
  assert alwaysIdentitiesUnique(s) <==> forall m :: m in ms ==> |ProofLib.Filter((o: LinkedMethod) => (o.identity == m.identity), ms)| == 1 && |ProofLib.Filter((o: LinkedMethod) => (o.kind == m.kind), ms)| == 1;
  forall i | 0 <= i < |ms|
    ensures |ProofLib.Filter((o: LinkedMethod) => (o.identity == ms[i].identity), ms)| == 1 <==> forall j :: 0 <= j < |ms| && j != i ==> ms[j].identity != ms[i].identity
    ensures |ProofLib.Filter((o: LinkedMethod) => (o.kind == ms[i].kind), ms)| == 1 <==> forall j :: 0 <= j < |ms| && j != i ==> ms[j].kind != ms[i].kind
  {
    ProofLib.FilterCountOneIffUnique((o: LinkedMethod) => (o.identity == ms[i].identity), ms, (o: LinkedMethod) => o.identity, i);
    ProofLib.FilterCountOneIffUnique((o: LinkedMethod) => (o.kind == ms[i].kind), ms, (o: LinkedMethod) => o.kind, i);
  }
  if ProofLib.DistinctBy(ms, (o: LinkedMethod) => o.identity) && ProofLib.DistinctBy(ms, (o: LinkedMethod) => o.kind) {
    forall m | m in ms
      ensures |ProofLib.Filter((o: LinkedMethod) => (o.identity == m.identity), ms)| == 1 && |ProofLib.Filter((o: LinkedMethod) => (o.kind == m.kind), ms)| == 1
    {
      var i :| 0 <= i < |ms| && ms[i] == m;
    }
  }
  if alwaysIdentitiesUnique(s) {
    forall i, j | 0 <= i < |ms| && 0 <= j < |ms| && i != j
      ensures ms[i].identity != ms[j].identity && ms[i].kind != ms[j].kind
    {
      assert ms[i] in ms;
    }
  }
}

lemma Audited(before: AccountMethods, changed: AccountMethods)
  ensures stepMethodChangeIsAudited(before, audited(before.methods, changed).state, audited(before.methods, changed).out)
{
  ProofLib.FilterCons((e: AuditEntry) => (e == AuditEntry.MethodAdded), [AuditEntry.MethodAdded]);
  ProofLib.FilterNil((e: AuditEntry) => (e == AuditEntry.MethodAdded), [AuditEntry.MethodAdded][1..]);
  ProofLib.FilterCons((e: AuditEntry) => (e == AuditEntry.MethodRemoved), [AuditEntry.MethodRemoved]);
  ProofLib.FilterNil((e: AuditEntry) => (e == AuditEntry.MethodRemoved), [AuditEntry.MethodRemoved][1..]);
}

lemma KindSplit(xs: seq<LinkedMethod>, kind: MethodKind)
  ensures |ProofLib.Filter((m: LinkedMethod) => (m.kind != kind), xs)| + |ProofLib.Filter((o: LinkedMethod) => (o.kind == kind), xs)| == |xs|
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil((m: LinkedMethod) => (m.kind != kind), xs);
    ProofLib.FilterNil((o: LinkedMethod) => (o.kind == kind), xs);
  } else {
    ProofLib.FilterCons((m: LinkedMethod) => (m.kind != kind), xs);
    ProofLib.FilterCons((o: LinkedMethod) => (o.kind == kind), xs);
    KindSplit(xs[1..], kind);
  }
}

lemma DropKind(s: AccountMethods, kind: MethodKind, after: AccountMethods)
  requires inv(s) && hasMethod(s, kind)
  requires after.methods == ProofLib.Filter((m: LinkedMethod) => (m.kind != kind), s.methods)
  ensures |after.methods| == |s.methods| - 1 && alwaysIdentitiesUnique(after)
{
  var m0 :| m0 in s.methods && m0.kind == kind;
  assert |ProofLib.Filter((o: LinkedMethod) => (o.kind == m0.kind), s.methods)| == 1;
  ProofLib.FilterSamePredicate((o: LinkedMethod) => (o.kind == kind), (o: LinkedMethod) => (o.kind == m0.kind), s.methods);
  KindSplit(s.methods, kind);
  MethodsBridge(s);
  MethodsBridge(after);
  ProofLib.FilterKeepsDistinctBy((m: LinkedMethod) => (m.kind != kind), s.methods, (o: LinkedMethod) => o.identity);
  ProofLib.FilterKeepsDistinctBy((m: LinkedMethod) => (m.kind != kind), s.methods, (o: LinkedMethod) => o.kind);
}

lemma unlink_ensures(s: AccountMethods, authority: AuthorityScope, reviewId: int, kind: MethodKind)
  ensures (inv(s) ==> alwaysAtLeastOneMethod(unlink(s, authority, reviewId, kind).state))
  ensures (inv(s) ==> alwaysIdentitiesUnique(unlink(s, authority, reviewId, kind).state))
  ensures (inv(s) ==> alwaysUnknownOutcomeBlocksMutation(unlink(s, authority, reviewId, kind).state))
  ensures (inv(s) ==> stepMutationNeedsFreshReview(s, "unlink", unlink(s, authority, reviewId, kind).state))
  ensures (inv(s) ==> stepCollisionChangesNothing(s, unlink(s, authority, reviewId, kind).state))
  ensures (inv(s) ==> stepUnprovenLinkChangesNothing(s, unlink(s, authority, reviewId, kind).state))
  ensures (inv(s) ==> stepTenantAuthorityChangesNothing(s, unlink(s, authority, reviewId, kind).state))
  ensures (inv(s) ==> stepMethodChangeIsAudited(s, unlink(s, authority, reviewId, kind).state, unlink(s, authority, reviewId, kind).out))
{
  if inv(s) {
    var after := unlinked(authority, reviewId, kind, s);
    Audited(s, after);
    if after.methods != s.methods {
      DropKind(s, kind, after);
    }
  }
}

lemma link_ensures(s: AccountMethods, authority: AuthorityScope, reviewId: int, kind: MethodKind, identity: string, ownedByOther: bool, proof: auth__platformUsers_LinkProof)
  ensures (inv(s) ==> canLink(s, authority, reviewId, kind, identity, ownedByOther, proof) ==> alwaysAtLeastOneMethod(link(s, authority, reviewId, kind, identity, ownedByOther, proof).state))
  ensures (inv(s) ==> canLink(s, authority, reviewId, kind, identity, ownedByOther, proof) ==> alwaysIdentitiesUnique(link(s, authority, reviewId, kind, identity, ownedByOther, proof).state))
  ensures (inv(s) ==> canLink(s, authority, reviewId, kind, identity, ownedByOther, proof) ==> alwaysUnknownOutcomeBlocksMutation(link(s, authority, reviewId, kind, identity, ownedByOther, proof).state))
  ensures (inv(s) ==> canLink(s, authority, reviewId, kind, identity, ownedByOther, proof) ==> stepMutationNeedsFreshReview(s, "link", link(s, authority, reviewId, kind, identity, ownedByOther, proof).state))
  ensures (inv(s) ==> canLink(s, authority, reviewId, kind, identity, ownedByOther, proof) ==> stepCollisionChangesNothing(s, link(s, authority, reviewId, kind, identity, ownedByOther, proof).state))
  ensures (inv(s) ==> canLink(s, authority, reviewId, kind, identity, ownedByOther, proof) ==> stepUnprovenLinkChangesNothing(s, link(s, authority, reviewId, kind, identity, ownedByOther, proof).state))
  ensures (inv(s) ==> canLink(s, authority, reviewId, kind, identity, ownedByOther, proof) ==> stepTenantAuthorityChangesNothing(s, link(s, authority, reviewId, kind, identity, ownedByOther, proof).state))
  ensures (inv(s) ==> canLink(s, authority, reviewId, kind, identity, ownedByOther, proof) ==> stepMethodChangeIsAudited(s, link(s, authority, reviewId, kind, identity, ownedByOther, proof).state, link(s, authority, reviewId, kind, identity, ownedByOther, proof).out))
{
  if inv(s) && canLink(s, authority, reviewId, kind, identity, ownedByOther, proof) {
    var after := linked(authority, reviewId, kind, identity, ownedByOther, proof, s);
    Audited(s, after);
    if after.methods != s.methods {
      MethodsBridge(s);
      MethodsBridge(after);
      ProofLib.DistinctByConcat(s.methods, [LinkedMethod(kind, identity)], (o: LinkedMethod) => o.identity);
      ProofLib.DistinctByConcat(s.methods, [LinkedMethod(kind, identity)], (o: LinkedMethod) => o.kind);
    }
  }
}

lemma mutationUnanswered_ensures(s: AccountMethods, reviewId: int, kind: MethodKind, applied: bool)
  ensures (inv(s) ==> canMutationUnanswered(s, reviewId, kind, applied) ==> alwaysAtLeastOneMethod(mutationUnanswered(s, reviewId, kind, applied).state))
  ensures (inv(s) ==> canMutationUnanswered(s, reviewId, kind, applied) ==> alwaysIdentitiesUnique(mutationUnanswered(s, reviewId, kind, applied).state))
  ensures (inv(s) ==> canMutationUnanswered(s, reviewId, kind, applied) ==> alwaysUnknownOutcomeBlocksMutation(mutationUnanswered(s, reviewId, kind, applied).state))
  ensures (inv(s) ==> canMutationUnanswered(s, reviewId, kind, applied) ==> stepMutationNeedsFreshReview(s, "mutationUnanswered", mutationUnanswered(s, reviewId, kind, applied).state))
  ensures (inv(s) ==> canMutationUnanswered(s, reviewId, kind, applied) ==> stepCollisionChangesNothing(s, mutationUnanswered(s, reviewId, kind, applied).state))
  ensures (inv(s) ==> canMutationUnanswered(s, reviewId, kind, applied) ==> stepUnprovenLinkChangesNothing(s, mutationUnanswered(s, reviewId, kind, applied).state))
  ensures (inv(s) ==> canMutationUnanswered(s, reviewId, kind, applied) ==> stepTenantAuthorityChangesNothing(s, mutationUnanswered(s, reviewId, kind, applied).state))
  ensures (inv(s) ==> canMutationUnanswered(s, reviewId, kind, applied) ==> stepMethodChangeIsAudited(s, mutationUnanswered(s, reviewId, kind, applied).state, mutationUnanswered(s, reviewId, kind, applied).out))
{
  if inv(s) && canMutationUnanswered(s, reviewId, kind, applied) {
    var after := s.(methods := (if applied then ProofLib.Filter((m: LinkedMethod) => (m.kind != kind), s.methods) else s.methods), attemptOpen := false, mustReread := true, result := MutationResult.OutcomeUnknown);
    Audited(s, after);
    if applied {
      DropKind(s, kind, after);
    }
  }
}

lemma initialHolds_ensures()
  ensures inv(initialHolds())
{
  MethodsBridge(initial);
}
