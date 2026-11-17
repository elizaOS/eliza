lemma KeyCountsDistinct<T, K>(xs: seq<T>, key: T -> K, p: T -> (T -> bool))
  requires forall a, b :: p(a)(b) == (key(b) == key(a))
  ensures (forall x :: x in xs ==> |ProofLib.Filter(p(x), xs)| == 1) <==> ProofLib.DistinctBy(xs, key)
{
  forall i | 0 <= i < |xs|
    ensures |ProofLib.Filter(p(xs[i]), xs)| == 1 <==> forall j :: 0 <= j < |xs| && j != i ==> key(xs[j]) != key(xs[i])
  {
    ProofLib.FilterCountOneIffUnique(p(xs[i]), xs, key, i);
  }
  if ProofLib.DistinctBy(xs, key) {
    forall x | x in xs
      ensures |ProofLib.Filter(p(x), xs)| == 1
    {
      var i :| 0 <= i < |xs| && xs[i] == x;
    }
  } else {
    var i, j :| 0 <= i < |xs| && 0 <= j < |xs| && i != j && key(xs[i]) == key(xs[j]);
    assert xs[i] in xs;
  }
}

lemma AppendDistinct<T, K>(xs: seq<T>, x: T, key: T -> K)
  requires ProofLib.DistinctBy(xs, key)
  requires forall i :: 0 <= i < |xs| ==> key(xs[i]) != key(x)
  ensures ProofLib.DistinctBy(xs + [x], key)
{
  ProofLib.DistinctByConcat(xs, [x], key);
}

lemma UsersFacts(s: PlatformUsers)
  ensures alwaysOneIdentityPerUser(s) == (ProofLib.DistinctBy(s.users, (u: PlatformUser) => u.cloudUser) &&
    ProofLib.DistinctBy(s.users, (u: PlatformUser) => u.identityUser) && forall u :: u in s.users ==> 1 <= u.identityUser < s.nextIdentity)
  ensures alwaysOneTenantPerOrganization(s) == (ProofLib.DistinctBy(s.tenants, (t: OrganizationTenant) => t.organization) &&
    ProofLib.DistinctBy(s.tenants, (t: OrganizationTenant) => t.tenant) && (forall t :: t in s.tenants ==> 1 <= t.tenant < s.nextTenant) &&
    forall u :: u in s.users ==> exists t :: t in s.tenants && t.organization == u.organization)
  ensures alwaysSubjectHasOneOwner(s) == ProofLib.DistinctBy(s.subjects, (l: SubjectLink) => l.subject)
{
  KeyCountsDistinct(s.users, (u: PlatformUser) => u.cloudUser, (u: PlatformUser) => (o: PlatformUser) => (o.cloudUser == u.cloudUser));
  KeyCountsDistinct(s.users, (u: PlatformUser) => u.identityUser, (u: PlatformUser) => (o: PlatformUser) => (o.identityUser == u.identityUser));
  KeyCountsDistinct(s.tenants, (t: OrganizationTenant) => t.organization, (t: OrganizationTenant) => (o: OrganizationTenant) => (o.organization == t.organization));
  KeyCountsDistinct(s.tenants, (t: OrganizationTenant) => t.tenant, (t: OrganizationTenant) => (o: OrganizationTenant) => (o.tenant == t.tenant));
  KeyCountsDistinct(s.subjects, (l: SubjectLink) => l.subject, (l: SubjectLink) => (o: SubjectLink) => (o.subject == l.subject));
}

lemma UserOfAll(s: PlatformUsers, c: int)
  requires ProofLib.DistinctBy(s.users, (u: PlatformUser) => u.cloudUser)
  ensures forall i :: 0 <= i < |s.users| && s.users[i].cloudUser == c ==> userOf(s, c) == s.users[i]
  ensures userOf(s, c) in s.users || userOf(s, c) == PlatformUser(0, 0, 0, IdentityPhase.IdentityDeleted, false, false, false)
  ensures (exists u :: u in s.users && u.cloudUser == c) ==> userOf(s, c) in s.users
{
  var p := (u: PlatformUser) => (u.cloudUser == c);
  var f := ProofLib.Filter(p, s.users);
  if |f| > 0 {
    assert f[0] in f;
    ProofLib.FilterMember(p, s.users, f[0]);
    var j :| 0 <= j < |s.users| && s.users[j] == f[0];
  } else if exists u :: u in s.users && u.cloudUser == c {
    var u :| u in s.users && u.cloudUser == c;
    ProofLib.FilterMember(p, s.users, u);
  }
}

lemma UpdateKeeps(s: PlatformUsers, c: int, change: PlatformUser, t: PlatformUsers)
  requires alwaysOneIdentityPerUser(s) && alwaysOneTenantPerOrganization(s) && alwaysSubjectHasOneOwner(s)
  requires userOf(s, c) in s.users
  requires change.cloudUser == c && change.identityUser == userOf(s, c).identityUser && change.organization == userOf(s, c).organization
  requires t == s.(users := updated(c, change, s), result := t.result)
  ensures alwaysOneIdentityPerUser(t) && alwaysOneTenantPerOrganization(t) && alwaysSubjectHasOneOwner(t)
  ensures forall v :: v in t.users ==> v == change || (v in s.users && v.cloudUser != c)
  ensures forall u :: u in s.users && u.cloudUser != c ==> u in t.users
  ensures change in t.users
{
  UsersFacts(s);
  UsersFacts(t);
  UserOfAll(s, c);
  var i :| 0 <= i < |s.users| && s.users[i] == userOf(s, c);
  assert t.users[i] == change;
  forall v | v in t.users
    ensures (v == change || (v in s.users && v.cloudUser != c)) && 1 <= v.identityUser < t.nextIdentity && exists x :: x in t.tenants && x.organization == v.organization
  {
    var j :| 0 <= j < |t.users| && t.users[j] == v;
    assert s.users[j] in s.users;
  }
  forall u | u in s.users && u.cloudUser != c
    ensures u in t.users
  {
    var j :| 0 <= j < |s.users| && s.users[j] == u;
    assert t.users[j] == u;
  }
}

lemma provision_ensures(s: PlatformUsers, cloudUser: int, organization: int)
  ensures (inv(s) ==> canProvision(s, cloudUser, organization) ==> alwaysOneIdentityPerUser(provision(s, cloudUser, organization)))
  ensures (inv(s) ==> canProvision(s, cloudUser, organization) ==> alwaysOneTenantPerOrganization(provision(s, cloudUser, organization)))
  ensures (inv(s) ==> canProvision(s, cloudUser, organization) ==> alwaysNumberingStartsAtOne(provision(s, cloudUser, organization)))
  ensures (inv(s) ==> canProvision(s, cloudUser, organization) ==> alwaysSubjectHasOneOwner(provision(s, cloudUser, organization)))
  ensures (inv(s) ==> canProvision(s, cloudUser, organization) ==> alwaysDeletionFollowsDeactivation(provision(s, cloudUser, organization)))
  ensures (inv(s) ==> canProvision(s, cloudUser, organization) ==> alwaysAmbiguousWaitsForReconcile(provision(s, cloudUser, organization)))
  ensures (inv(s) ==> canProvision(s, cloudUser, organization) ==> stepSubjectNeverMoves(s, provision(s, cloudUser, organization)))
  ensures (inv(s) ==> canProvision(s, cloudUser, organization) ==> stepCommittedDeletionIsFinal(s, provision(s, cloudUser, organization)))
{
  if inv(s) && canProvision(s, cloudUser, organization) && !mapped(s, cloudUser) {
    var after := provision(s, cloudUser, organization);
    var newUser := PlatformUser(cloudUser, s.nextIdentity, organization, IdentityPhase.Provisioned, false, false, false);
    var hasTenant := exists t :: t in s.tenants && (t.organization == organization);
    UsersFacts(s);
    UsersFacts(after);
    assert after.users == s.users + [newUser];
    forall i | 0 <= i < |s.users|
      ensures s.users[i].cloudUser != cloudUser && s.users[i].identityUser < s.nextIdentity
    {
      assert s.users[i] in s.users;
    }
    AppendDistinct(s.users, newUser, (u: PlatformUser) => u.cloudUser);
    AppendDistinct(s.users, newUser, (u: PlatformUser) => u.identityUser);
    var tenant := OrganizationTenant(organization, s.nextTenant);
    assert after.tenants == (if hasTenant then s.tenants else s.tenants + [tenant]);
    assert after.nextTenant == (if hasTenant then s.nextTenant else s.nextTenant + 1);
    if !hasTenant {
      forall i | 0 <= i < |s.tenants|
        ensures s.tenants[i].organization != organization && s.tenants[i].tenant < s.nextTenant
      {
        assert s.tenants[i] in s.tenants;
      }
      AppendDistinct(s.tenants, tenant, (t: OrganizationTenant) => t.organization);
      AppendDistinct(s.tenants, tenant, (t: OrganizationTenant) => t.tenant);
    }
    forall t | t in after.tenants
      ensures 1 <= t.tenant < after.nextTenant
    {
      if t != tenant {
        assert t in s.tenants;
      }
    }
    forall v | v in after.users
      ensures 1 <= v.identityUser < after.nextIdentity
    {
      if v != newUser {
        assert v in s.users;
      }
    }
    forall v | v in after.users
      ensures exists x :: x in after.tenants && x.organization == v.organization
    {
      if v != newUser {
        assert v in s.users;
        var x :| x in s.tenants && x.organization == v.organization;
        assert x in after.tenants;
      } else if hasTenant {
        var x :| x in s.tenants && x.organization == organization;
        assert x in after.tenants;
      } else {
        assert tenant in after.tenants;
      }
    }
  }
}

lemma linkSubject_ensures(s: PlatformUsers, cloudUser: int, subject: int, proof: LinkProof)
  ensures (inv(s) ==> canLinkSubject(s, cloudUser, subject, proof) ==> alwaysOneIdentityPerUser(linkSubject(s, cloudUser, subject, proof)))
  ensures (inv(s) ==> canLinkSubject(s, cloudUser, subject, proof) ==> alwaysOneTenantPerOrganization(linkSubject(s, cloudUser, subject, proof)))
  ensures (inv(s) ==> canLinkSubject(s, cloudUser, subject, proof) ==> alwaysNumberingStartsAtOne(linkSubject(s, cloudUser, subject, proof)))
  ensures (inv(s) ==> canLinkSubject(s, cloudUser, subject, proof) ==> alwaysSubjectHasOneOwner(linkSubject(s, cloudUser, subject, proof)))
  ensures (inv(s) ==> canLinkSubject(s, cloudUser, subject, proof) ==> alwaysDeletionFollowsDeactivation(linkSubject(s, cloudUser, subject, proof)))
  ensures (inv(s) ==> canLinkSubject(s, cloudUser, subject, proof) ==> alwaysAmbiguousWaitsForReconcile(linkSubject(s, cloudUser, subject, proof)))
  ensures (inv(s) ==> canLinkSubject(s, cloudUser, subject, proof) ==> stepSubjectNeverMoves(s, linkSubject(s, cloudUser, subject, proof)))
  ensures (inv(s) ==> canLinkSubject(s, cloudUser, subject, proof) ==> stepCommittedDeletionIsFinal(s, linkSubject(s, cloudUser, subject, proof)))
{
  if inv(s) && canLinkSubject(s, cloudUser, subject, proof) {
    var after := linkSubject(s, cloudUser, subject, proof);
    UsersFacts(s);
    UsersFacts(after);
    if !(exists l :: l in s.subjects && (l.subject == subject)) {
      forall i | 0 <= i < |s.subjects|
        ensures s.subjects[i].subject != subject
      {
        assert s.subjects[i] in s.subjects;
      }
      AppendDistinct(s.subjects, SubjectLink(subject, cloudUser), (l: SubjectLink) => l.subject);
    }
  }
}

lemma deactivationAnswered_ensures(s: PlatformUsers, cloudUser: int)
  ensures (inv(s) ==> canDeactivationAnswered(s, cloudUser) ==> alwaysOneIdentityPerUser(deactivationAnswered(s, cloudUser)))
  ensures (inv(s) ==> canDeactivationAnswered(s, cloudUser) ==> alwaysOneTenantPerOrganization(deactivationAnswered(s, cloudUser)))
  ensures (inv(s) ==> canDeactivationAnswered(s, cloudUser) ==> alwaysNumberingStartsAtOne(deactivationAnswered(s, cloudUser)))
  ensures (inv(s) ==> canDeactivationAnswered(s, cloudUser) ==> alwaysSubjectHasOneOwner(deactivationAnswered(s, cloudUser)))
  ensures (inv(s) ==> canDeactivationAnswered(s, cloudUser) ==> alwaysDeletionFollowsDeactivation(deactivationAnswered(s, cloudUser)))
  ensures (inv(s) ==> canDeactivationAnswered(s, cloudUser) ==> alwaysAmbiguousWaitsForReconcile(deactivationAnswered(s, cloudUser)))
  ensures (inv(s) ==> canDeactivationAnswered(s, cloudUser) ==> stepSubjectNeverMoves(s, deactivationAnswered(s, cloudUser)))
  ensures (inv(s) ==> canDeactivationAnswered(s, cloudUser) ==> stepCommittedDeletionIsFinal(s, deactivationAnswered(s, cloudUser)))
{
  if inv(s) && canDeactivationAnswered(s, cloudUser) {
    var after := deactivationAnswered(s, cloudUser);
    var u := userOf(s, cloudUser);
    UsersFacts(s);
    UserOfAll(s, cloudUser);
    UpdateKeeps(s, cloudUser, u.(phase := IdentityPhase.Deactivated, requestOpen := false, deactivatedOnce := true), after);
  }
}

lemma commitDeletion_ensures(s: PlatformUsers, cloudUser: int)
  ensures (inv(s) ==> canCommitDeletion(s, cloudUser) ==> alwaysOneIdentityPerUser(commitDeletion(s, cloudUser)))
  ensures (inv(s) ==> canCommitDeletion(s, cloudUser) ==> alwaysOneTenantPerOrganization(commitDeletion(s, cloudUser)))
  ensures (inv(s) ==> canCommitDeletion(s, cloudUser) ==> alwaysNumberingStartsAtOne(commitDeletion(s, cloudUser)))
  ensures (inv(s) ==> canCommitDeletion(s, cloudUser) ==> alwaysSubjectHasOneOwner(commitDeletion(s, cloudUser)))
  ensures (inv(s) ==> canCommitDeletion(s, cloudUser) ==> alwaysDeletionFollowsDeactivation(commitDeletion(s, cloudUser)))
  ensures (inv(s) ==> canCommitDeletion(s, cloudUser) ==> alwaysAmbiguousWaitsForReconcile(commitDeletion(s, cloudUser)))
  ensures (inv(s) ==> canCommitDeletion(s, cloudUser) ==> stepSubjectNeverMoves(s, commitDeletion(s, cloudUser)))
  ensures (inv(s) ==> canCommitDeletion(s, cloudUser) ==> stepCommittedDeletionIsFinal(s, commitDeletion(s, cloudUser)))
{
  if inv(s) && canCommitDeletion(s, cloudUser) {
    var after := commitDeletion(s, cloudUser);
    var u := userOf(s, cloudUser);
    UsersFacts(s);
    UserOfAll(s, cloudUser);
    UpdateKeeps(s, cloudUser, u.(phase := IdentityPhase.DeletionCommitted), after);
  }
}

lemma finishDeletion_ensures(s: PlatformUsers, cloudUser: int)
  ensures (inv(s) ==> canFinishDeletion(s, cloudUser) ==> alwaysOneIdentityPerUser(finishDeletion(s, cloudUser)))
  ensures (inv(s) ==> canFinishDeletion(s, cloudUser) ==> alwaysOneTenantPerOrganization(finishDeletion(s, cloudUser)))
  ensures (inv(s) ==> canFinishDeletion(s, cloudUser) ==> alwaysNumberingStartsAtOne(finishDeletion(s, cloudUser)))
  ensures (inv(s) ==> canFinishDeletion(s, cloudUser) ==> alwaysSubjectHasOneOwner(finishDeletion(s, cloudUser)))
  ensures (inv(s) ==> canFinishDeletion(s, cloudUser) ==> alwaysDeletionFollowsDeactivation(finishDeletion(s, cloudUser)))
  ensures (inv(s) ==> canFinishDeletion(s, cloudUser) ==> alwaysAmbiguousWaitsForReconcile(finishDeletion(s, cloudUser)))
  ensures (inv(s) ==> canFinishDeletion(s, cloudUser) ==> stepSubjectNeverMoves(s, finishDeletion(s, cloudUser)))
  ensures (inv(s) ==> canFinishDeletion(s, cloudUser) ==> stepCommittedDeletionIsFinal(s, finishDeletion(s, cloudUser)))
{
  if inv(s) && canFinishDeletion(s, cloudUser) {
    var after := finishDeletion(s, cloudUser);
    var u := userOf(s, cloudUser);
    UsersFacts(s);
    UserOfAll(s, cloudUser);
    UpdateKeeps(s, cloudUser, u.(phase := IdentityPhase.IdentityDeleted), after);
  }
}

lemma beginDeactivation_ensures(s: PlatformUsers, cloudUser: int)
  ensures (inv(s) ==> canBeginDeactivation(s, cloudUser) ==> alwaysOneIdentityPerUser(beginDeactivation(s, cloudUser)))
  ensures (inv(s) ==> canBeginDeactivation(s, cloudUser) ==> alwaysOneTenantPerOrganization(beginDeactivation(s, cloudUser)))
  ensures (inv(s) ==> canBeginDeactivation(s, cloudUser) ==> alwaysNumberingStartsAtOne(beginDeactivation(s, cloudUser)))
  ensures (inv(s) ==> canBeginDeactivation(s, cloudUser) ==> alwaysSubjectHasOneOwner(beginDeactivation(s, cloudUser)))
  ensures (inv(s) ==> canBeginDeactivation(s, cloudUser) ==> alwaysDeletionFollowsDeactivation(beginDeactivation(s, cloudUser)))
  ensures (inv(s) ==> canBeginDeactivation(s, cloudUser) ==> alwaysAmbiguousWaitsForReconcile(beginDeactivation(s, cloudUser)))
  ensures (inv(s) ==> canBeginDeactivation(s, cloudUser) ==> stepSubjectNeverMoves(s, beginDeactivation(s, cloudUser)))
  ensures (inv(s) ==> canBeginDeactivation(s, cloudUser) ==> stepCommittedDeletionIsFinal(s, beginDeactivation(s, cloudUser)))
{
  if inv(s) && canBeginDeactivation(s, cloudUser) {
    var after := beginDeactivation(s, cloudUser);
    var u := userOf(s, cloudUser);
    UsersFacts(s);
    UserOfAll(s, cloudUser);
    if u.phase.Provisioned? {
      UpdateKeeps(s, cloudUser, u.(phase := IdentityPhase.Deactivating, requestOpen := true), after);
    }
  }
}

lemma reactivate_ensures(s: PlatformUsers, cloudUser: int)
  ensures (inv(s) ==> canReactivate(s, cloudUser) ==> alwaysOneIdentityPerUser(reactivate(s, cloudUser)))
  ensures (inv(s) ==> canReactivate(s, cloudUser) ==> alwaysOneTenantPerOrganization(reactivate(s, cloudUser)))
  ensures (inv(s) ==> canReactivate(s, cloudUser) ==> alwaysNumberingStartsAtOne(reactivate(s, cloudUser)))
  ensures (inv(s) ==> canReactivate(s, cloudUser) ==> alwaysSubjectHasOneOwner(reactivate(s, cloudUser)))
  ensures (inv(s) ==> canReactivate(s, cloudUser) ==> alwaysDeletionFollowsDeactivation(reactivate(s, cloudUser)))
  ensures (inv(s) ==> canReactivate(s, cloudUser) ==> alwaysAmbiguousWaitsForReconcile(reactivate(s, cloudUser)))
  ensures (inv(s) ==> canReactivate(s, cloudUser) ==> stepSubjectNeverMoves(s, reactivate(s, cloudUser)))
  ensures (inv(s) ==> canReactivate(s, cloudUser) ==> stepCommittedDeletionIsFinal(s, reactivate(s, cloudUser)))
{
  if inv(s) && canReactivate(s, cloudUser) {
    var after := reactivate(s, cloudUser);
    var u := userOf(s, cloudUser);
    UsersFacts(s);
    UserOfAll(s, cloudUser);
    if u.phase.Deactivated? {
      UpdateKeeps(s, cloudUser, u.(phase := IdentityPhase.Provisioned), after);
    }
  }
}

lemma deactivationLost_ensures(s: PlatformUsers, cloudUser: int)
  ensures (inv(s) ==> canDeactivationLost(s, cloudUser) ==> alwaysOneIdentityPerUser(deactivationLost(s, cloudUser)))
  ensures (inv(s) ==> canDeactivationLost(s, cloudUser) ==> alwaysOneTenantPerOrganization(deactivationLost(s, cloudUser)))
  ensures (inv(s) ==> canDeactivationLost(s, cloudUser) ==> alwaysNumberingStartsAtOne(deactivationLost(s, cloudUser)))
  ensures (inv(s) ==> canDeactivationLost(s, cloudUser) ==> alwaysSubjectHasOneOwner(deactivationLost(s, cloudUser)))
  ensures (inv(s) ==> canDeactivationLost(s, cloudUser) ==> alwaysDeletionFollowsDeactivation(deactivationLost(s, cloudUser)))
  ensures (inv(s) ==> canDeactivationLost(s, cloudUser) ==> alwaysAmbiguousWaitsForReconcile(deactivationLost(s, cloudUser)))
  ensures (inv(s) ==> canDeactivationLost(s, cloudUser) ==> stepSubjectNeverMoves(s, deactivationLost(s, cloudUser)))
  ensures (inv(s) ==> canDeactivationLost(s, cloudUser) ==> stepCommittedDeletionIsFinal(s, deactivationLost(s, cloudUser)))
{
  if inv(s) && canDeactivationLost(s, cloudUser) {
    var after := deactivationLost(s, cloudUser);
    var u := userOf(s, cloudUser);
    UsersFacts(s);
    UserOfAll(s, cloudUser);
    UpdateKeeps(s, cloudUser, u.(requestOpen := false, ambiguous := true), after);
  }
}

lemma reconcile_ensures(s: PlatformUsers, cloudUser: int, observedDeactivated: bool)
  ensures (inv(s) ==> canReconcile(s, cloudUser, observedDeactivated) ==> alwaysOneIdentityPerUser(reconcile(s, cloudUser, observedDeactivated)))
  ensures (inv(s) ==> canReconcile(s, cloudUser, observedDeactivated) ==> alwaysOneTenantPerOrganization(reconcile(s, cloudUser, observedDeactivated)))
  ensures (inv(s) ==> canReconcile(s, cloudUser, observedDeactivated) ==> alwaysNumberingStartsAtOne(reconcile(s, cloudUser, observedDeactivated)))
  ensures (inv(s) ==> canReconcile(s, cloudUser, observedDeactivated) ==> alwaysSubjectHasOneOwner(reconcile(s, cloudUser, observedDeactivated)))
  ensures (inv(s) ==> canReconcile(s, cloudUser, observedDeactivated) ==> alwaysDeletionFollowsDeactivation(reconcile(s, cloudUser, observedDeactivated)))
  ensures (inv(s) ==> canReconcile(s, cloudUser, observedDeactivated) ==> alwaysAmbiguousWaitsForReconcile(reconcile(s, cloudUser, observedDeactivated)))
  ensures (inv(s) ==> canReconcile(s, cloudUser, observedDeactivated) ==> stepSubjectNeverMoves(s, reconcile(s, cloudUser, observedDeactivated)))
  ensures (inv(s) ==> canReconcile(s, cloudUser, observedDeactivated) ==> stepCommittedDeletionIsFinal(s, reconcile(s, cloudUser, observedDeactivated)))
{
  if inv(s) && canReconcile(s, cloudUser, observedDeactivated) {
    var after := reconcile(s, cloudUser, observedDeactivated);
    var u := userOf(s, cloudUser);
    UsersFacts(s);
    UserOfAll(s, cloudUser);
    UpdateKeeps(s, cloudUser, (if observedDeactivated then u.(phase := IdentityPhase.Deactivated, ambiguous := false, deactivatedOnce := true) else u.(ambiguous := false, requestOpen := true)), after);
  }
}
