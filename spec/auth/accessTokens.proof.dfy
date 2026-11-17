lemma admit_ensures(s: AccessTokens, process: int, root: int)
  ensures (inv(s) ==> canAdmit(s, process, root) ==> alwaysQueuesKeepArrivalOrder(admit(s, process, root)))
  ensures (inv(s) ==> canAdmit(s, process, root) ==> alwaysOneRefreshPerAccountKey(admit(s, process, root)))
  ensures (inv(s) ==> canAdmit(s, process, root) ==> alwaysRequestsNumberedOnce(admit(s, process, root)))
  ensures (inv(s) ==> canAdmit(s, process, root) ==> alwaysQueuesHoldTheirOwnRequests(admit(s, process, root)))
  ensures (inv(s) ==> canAdmit(s, process, root) ==> alwaysTokenMatchesOutcome(admit(s, process, root)))
  ensures (inv(s) ==> canAdmit(s, process, root) ==> alwaysExplicitPolicyBeforeGrant(admit(s, process, root)))
  ensures (inv(s) ==> canAdmit(s, process, root) ==> alwaysTransientFailureKeepsCapturedGeneration(admit(s, process, root)))
  ensures (inv(s) ==> canAdmit(s, process, root) ==> alwaysRefreshedRequiresPublication(admit(s, process, root)))
  ensures (inv(s) ==> canAdmit(s, process, root) ==> alwaysRotatedGrantIsRetained(admit(s, process, root)))
  ensures (inv(s) ==> canAdmit(s, process, root) ==> alwaysSettlesBeforeOutcomeOrPublication(admit(s, process, root)))
  ensures (inv(s) ==> canAdmit(s, process, root) ==> alwaysCommitCarriesToken(admit(s, process, root)))
  ensures (inv(s) ==> canAdmit(s, process, root) ==> alwaysCommittedGenerationsBelowNext(admit(s, process, root)))
  ensures (inv(s) ==> canAdmit(s, process, root) ==> alwaysOneCredentialPerAccount(admit(s, process, root)))
  ensures (inv(s) ==> canAdmit(s, process, root) ==> stepFailureDoesNotPublish(s, "admit", admit(s, process, root)))
  ensures (inv(s) ==> canAdmit(s, process, root) ==> stepRemovedAccountNotResurrected(s, "admit", admit(s, process, root)))
  ensures (inv(s) ==> canAdmit(s, process, root) ==> stepStaleResponseCannotReplace(s, "admit", admit(s, process, root)))
  ensures (inv(s) ==> canAdmit(s, process, root) ==> stepStalePolicyCommitFails(s, "admit", admit(s, process, root)))
{
  if inv(s) && canAdmit(s, process, root) {
    AdmitFacts(s, process, root);
    var h := queueOf(s, process, root).waiting[0];
    var r := requestOf(s, h);
    var rec := recordOf(s, r.root);
    var reread := r.(observedGeneration := rec.generation);
    var s2 := s.(requests := withRequest(h, reread, s));
    WithRequestAt(h, reread, s);
    CredentialsIff(s);
    RecordIndex(s, r.root);
    if !policyValid(s, r) {
      FinishActive(s, s2, r, reread, ResolutionOutcome.StorageError, 0, 0, 0);
    } else if !present(s, r.root) {
      FinishActive(s, s2, r, reread, ResolutionOutcome.NeedsAuth, 0, 0, 0);
    } else if usable(rec.expires, s.now, r.buffer) {
      assert rec in s.records;
      FinishActive(s, s2, r, reread, ResolutionOutcome.TokenOk, rec.token, rec.generation, rec.expires);
    } else if r.policy.NoPolicy? {
      FinishActive(s, s2, r, reread, ResolutionOutcome.PolicyError, 0, 0, 0);
    } else {
      var c := reread.(phase := ResolutionPhase.AtProvider, issuedGrant := rec.grant);
      var t := admit(s, process, root);
      WithRequestAt(h, c, s2);
      AdmitQueues(s, t, r, c);
      PerRequest(s, t, c);
    }
  }
}

lemma changeAccount_ensures(s: AccessTokens, root: int, change: AccountChange)
  ensures (inv(s) ==> canChangeAccount(s, root, change) ==> alwaysQueuesKeepArrivalOrder(changeAccount(s, root, change)))
  ensures (inv(s) ==> canChangeAccount(s, root, change) ==> alwaysOneRefreshPerAccountKey(changeAccount(s, root, change)))
  ensures (inv(s) ==> canChangeAccount(s, root, change) ==> alwaysRequestsNumberedOnce(changeAccount(s, root, change)))
  ensures (inv(s) ==> canChangeAccount(s, root, change) ==> alwaysQueuesHoldTheirOwnRequests(changeAccount(s, root, change)))
  ensures (inv(s) ==> canChangeAccount(s, root, change) ==> alwaysTokenMatchesOutcome(changeAccount(s, root, change)))
  ensures (inv(s) ==> canChangeAccount(s, root, change) ==> alwaysExplicitPolicyBeforeGrant(changeAccount(s, root, change)))
  ensures (inv(s) ==> canChangeAccount(s, root, change) ==> alwaysTransientFailureKeepsCapturedGeneration(changeAccount(s, root, change)))
  ensures (inv(s) ==> canChangeAccount(s, root, change) ==> alwaysRefreshedRequiresPublication(changeAccount(s, root, change)))
  ensures (inv(s) ==> canChangeAccount(s, root, change) ==> alwaysRotatedGrantIsRetained(changeAccount(s, root, change)))
  ensures (inv(s) ==> canChangeAccount(s, root, change) ==> alwaysSettlesBeforeOutcomeOrPublication(changeAccount(s, root, change)))
  ensures (inv(s) ==> canChangeAccount(s, root, change) ==> alwaysCommitCarriesToken(changeAccount(s, root, change)))
  ensures (inv(s) ==> canChangeAccount(s, root, change) ==> alwaysCommittedGenerationsBelowNext(changeAccount(s, root, change)))
  ensures (inv(s) ==> canChangeAccount(s, root, change) ==> alwaysOneCredentialPerAccount(changeAccount(s, root, change)))
  ensures (inv(s) ==> canChangeAccount(s, root, change) ==> stepFailureDoesNotPublish(s, "changeAccount", changeAccount(s, root, change)))
  ensures (inv(s) ==> canChangeAccount(s, root, change) ==> stepRemovedAccountNotResurrected(s, "changeAccount", changeAccount(s, root, change)))
  ensures (inv(s) ==> canChangeAccount(s, root, change) ==> stepStaleResponseCannotReplace(s, "changeAccount", changeAccount(s, root, change)))
  ensures (inv(s) ==> canChangeAccount(s, root, change) ==> stepStalePolicyCommitFails(s, "changeAccount", changeAccount(s, root, change)))
{
  if inv(s) && canChangeAccount(s, root, change) {
    var t := changeAccount(s, root, change);
    CredentialsIff(s);
    CredentialsIff(t);
    if change.ReplaceAccount? {
      if present(s, root) {
        assert |t.records| == |s.records| && forall i :: 0 <= i < |s.records| ==> t.records[i] == (if s.records[i].root == root then s.records[i].(generation := s.nextGeneration, token := 5, grant := 5, expires := (s.now + 5)) else s.records[i]);
        forall x: TokenRecord | x.root != root ensures x in t.records <==> x in s.records {
          if x in t.records {
            var i :| 0 <= i < |t.records| && t.records[i] == x;
          }
          if x in s.records {
            var i :| 0 <= i < |s.records| && s.records[i] == x;
          }
        }
      } else {
        ProofLib.DistinctByConcat(s.records, [TokenRecord(root, s.nextGeneration, 5, 5, (s.now + 5), true)], (x: TokenRecord) => x.root);
      }
      assert ProofLib.DistinctBy(t.records, (x: TokenRecord) => x.root);
      RecordIndex(t, root);
    } else {
      var p := (x: TokenRecord) => (x.root != root);
      ProofLib.FilterKeepsDistinctBy(p, s.records, (x: TokenRecord) => x.root);
      forall x: TokenRecord ensures x in t.records <==> x in s.records && x.root != root {
        ProofLib.FilterMember(p, s.records, x);
      }
    }
    OtherRecords(s, t, root);
  }
}

lemma commit_ensures(s: AccessTokens, process: int, root: int)
  ensures (inv(s) ==> canCommit(s, process, root) ==> alwaysQueuesKeepArrivalOrder(commit(s, process, root)))
  ensures (inv(s) ==> canCommit(s, process, root) ==> alwaysOneRefreshPerAccountKey(commit(s, process, root)))
  ensures (inv(s) ==> canCommit(s, process, root) ==> alwaysRequestsNumberedOnce(commit(s, process, root)))
  ensures (inv(s) ==> canCommit(s, process, root) ==> alwaysQueuesHoldTheirOwnRequests(commit(s, process, root)))
  ensures (inv(s) ==> canCommit(s, process, root) ==> alwaysTokenMatchesOutcome(commit(s, process, root)))
  ensures (inv(s) ==> canCommit(s, process, root) ==> alwaysExplicitPolicyBeforeGrant(commit(s, process, root)))
  ensures (inv(s) ==> canCommit(s, process, root) ==> alwaysTransientFailureKeepsCapturedGeneration(commit(s, process, root)))
  ensures (inv(s) ==> canCommit(s, process, root) ==> alwaysRefreshedRequiresPublication(commit(s, process, root)))
  ensures (inv(s) ==> canCommit(s, process, root) ==> alwaysRotatedGrantIsRetained(commit(s, process, root)))
  ensures (inv(s) ==> canCommit(s, process, root) ==> alwaysSettlesBeforeOutcomeOrPublication(commit(s, process, root)))
  ensures (inv(s) ==> canCommit(s, process, root) ==> alwaysCommitCarriesToken(commit(s, process, root)))
  ensures (inv(s) ==> canCommit(s, process, root) ==> alwaysCommittedGenerationsBelowNext(commit(s, process, root)))
  ensures (inv(s) ==> canCommit(s, process, root) ==> alwaysOneCredentialPerAccount(commit(s, process, root)))
  ensures (inv(s) ==> canCommit(s, process, root) ==> stepFailureDoesNotPublish(s, "commit", commit(s, process, root)))
  ensures (inv(s) ==> canCommit(s, process, root) ==> stepRemovedAccountNotResurrected(s, "commit", commit(s, process, root)))
  ensures (inv(s) ==> canCommit(s, process, root) ==> stepStaleResponseCannotReplace(s, "commit", commit(s, process, root)))
  ensures (inv(s) ==> canCommit(s, process, root) ==> stepStalePolicyCommitFails(s, "commit", commit(s, process, root)))
{
  if inv(s) && canCommit(s, process, root) {
    var r := activeOf(s, process, root);
    ActiveFacts(s, process, root);
    NumberedIff(s);
    CredentialsIff(s);
    RecordIndex(s, r.root);
    var latest := recordOf(s, r.root);
    if !policyValid(s, r) {
      FinishActive(s, s, r, r, ResolutionOutcome.StorageError, 0, 0, 0);
      StalePolicyOk(s, commit(s, process, root), r);
    } else if !present(s, r.root) {
      FinishActive(s, s, r, r, ResolutionOutcome.NeedsAuth, 0, r.observedGeneration, 0);
      StalePolicyOk(s, commit(s, process, root), r);
    } else if latest.generation != r.observedGeneration {
      assert latest in s.records;
      FinishActive(s, s, r, r, (if usable(latest.expires, s.now, r.buffer) then ResolutionOutcome.TokenOk else (if (latest.expires > s.now) then ResolutionOutcome.Insufficient else ResolutionOutcome.NeedsAuth)), latest.token, latest.generation, latest.expires);
      StalePolicyOk(s, commit(s, process, root), r);
    } else {
      var renewed := latest.(generation := s.nextGeneration, token := r.responseToken, grant := r.responseGrant, expires := (s.now + r.responseLifetime));
      var ok := usable(renewed.expires, s.now, r.buffer);
      var t := s.(records := (var s_map := s.records; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var x := s_map[i_map]; (if (x.root == r.root) then renewed else x))), nextGeneration := (s.nextGeneration + 1), requests := withRequest(r.id, r.(published := true, committedGeneration := renewed.generation), s));
      Publish(s, t, r, renewed, true, (if ok then ResolutionOutcome.TokenOk else ResolutionOutcome.Insufficient), renewed.token, renewed.generation, renewed.expires, ok);
      StalePolicyOk(s, commit(s, process, root), r);
    }
  }
}

lemma initialHolds_ensures()
  ensures inv(initialHolds())
{
  CredentialsIff(initial);
  assert ProofLib.DistinctBy(initial.records, (x: TokenRecord) => x.root);
}

lemma providerFails_ensures(s: AccessTokens, process: int, root: int, reason: ProviderFailure, consumed: bool)
  ensures (inv(s) ==> canProviderFails(s, process, root, reason, consumed) ==> alwaysQueuesKeepArrivalOrder(providerFails(s, process, root, reason, consumed)))
  ensures (inv(s) ==> canProviderFails(s, process, root, reason, consumed) ==> alwaysOneRefreshPerAccountKey(providerFails(s, process, root, reason, consumed)))
  ensures (inv(s) ==> canProviderFails(s, process, root, reason, consumed) ==> alwaysRequestsNumberedOnce(providerFails(s, process, root, reason, consumed)))
  ensures (inv(s) ==> canProviderFails(s, process, root, reason, consumed) ==> alwaysQueuesHoldTheirOwnRequests(providerFails(s, process, root, reason, consumed)))
  ensures (inv(s) ==> canProviderFails(s, process, root, reason, consumed) ==> alwaysTokenMatchesOutcome(providerFails(s, process, root, reason, consumed)))
  ensures (inv(s) ==> canProviderFails(s, process, root, reason, consumed) ==> alwaysExplicitPolicyBeforeGrant(providerFails(s, process, root, reason, consumed)))
  ensures (inv(s) ==> canProviderFails(s, process, root, reason, consumed) ==> alwaysTransientFailureKeepsCapturedGeneration(providerFails(s, process, root, reason, consumed)))
  ensures (inv(s) ==> canProviderFails(s, process, root, reason, consumed) ==> alwaysRefreshedRequiresPublication(providerFails(s, process, root, reason, consumed)))
  ensures (inv(s) ==> canProviderFails(s, process, root, reason, consumed) ==> alwaysRotatedGrantIsRetained(providerFails(s, process, root, reason, consumed)))
  ensures (inv(s) ==> canProviderFails(s, process, root, reason, consumed) ==> alwaysSettlesBeforeOutcomeOrPublication(providerFails(s, process, root, reason, consumed)))
  ensures (inv(s) ==> canProviderFails(s, process, root, reason, consumed) ==> alwaysCommitCarriesToken(providerFails(s, process, root, reason, consumed)))
  ensures (inv(s) ==> canProviderFails(s, process, root, reason, consumed) ==> alwaysCommittedGenerationsBelowNext(providerFails(s, process, root, reason, consumed)))
  ensures (inv(s) ==> canProviderFails(s, process, root, reason, consumed) ==> alwaysOneCredentialPerAccount(providerFails(s, process, root, reason, consumed)))
  ensures (inv(s) ==> canProviderFails(s, process, root, reason, consumed) ==> stepFailureDoesNotPublish(s, "providerFails", providerFails(s, process, root, reason, consumed)))
  ensures (inv(s) ==> canProviderFails(s, process, root, reason, consumed) ==> stepRemovedAccountNotResurrected(s, "providerFails", providerFails(s, process, root, reason, consumed)))
  ensures (inv(s) ==> canProviderFails(s, process, root, reason, consumed) ==> stepStaleResponseCannotReplace(s, "providerFails", providerFails(s, process, root, reason, consumed)))
  ensures (inv(s) ==> canProviderFails(s, process, root, reason, consumed) ==> stepStalePolicyCommitFails(s, "providerFails", providerFails(s, process, root, reason, consumed)))
{
  if inv(s) && canProviderFails(s, process, root, reason, consumed) {
    var r := activeOf(s, process, root);
    ActiveFacts(s, process, root);
    var t := s.(usedGrants := (if consumed then (s.usedGrants + Std.Collections.Seq.Filter((set_x: int) => !((set_x in s.usedGrants)), [r.issuedGrant])) else s.usedGrants));
    FinishActive(s, t, r, r, (if authFailure(reason) then ResolutionOutcome.NeedsAuth else ResolutionOutcome.Transient), 0, r.observedGeneration, 0);
  }
}

lemma providerSucceeds_ensures(s: AccessTokens, process: int, root: int, lifetime: int, rotate: bool)
  ensures (inv(s) ==> canProviderSucceeds(s, process, root, lifetime, rotate) ==> alwaysQueuesKeepArrivalOrder(providerSucceeds(s, process, root, lifetime, rotate)))
  ensures (inv(s) ==> canProviderSucceeds(s, process, root, lifetime, rotate) ==> alwaysOneRefreshPerAccountKey(providerSucceeds(s, process, root, lifetime, rotate)))
  ensures (inv(s) ==> canProviderSucceeds(s, process, root, lifetime, rotate) ==> alwaysRequestsNumberedOnce(providerSucceeds(s, process, root, lifetime, rotate)))
  ensures (inv(s) ==> canProviderSucceeds(s, process, root, lifetime, rotate) ==> alwaysQueuesHoldTheirOwnRequests(providerSucceeds(s, process, root, lifetime, rotate)))
  ensures (inv(s) ==> canProviderSucceeds(s, process, root, lifetime, rotate) ==> alwaysTokenMatchesOutcome(providerSucceeds(s, process, root, lifetime, rotate)))
  ensures (inv(s) ==> canProviderSucceeds(s, process, root, lifetime, rotate) ==> alwaysExplicitPolicyBeforeGrant(providerSucceeds(s, process, root, lifetime, rotate)))
  ensures (inv(s) ==> canProviderSucceeds(s, process, root, lifetime, rotate) ==> alwaysTransientFailureKeepsCapturedGeneration(providerSucceeds(s, process, root, lifetime, rotate)))
  ensures (inv(s) ==> canProviderSucceeds(s, process, root, lifetime, rotate) ==> alwaysRefreshedRequiresPublication(providerSucceeds(s, process, root, lifetime, rotate)))
  ensures (inv(s) ==> canProviderSucceeds(s, process, root, lifetime, rotate) ==> alwaysRotatedGrantIsRetained(providerSucceeds(s, process, root, lifetime, rotate)))
  ensures (inv(s) ==> canProviderSucceeds(s, process, root, lifetime, rotate) ==> alwaysSettlesBeforeOutcomeOrPublication(providerSucceeds(s, process, root, lifetime, rotate)))
  ensures (inv(s) ==> canProviderSucceeds(s, process, root, lifetime, rotate) ==> alwaysCommitCarriesToken(providerSucceeds(s, process, root, lifetime, rotate)))
  ensures (inv(s) ==> canProviderSucceeds(s, process, root, lifetime, rotate) ==> alwaysCommittedGenerationsBelowNext(providerSucceeds(s, process, root, lifetime, rotate)))
  ensures (inv(s) ==> canProviderSucceeds(s, process, root, lifetime, rotate) ==> alwaysOneCredentialPerAccount(providerSucceeds(s, process, root, lifetime, rotate)))
  ensures (inv(s) ==> canProviderSucceeds(s, process, root, lifetime, rotate) ==> stepFailureDoesNotPublish(s, "providerSucceeds", providerSucceeds(s, process, root, lifetime, rotate)))
  ensures (inv(s) ==> canProviderSucceeds(s, process, root, lifetime, rotate) ==> stepRemovedAccountNotResurrected(s, "providerSucceeds", providerSucceeds(s, process, root, lifetime, rotate)))
  ensures (inv(s) ==> canProviderSucceeds(s, process, root, lifetime, rotate) ==> stepStaleResponseCannotReplace(s, "providerSucceeds", providerSucceeds(s, process, root, lifetime, rotate)))
  ensures (inv(s) ==> canProviderSucceeds(s, process, root, lifetime, rotate) ==> stepStalePolicyCommitFails(s, "providerSucceeds", providerSucceeds(s, process, root, lifetime, rotate)))
{
  if inv(s) && canProviderSucceeds(s, process, root, lifetime, rotate) {
    var r := activeOf(s, process, root);
    ActiveFacts(s, process, root);
    NumberedIff(s);
    var c := r.(phase := ResolutionPhase.Committing, responseToken := (r.id + 10), responseGrant := (if rotate then (r.id + 10) else r.issuedGrant), responseLifetime := lifetime);
    var t := providerSucceeds(s, process, root, lifetime, rotate);
    WithRequestAt(r.id, c, s);
    QueuesBounded(s);
    RefreshIff(s);
    DequeueNone(s, 0);
    DequeueKeeps(s, t, 0);
    PerRequest(s, t, c);
  }
}

lemma providerTimesOut_ensures(s: AccessTokens, process: int, root: int)
  ensures (inv(s) ==> canProviderTimesOut(s, process, root) ==> alwaysQueuesKeepArrivalOrder(providerTimesOut(s, process, root)))
  ensures (inv(s) ==> canProviderTimesOut(s, process, root) ==> alwaysOneRefreshPerAccountKey(providerTimesOut(s, process, root)))
  ensures (inv(s) ==> canProviderTimesOut(s, process, root) ==> alwaysRequestsNumberedOnce(providerTimesOut(s, process, root)))
  ensures (inv(s) ==> canProviderTimesOut(s, process, root) ==> alwaysQueuesHoldTheirOwnRequests(providerTimesOut(s, process, root)))
  ensures (inv(s) ==> canProviderTimesOut(s, process, root) ==> alwaysTokenMatchesOutcome(providerTimesOut(s, process, root)))
  ensures (inv(s) ==> canProviderTimesOut(s, process, root) ==> alwaysExplicitPolicyBeforeGrant(providerTimesOut(s, process, root)))
  ensures (inv(s) ==> canProviderTimesOut(s, process, root) ==> alwaysTransientFailureKeepsCapturedGeneration(providerTimesOut(s, process, root)))
  ensures (inv(s) ==> canProviderTimesOut(s, process, root) ==> alwaysRefreshedRequiresPublication(providerTimesOut(s, process, root)))
  ensures (inv(s) ==> canProviderTimesOut(s, process, root) ==> alwaysRotatedGrantIsRetained(providerTimesOut(s, process, root)))
  ensures (inv(s) ==> canProviderTimesOut(s, process, root) ==> alwaysSettlesBeforeOutcomeOrPublication(providerTimesOut(s, process, root)))
  ensures (inv(s) ==> canProviderTimesOut(s, process, root) ==> alwaysCommitCarriesToken(providerTimesOut(s, process, root)))
  ensures (inv(s) ==> canProviderTimesOut(s, process, root) ==> alwaysCommittedGenerationsBelowNext(providerTimesOut(s, process, root)))
  ensures (inv(s) ==> canProviderTimesOut(s, process, root) ==> alwaysOneCredentialPerAccount(providerTimesOut(s, process, root)))
  ensures (inv(s) ==> canProviderTimesOut(s, process, root) ==> stepFailureDoesNotPublish(s, "providerTimesOut", providerTimesOut(s, process, root)))
  ensures (inv(s) ==> canProviderTimesOut(s, process, root) ==> stepRemovedAccountNotResurrected(s, "providerTimesOut", providerTimesOut(s, process, root)))
  ensures (inv(s) ==> canProviderTimesOut(s, process, root) ==> stepStaleResponseCannotReplace(s, "providerTimesOut", providerTimesOut(s, process, root)))
  ensures (inv(s) ==> canProviderTimesOut(s, process, root) ==> stepStalePolicyCommitFails(s, "providerTimesOut", providerTimesOut(s, process, root)))
{
  if inv(s) && canProviderTimesOut(s, process, root) {
    ActiveFacts(s, process, root);
    FinishActive(s, s, activeOf(s, process, root), activeOf(s, process, root), ResolutionOutcome.Transient, 0, activeOf(s, process, root).observedGeneration, 0);
  }
}

lemma requestToken_ensures(s: AccessTokens, root: int, process: int, policy: CapturedPolicy, buffer: int)
  ensures (inv(s) ==> canRequestToken(s, root, process, policy, buffer) ==> alwaysQueuesKeepArrivalOrder(requestToken(s, root, process, policy, buffer)))
  ensures (inv(s) ==> canRequestToken(s, root, process, policy, buffer) ==> alwaysOneRefreshPerAccountKey(requestToken(s, root, process, policy, buffer)))
  ensures (inv(s) ==> canRequestToken(s, root, process, policy, buffer) ==> alwaysRequestsNumberedOnce(requestToken(s, root, process, policy, buffer)))
  ensures (inv(s) ==> canRequestToken(s, root, process, policy, buffer) ==> alwaysQueuesHoldTheirOwnRequests(requestToken(s, root, process, policy, buffer)))
  ensures (inv(s) ==> canRequestToken(s, root, process, policy, buffer) ==> alwaysTokenMatchesOutcome(requestToken(s, root, process, policy, buffer)))
  ensures (inv(s) ==> canRequestToken(s, root, process, policy, buffer) ==> alwaysExplicitPolicyBeforeGrant(requestToken(s, root, process, policy, buffer)))
  ensures (inv(s) ==> canRequestToken(s, root, process, policy, buffer) ==> alwaysTransientFailureKeepsCapturedGeneration(requestToken(s, root, process, policy, buffer)))
  ensures (inv(s) ==> canRequestToken(s, root, process, policy, buffer) ==> alwaysRefreshedRequiresPublication(requestToken(s, root, process, policy, buffer)))
  ensures (inv(s) ==> canRequestToken(s, root, process, policy, buffer) ==> alwaysRotatedGrantIsRetained(requestToken(s, root, process, policy, buffer)))
  ensures (inv(s) ==> canRequestToken(s, root, process, policy, buffer) ==> alwaysSettlesBeforeOutcomeOrPublication(requestToken(s, root, process, policy, buffer)))
  ensures (inv(s) ==> canRequestToken(s, root, process, policy, buffer) ==> alwaysCommitCarriesToken(requestToken(s, root, process, policy, buffer)))
  ensures (inv(s) ==> canRequestToken(s, root, process, policy, buffer) ==> alwaysCommittedGenerationsBelowNext(requestToken(s, root, process, policy, buffer)))
  ensures (inv(s) ==> canRequestToken(s, root, process, policy, buffer) ==> alwaysOneCredentialPerAccount(requestToken(s, root, process, policy, buffer)))
  ensures (inv(s) ==> canRequestToken(s, root, process, policy, buffer) ==> stepFailureDoesNotPublish(s, "requestToken", requestToken(s, root, process, policy, buffer)))
  ensures (inv(s) ==> canRequestToken(s, root, process, policy, buffer) ==> stepRemovedAccountNotResurrected(s, "requestToken", requestToken(s, root, process, policy, buffer)))
  ensures (inv(s) ==> canRequestToken(s, root, process, policy, buffer) ==> stepStaleResponseCannotReplace(s, "requestToken", requestToken(s, root, process, policy, buffer)))
  ensures (inv(s) ==> canRequestToken(s, root, process, policy, buffer) ==> stepStalePolicyCommitFails(s, "requestToken", requestToken(s, root, process, policy, buffer)))
{
  if inv(s) && canRequestToken(s, root, process, policy, buffer) {
    var r0 := noRequest.(id := s.nextId, root := root, process := process, policy := policy, buffer := (if (buffer > 1) then buffer else 1), phase := ResolutionPhase.AtStart, outcome := ResolutionOutcome.Pending);
    var rec := recordOf(s, root);
    var r1 := r0.(observedGeneration := rec.generation);
    var s2 := s.(nextId := (s.nextId + 1), requests := (s.requests + [r1]));
    CredentialsIff(s);
    RecordIndex(s, root);
    if !policyValid(s, r0) {
      NewFinished(s, s2, r1, ResolutionOutcome.StorageError, 0, 0, 0);
    } else if !present(s, root) {
      NewFinished(s, s2, r1, ResolutionOutcome.NeedsAuth, 0, 0, 0);
    } else if usable(rec.expires, s.now, r0.buffer) {
      assert rec in s.records;
      NewFinished(s, s2, r1, ResolutionOutcome.TokenOk, rec.token, rec.generation, rec.expires);
    } else if !rec.refreshable {
      NewFinished(s, s2, r1, ResolutionOutcome.NeedsAuth, 0, rec.generation, rec.expires);
    } else {
      var c := r0.(observedGeneration := rec.generation, phase := ResolutionPhase.Queued);
      var t := requestToken(s, root, process, policy, buffer);
      NewRequestIds(s, s2, r1);
      RequestIndex(s2, s.nextId);
      WithRequestAt(s.nextId, c, s2);
      assert t.requests == s.requests + [c];
      NewRequestQueued(s, t, c);
      PerRequest(s, t, c);
    }
  }
}

lemma storageFails_ensures(s: AccessTokens, process: int, root: int, written: bool)
  ensures (inv(s) ==> canStorageFails(s, process, root, written) ==> alwaysQueuesKeepArrivalOrder(storageFails(s, process, root, written)))
  ensures (inv(s) ==> canStorageFails(s, process, root, written) ==> alwaysOneRefreshPerAccountKey(storageFails(s, process, root, written)))
  ensures (inv(s) ==> canStorageFails(s, process, root, written) ==> alwaysRequestsNumberedOnce(storageFails(s, process, root, written)))
  ensures (inv(s) ==> canStorageFails(s, process, root, written) ==> alwaysQueuesHoldTheirOwnRequests(storageFails(s, process, root, written)))
  ensures (inv(s) ==> canStorageFails(s, process, root, written) ==> alwaysTokenMatchesOutcome(storageFails(s, process, root, written)))
  ensures (inv(s) ==> canStorageFails(s, process, root, written) ==> alwaysExplicitPolicyBeforeGrant(storageFails(s, process, root, written)))
  ensures (inv(s) ==> canStorageFails(s, process, root, written) ==> alwaysTransientFailureKeepsCapturedGeneration(storageFails(s, process, root, written)))
  ensures (inv(s) ==> canStorageFails(s, process, root, written) ==> alwaysRefreshedRequiresPublication(storageFails(s, process, root, written)))
  ensures (inv(s) ==> canStorageFails(s, process, root, written) ==> alwaysRotatedGrantIsRetained(storageFails(s, process, root, written)))
  ensures (inv(s) ==> canStorageFails(s, process, root, written) ==> alwaysSettlesBeforeOutcomeOrPublication(storageFails(s, process, root, written)))
  ensures (inv(s) ==> canStorageFails(s, process, root, written) ==> alwaysCommitCarriesToken(storageFails(s, process, root, written)))
  ensures (inv(s) ==> canStorageFails(s, process, root, written) ==> alwaysCommittedGenerationsBelowNext(storageFails(s, process, root, written)))
  ensures (inv(s) ==> canStorageFails(s, process, root, written) ==> alwaysOneCredentialPerAccount(storageFails(s, process, root, written)))
  ensures (inv(s) ==> canStorageFails(s, process, root, written) ==> stepFailureDoesNotPublish(s, "storageFails", storageFails(s, process, root, written)))
  ensures (inv(s) ==> canStorageFails(s, process, root, written) ==> stepRemovedAccountNotResurrected(s, "storageFails", storageFails(s, process, root, written)))
  ensures (inv(s) ==> canStorageFails(s, process, root, written) ==> stepStaleResponseCannotReplace(s, "storageFails", storageFails(s, process, root, written)))
  ensures (inv(s) ==> canStorageFails(s, process, root, written) ==> stepStalePolicyCommitFails(s, "storageFails", storageFails(s, process, root, written)))
{
  if inv(s) && canStorageFails(s, process, root, written) {
    var r := activeOf(s, process, root);
    ActiveFacts(s, process, root);
    var renewed := recordOf(s, r.root).(generation := s.nextGeneration, token := r.responseToken, grant := r.responseGrant, expires := (s.now + r.responseLifetime));
    var t := s.(records := (if written then (var s_map := s.records; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var x := s_map[i_map]; (if (x.root == r.root) then renewed else x))) else s.records), nextGeneration := (if written then (s.nextGeneration + 1) else s.nextGeneration), requests := withRequest(r.id, r.(published := written, committedGeneration := (if written then renewed.generation else 0)), s));
    assert storageFails(s, process, root, written) == finished(r.id, ResolutionOutcome.StorageError, 0, 0, 0, false, t);
    assert |t.records| == |s.records| && forall i :: 0 <= i < |s.records| ==> t.records[i] == (if written && s.records[i].root == r.root then renewed else s.records[i]);
    Publish(s, t, r, renewed, written, ResolutionOutcome.StorageError, 0, 0, 0, false);
  }
}

lemma NumberedText(s: AccessTokens)
  ensures alwaysRequestsNumberedOnce(s) == ((s.nextId >= 1) && !((exists r :: r in s.requests && !((((r.id >= 1) && (r.id < s.nextId)) && (|ProofLib.Filter((o: Resolution) => (o.id == r.id), s.requests)| == 1))))))
{
}

lemma CredentialsText(s: AccessTokens)
  ensures alwaysOneCredentialPerAccount(s) == !((exists x :: x in s.records && !((((x.token > 0) && (x.generation > 0)) && (|ProofLib.Filter((y: TokenRecord) => (y.root == x.root), s.records)| == 1)))))
{
}

lemma RefreshText(s: AccessTokens)
  ensures alwaysOneRefreshPerAccountKey(s) == (!((exists r :: r in s.requests && !((!((r.phase.AtProvider? || r.phase.Committing?)) || ((queueOf(s, r.process, r.root).active == r.id) && ((if ((0 <= 0) && (0 < |queueOf(s, r.process, r.root).waiting|)) then queueOf(s, r.process, r.root).waiting[0] else 0) == r.id)))))) && !((exists q :: q in s.queues && !(((|ProofLib.Filter((o: KeyQueue) => ((o.process == q.process) && (o.root == q.root)), s.queues)| == 1) && ((q.active == 0) || ((if ((0 <= 0) && (0 < |q.waiting|)) then q.waiting[0] else 0) == q.active)))))))
{
}

lemma RequestOfText(s: AccessTokens, id: int)
  ensures requestOf(s, id) == (if ((0 <= 0) && (0 < |ProofLib.Filter((r: Resolution) => (r.id == id), s.requests)|)) then ProofLib.Filter((r: Resolution) => (r.id == id), s.requests)[0] else noRequest)
{
}

lemma RecordOfText(s: AccessTokens, root: int)
  ensures recordOf(s, root) == (if ((0 <= 0) && (0 < |ProofLib.Filter((r: TokenRecord) => (r.root == root), s.records)|)) then ProofLib.Filter((r: TokenRecord) => (r.root == root), s.records)[0] else noRecord)
{
}

lemma QueueOfText(s: AccessTokens, process: int, root: int)
  ensures queueOf(s, process, root) == (if ((0 <= 0) && (0 < |ProofLib.Filter((q: KeyQueue) => ((q.process == process) && (q.root == root)), s.queues)|)) then ProofLib.Filter((q: KeyQueue) => ((q.process == process) && (q.root == root)), s.queues)[0] else KeyQueue(process, root, [], 0))
{
}

lemma RequestIndex(s: AccessTokens, id: int)
  requires ProofLib.DistinctBy(s.requests, (r: Resolution) => r.id)
  ensures forall i :: 0 <= i < |s.requests| && s.requests[i].id == id ==> requestOf(s, id) == s.requests[i]
  ensures (forall i :: 0 <= i < |s.requests| ==> s.requests[i].id != id) ==> requestOf(s, id) == noRequest
{
  RequestOfText(s, id);
  var p := (r: Resolution) => (r.id == id);
  var f := ProofLib.Filter(p, s.requests);
  if 0 < |f| {
    ProofLib.FilterMember(p, s.requests, f[0]);
    var j :| 0 <= j < |s.requests| && s.requests[j] == f[0];
  } else {
    forall i | 0 <= i < |s.requests| ensures s.requests[i].id != id {
      ProofLib.FilterMember(p, s.requests, s.requests[i]);
    }
  }
}

lemma RecordIndex(s: AccessTokens, root: int)
  requires ProofLib.DistinctBy(s.records, (x: TokenRecord) => x.root)
  ensures forall i :: 0 <= i < |s.records| && s.records[i].root == root ==> recordOf(s, root) == s.records[i]
  ensures (forall i :: 0 <= i < |s.records| ==> s.records[i].root != root) ==> recordOf(s, root) == noRecord
{
  RecordOfText(s, root);
  var p := (r: TokenRecord) => (r.root == root);
  var f := ProofLib.Filter(p, s.records);
  if 0 < |f| {
    ProofLib.FilterMember(p, s.records, f[0]);
    var j :| 0 <= j < |s.records| && s.records[j] == f[0];
  } else {
    forall i | 0 <= i < |s.records| ensures s.records[i].root != root {
      ProofLib.FilterMember(p, s.records, s.records[i]);
    }
  }
}

lemma QueueIndex(s: AccessTokens, process: int, root: int)
  requires ProofLib.DistinctBy(s.queues, (q: KeyQueue) => (q.process, q.root))
  ensures forall i :: 0 <= i < |s.queues| && s.queues[i].process == process && s.queues[i].root == root ==> queueOf(s, process, root) == s.queues[i]
  ensures (forall i :: 0 <= i < |s.queues| ==> !(s.queues[i].process == process && s.queues[i].root == root)) ==> queueOf(s, process, root) == KeyQueue(process, root, [], 0)
{
  QueueOfText(s, process, root);
  var p := (q: KeyQueue) => ((q.process == process) && (q.root == root));
  var f := ProofLib.Filter(p, s.queues);
  if 0 < |f| {
    ProofLib.FilterMember(p, s.queues, f[0]);
    var j :| 0 <= j < |s.queues| && s.queues[j] == f[0];
  } else {
    forall i | 0 <= i < |s.queues| ensures !(s.queues[i].process == process && s.queues[i].root == root) {
      ProofLib.FilterMember(p, s.queues, s.queues[i]);
    }
  }
}

lemma NumberedIff(s: AccessTokens)
  ensures alwaysRequestsNumberedOnce(s) <==> s.nextId >= 1 && (forall r :: r in s.requests ==> r.id >= 1 && r.id < s.nextId) && ProofLib.DistinctBy(s.requests, (r: Resolution) => r.id)
{
  NumberedText(s);
  forall i | 0 <= i < |s.requests| ensures |ProofLib.Filter((o: Resolution) => (o.id == s.requests[i].id), s.requests)| == 1 <==> forall j :: 0 <= j < |s.requests| && j != i ==> s.requests[j].id != s.requests[i].id {
    ProofLib.FilterCountOneIffUnique((o: Resolution) => (o.id == s.requests[i].id), s.requests, (r: Resolution) => r.id, i);
  }
}

lemma CredentialsIff(s: AccessTokens)
  ensures alwaysOneCredentialPerAccount(s) <==> (forall x :: x in s.records ==> x.token > 0 && x.generation > 0) && ProofLib.DistinctBy(s.records, (x: TokenRecord) => x.root)
{
  CredentialsText(s);
  forall i | 0 <= i < |s.records| ensures |ProofLib.Filter((y: TokenRecord) => (y.root == s.records[i].root), s.records)| == 1 <==> forall j :: 0 <= j < |s.records| && j != i ==> s.records[j].root != s.records[i].root {
    ProofLib.FilterCountOneIffUnique((y: TokenRecord) => (y.root == s.records[i].root), s.records, (x: TokenRecord) => x.root, i);
  }
}

lemma RefreshIff(s: AccessTokens)
  ensures alwaysOneRefreshPerAccountKey(s) <==> (forall r :: r in s.requests && (r.phase.AtProvider? || r.phase.Committing?) ==> queueOf(s, r.process, r.root).active == r.id && (if ((0 <= 0) && (0 < |queueOf(s, r.process, r.root).waiting|)) then queueOf(s, r.process, r.root).waiting[0] else 0) == r.id) && ProofLib.DistinctBy(s.queues, (q: KeyQueue) => (q.process, q.root)) && (forall q :: q in s.queues ==> q.active == 0 || (if ((0 <= 0) && (0 < |q.waiting|)) then q.waiting[0] else 0) == q.active)
{
  RefreshText(s);
  forall i | 0 <= i < |s.queues| ensures |ProofLib.Filter((o: KeyQueue) => ((o.process == s.queues[i].process) && (o.root == s.queues[i].root)), s.queues)| == 1 <==> forall j :: 0 <= j < |s.queues| && j != i ==> (s.queues[j].process, s.queues[j].root) != (s.queues[i].process, s.queues[i].root) {
    ProofLib.FilterCountOneIffUnique((o: KeyQueue) => ((o.process == s.queues[i].process) && (o.root == s.queues[i].root)), s.queues, (q: KeyQueue) => (q.process, q.root), i);
  }
}

lemma AscFold(c: ArrivalCursor, xs: seq<int>)
  ensures Std.Collections.Seq.FoldLeft((acc: ArrivalCursor, id: int) => ArrivalCursor((acc.ok && (id > acc.last)), id), c, xs).ok <==> c.ok && (forall i :: 0 <= i < |xs| ==> xs[i] > c.last) && (forall i, j :: 0 <= i < j < |xs| ==> xs[i] < xs[j])
  decreases |xs|
{
  if |xs| > 0 {
    AscFold(ArrivalCursor((c.ok && (xs[0] > c.last)), xs[0]), xs[1..]);
    assert forall i :: 0 < i < |xs| ==> xs[i] == xs[1..][i - 1];
  }
}

lemma AscIff(xs: seq<int>)
  ensures ascending(xs) <==> (forall i :: 0 <= i < |xs| ==> xs[i] > 0) && (forall i, j :: 0 <= i < j < |xs| ==> xs[i] < xs[j])
{
  AscFold(arrivalStart, xs);
}

lemma SortedFilter(xs: seq<int>, id: int, ys: seq<int>)
  requires forall i, j :: 0 <= i < j < |xs| ==> xs[i] < xs[j]
  requires ys == ProofLib.Filter((w: int) => (w != id), xs)
  ensures forall i, j :: 0 <= i < j < |ys| ==> ys[i] < ys[j]
  ensures forall v :: v in ys <==> v in xs && v != id
  ensures 0 < |xs| && xs[0] != id ==> 0 < |ys| && ys[0] == xs[0]
  decreases |xs|
{
  var p := (w: int) => (w != id);
  forall v ensures v in ys <==> v in xs && v != id {
    ProofLib.FilterMember(p, xs, v);
  }
  if |xs| > 0 {
    ProofLib.FilterCons(p, xs);
    var r := ProofLib.Filter(p, xs[1..]);
    SortedFilter(xs[1..], id, r);
    forall j | 0 <= j < |r| ensures r[j] > xs[0] {
      assert r[j] in r;
      var k :| 0 <= k < |xs[1..]| && xs[1..][k] == r[j];
      assert xs[k + 1] == r[j];
    }
    if p(xs[0]) {
      forall i, j | 0 <= i < j < |r| + 1 ensures ([xs[0]] + r)[i] < ([xs[0]] + r)[j] {
        if i > 0 {
          assert ([xs[0]] + r)[i] == r[i - 1] && ([xs[0]] + r)[j] == r[j - 1];
        }
      }
    }
  } else {
    ProofLib.FilterNil(p, xs);
  }
}

lemma DequeuedAt(id: int, s: AccessTokens)
  ensures |dequeued(id, s)| == |s.queues|
  ensures forall i :: 0 <= i < |s.queues| ==> dequeued(id, s)[i] == s.queues[i].(waiting := ProofLib.Filter((w: int) => (w != id), s.queues[i].waiting), active := (if (s.queues[i].active == id) then 0 else s.queues[i].active))
{
}

lemma QueueOfActive(s: AccessTokens, process: int, root: int)
  requires ProofLib.DistinctBy(s.queues, (q: KeyQueue) => (q.process, q.root))
  requires queueOf(s, process, root).active != 0 || 0 < |queueOf(s, process, root).waiting|
  ensures exists i :: 0 <= i < |s.queues| && s.queues[i].process == process && s.queues[i].root == root && queueOf(s, process, root) == s.queues[i]
{
  QueueIndex(s, process, root);
}

lemma DequeueKeeps(s: AccessTokens, t: AccessTokens, id: int)
  requires alwaysQueuesKeepArrivalOrder(s) && alwaysOneRefreshPerAccountKey(s) && alwaysQueuesHoldTheirOwnRequests(s) && alwaysRequestsNumberedOnce(s)
  requires t.queues == dequeued(id, s) && t.nextId == s.nextId
  requires |t.requests| == |s.requests|
  requires forall i :: 0 <= i < |s.requests| ==> t.requests[i].id == s.requests[i].id && t.requests[i].process == s.requests[i].process && t.requests[i].root == s.requests[i].root
  requires forall i :: 0 <= i < |s.requests| && (t.requests[i].phase.AtProvider? || t.requests[i].phase.Committing?) ==> t.requests[i].id != id && (s.requests[i].phase.AtProvider? || s.requests[i].phase.Committing?)
  ensures alwaysQueuesKeepArrivalOrder(t) && alwaysOneRefreshPerAccountKey(t) && alwaysQueuesHoldTheirOwnRequests(t) && alwaysRequestsNumberedOnce(t)
{
  NumberedIff(s);
  NumberedIff(t);
  RefreshIff(s);
  RefreshIff(t);
  DequeuedAt(id, s);
  assert ProofLib.DistinctBy(t.requests, (r: Resolution) => r.id);
  assert ProofLib.DistinctBy(t.queues, (q: KeyQueue) => (q.process, q.root));
  forall q | q in t.queues
    ensures ascending(q.waiting) && (forall w :: w in q.waiting ==> w < t.nextId)
    ensures forall w :: w in q.waiting ==> exists r :: r in t.requests && r.id == w && r.process == q.process && r.root == q.root
    ensures q.active == 0 || (if ((0 <= 0) && (0 < |q.waiting|)) then q.waiting[0] else 0) == q.active
  {
    var i :| 0 <= i < |t.queues| && t.queues[i] == q;
    var q0 := s.queues[i];
    assert q0 in s.queues;
    AscIff(q0.waiting);
    AscIff(q.waiting);
    SortedFilter(q0.waiting, id, ProofLib.Filter((w: int) => (w != id), q0.waiting));
    QueuesBounded(s);
    forall j | 0 <= j < |q.waiting| ensures q.waiting[j] > 0 {
      assert q.waiting[j] in q.waiting;
      assert q.waiting[j] in q0.waiting;
    }
    forall w | w in q.waiting ensures exists r :: r in t.requests && r.id == w && r.process == q.process && r.root == q.root {
      assert w in q0.waiting;
      var r0 :| r0 in s.requests && r0.id == w && r0.process == q0.process && r0.root == q0.root;
      var k :| 0 <= k < |s.requests| && s.requests[k] == r0;
      assert t.requests[k] in t.requests;
    }
  }
  forall r | r in t.requests && (r.phase.AtProvider? || r.phase.Committing?)
    ensures queueOf(t, r.process, r.root).active == r.id && (if ((0 <= 0) && (0 < |queueOf(t, r.process, r.root).waiting|)) then queueOf(t, r.process, r.root).waiting[0] else 0) == r.id
  {
    var k :| 0 <= k < |t.requests| && t.requests[k] == r;
    var r0 := s.requests[k];
    assert r0 in s.requests;
    QueueOfActive(s, r0.process, r0.root);
    var j :| 0 <= j < |s.queues| && s.queues[j].process == r0.process && s.queues[j].root == r0.root && queueOf(s, r0.process, r0.root) == s.queues[j];
    QueueIndex(t, r.process, r.root);
    assert queueOf(t, r.process, r.root) == t.queues[j];
    assert s.queues[j] in s.queues;
    AscIff(s.queues[j].waiting);
    SortedFilter(s.queues[j].waiting, id, ProofLib.Filter((w: int) => (w != id), s.queues[j].waiting));
  }
}

lemma PerRequest(s: AccessTokens, t: AccessTokens, c: Resolution)
  requires alwaysTokenMatchesOutcome(s) && alwaysExplicitPolicyBeforeGrant(s) && alwaysTransientFailureKeepsCapturedGeneration(s) && alwaysRefreshedRequiresPublication(s) && alwaysSettlesBeforeOutcomeOrPublication(s) && alwaysCommitCarriesToken(s) && alwaysCommittedGenerationsBelowNext(s) && alwaysRotatedGrantIsRetained(s)
  requires t.records == s.records && t.epochs == s.epochs && t.nextGeneration == s.nextGeneration
  requires forall x :: x in t.requests ==> x == c || x in s.requests
  requires (c.outcome.TokenOk? == (c.resultToken > 0)) && (!(c.outcome.TokenOk?) || ((c.resultGeneration > 0) && (c.resultExpires > (c.decidedAt + c.buffer)))) && (c.buffer >= 1)
  requires (c.issuedGrant == 0) || !(c.policy.NoPolicy?)
  requires !(c.outcome.Transient?) || (c.resultGeneration == c.observedGeneration)
  requires !(c.refreshed) && !(c.published)
  requires (c.phase.ResolutionDone? || c.outcome.Pending?) && (!(c.phase.Committing?) || (c.responseToken > 0)) && (c.committedGeneration < s.nextGeneration)
  ensures alwaysTokenMatchesOutcome(t) && alwaysExplicitPolicyBeforeGrant(t) && alwaysTransientFailureKeepsCapturedGeneration(t) && alwaysRefreshedRequiresPublication(t) && alwaysSettlesBeforeOutcomeOrPublication(t) && alwaysCommitCarriesToken(t) && alwaysCommittedGenerationsBelowNext(t) && alwaysRotatedGrantIsRetained(t)
{
  forall x | x in t.requests ensures present(t, x.root) == present(s, x.root) && recordOf(t, x.root) == recordOf(s, x.root) {
    RecordOfText(s, x.root);
    RecordOfText(t, x.root);
  }
}

lemma ActiveFacts(s: AccessTokens, process: int, root: int)
  requires inv(s)
  requires activeOf(s, process, root).phase.AtProvider? || activeOf(s, process, root).phase.Committing?
  ensures activeOf(s, process, root) in s.requests
  ensures activeOf(s, process, root).id == queueOf(s, process, root).active
  ensures !(activeOf(s, process, root).published) && !(activeOf(s, process, root).refreshed) && activeOf(s, process, root).outcome.Pending?
  ensures forall i :: 0 <= i < |s.requests| && s.requests[i].id == activeOf(s, process, root).id ==> s.requests[i] == activeOf(s, process, root)
{
  NumberedIff(s);
  RequestIndex(s, queueOf(s, process, root).active);
  var r := activeOf(s, process, root);
  assert r != noRequest;
  var k :| 0 <= k < |s.requests| && s.requests[k] == r;
  assert r in s.requests;
}

lemma WithRequestAt(id: int, change: Resolution, s: AccessTokens)
  ensures |withRequest(id, change, s)| == |s.requests|
  ensures forall i :: 0 <= i < |s.requests| ==> withRequest(id, change, s)[i] == (if s.requests[i].id == id then change else s.requests[i])
  ensures forall x :: x in withRequest(id, change, s) ==> x == change || (x in s.requests && x.id != id)
{
  forall x | x in withRequest(id, change, s) ensures x == change || (x in s.requests && x.id != id) {
    var i :| 0 <= i < |s.requests| && withRequest(id, change, s)[i] == x;
  }
}

lemma FinishActive(s: AccessTokens, t: AccessTokens, r: Resolution, rr: Resolution, verdict: ResolutionOutcome, token: int, generation: int, expires: int)
  requires inv(s)
  requires r in s.requests && !(r.phase.ResolutionDone?)
  requires forall i :: 0 <= i < |s.requests| && s.requests[i].id == r.id ==> s.requests[i] == r
  requires rr == r.(observedGeneration := rr.observedGeneration)
  requires !(verdict.TokenOk?) || (token > 0 && generation > 0 && expires > s.now + r.buffer)
  requires !(verdict.Transient?) || generation == rr.observedGeneration
  requires |t.requests| == |s.requests| && forall i :: 0 <= i < |s.requests| ==> t.requests[i] == (if s.requests[i].id == r.id then rr else s.requests[i])
  requires t.queues == s.queues && t.records == s.records && t.epochs == s.epochs && t.nextGeneration == s.nextGeneration && t.nextId == s.nextId && t.now == s.now
  ensures inv(finished(r.id, verdict, token, generation, expires, false, t))
  ensures forall x :: x in finished(r.id, verdict, token, generation, expires, false, t).requests ==> (x in s.requests && x.id != r.id) || (x.id == r.id && x.outcome == verdict && !(x.published))
  ensures finished(r.id, verdict, token, generation, expires, false, t).records == s.records
{
  var f := finished(r.id, verdict, token, generation, expires, false, t);
  NumberedIff(s);
  RequestIndex(s, r.id);
  assert ProofLib.DistinctBy(t.requests, (x: Resolution) => x.id);
  RequestOfText(t, r.id);
  RequestIndex(t, r.id);
  assert requestOf(t, r.id) == rr;
  var c := rr.(phase := ResolutionPhase.ResolutionDone, outcome := verdict, resultToken := (if verdict.TokenOk? then token else 0), resultGeneration := generation, resultExpires := expires, decidedAt := s.now, refreshed := false);
  WithRequestAt(r.id, c, t);
  assert f.requests == withRequest(r.id, c, t);
  DequeuedAt(r.id, s);
  DequeuedAt(r.id, t);
  DequeueKeeps(s, f, r.id);
  PerRequest(s, f, c);
}

lemma SameRequest(xs: seq<Resolution>, a: Resolution, b: Resolution)
  requires ProofLib.DistinctBy(xs, (r: Resolution) => r.id) && a in xs && b in xs && a.id == b.id
  ensures a == b
{
  var i :| 0 <= i < |xs| && xs[i] == a;
  var j :| 0 <= j < |xs| && xs[j] == b;
}

lemma StalePolicyOk(s: AccessTokens, f: AccessTokens, r: Resolution)
  requires ProofLib.DistinctBy(s.requests, (x: Resolution) => x.id) && r in s.requests
  requires forall x :: x in f.requests ==> (x in s.requests && x.id != r.id) || (x.id == r.id && (policyValid(s, r) || (x.outcome.StorageError? && !(x.published))))
  ensures stepStalePolicyCommitFails(s, "commit", f)
{
  forall x, b | x in f.requests && x.phase.ResolutionDone? && b in s.requests && b.id == x.id && b.phase.Committing? && !(policyValid(s, b))
    ensures x.outcome.StorageError? && !(x.published)
  {
    if x in s.requests && x.id != r.id {
      SameRequest(s.requests, x, b);
    } else {
      SameRequest(s.requests, r, b);
    }
  }
}

lemma FilterKeepAll(xs: seq<int>, id: int)
  requires id !in xs
  ensures ProofLib.Filter((w: int) => (w != id), xs) == xs
  decreases |xs|
{
  if |xs| > 0 {
    ProofLib.FilterCons((w: int) => (w != id), xs);
    FilterKeepAll(xs[1..], id);
  } else {
    ProofLib.FilterNil((w: int) => (w != id), xs);
  }
}

lemma DequeueNone(s: AccessTokens, id: int)
  requires forall q :: q in s.queues ==> id !in q.waiting && (q.active != id || q.active == 0)
  ensures dequeued(id, s) == s.queues
{
  DequeuedAt(id, s);
  forall i | 0 <= i < |s.queues| ensures dequeued(id, s)[i] == s.queues[i] {
    assert s.queues[i] in s.queues;
    FilterKeepAll(s.queues[i].waiting, id);
  }
}

lemma QueuesBounded(s: AccessTokens)
  requires alwaysQueuesKeepArrivalOrder(s)
  ensures forall q :: q in s.queues ==> forall w :: w in q.waiting ==> 0 < w < s.nextId
{
  forall q | q in s.queues ensures forall w :: w in q.waiting ==> 0 < w < s.nextId {
    AscIff(q.waiting);
  }
}

lemma Publish(s: AccessTokens, t: AccessTokens, r: Resolution, renewed: TokenRecord, written: bool, verdict: ResolutionOutcome, token: int, generation: int, expires: int, refreshed: bool)
  requires inv(s)
  requires r in s.requests && r.phase.Committing? && !(r.published) && !(r.refreshed) && r.outcome.Pending?
  requires forall i :: 0 <= i < |s.requests| && s.requests[i].id == r.id ==> s.requests[i] == r
  requires policyValid(s, r) && present(s, r.root) && recordOf(s, r.root).generation == r.observedGeneration
  requires renewed == recordOf(s, r.root).(generation := s.nextGeneration, token := r.responseToken, grant := r.responseGrant, expires := (s.now + r.responseLifetime))
  requires |t.records| == |s.records| && forall i :: 0 <= i < |s.records| ==> t.records[i] == (if written && s.records[i].root == r.root then renewed else s.records[i])
  requires t.nextGeneration == (if written then s.nextGeneration + 1 else s.nextGeneration)
  requires t.queues == s.queues && t.nextId == s.nextId && t.epochs == s.epochs && t.now == s.now
  requires t.requests == withRequest(r.id, r.(published := written, committedGeneration := (if written then renewed.generation else 0)), s)
  requires !(verdict.TokenOk?) || (token > 0 && generation > 0 && expires > s.now + r.buffer)
  requires !(verdict.Transient?) && (!refreshed || (written && verdict.TokenOk?))
  ensures inv(finished(r.id, verdict, token, generation, expires, refreshed, t))
  ensures stepStaleResponseCannotReplace(s, "commit", finished(r.id, verdict, token, generation, expires, refreshed, t)) && stepStaleResponseCannotReplace(s, "storageFails", finished(r.id, verdict, token, generation, expires, refreshed, t))
  ensures stepRemovedAccountNotResurrected(s, "commit", finished(r.id, verdict, token, generation, expires, refreshed, t)) && stepRemovedAccountNotResurrected(s, "storageFails", finished(r.id, verdict, token, generation, expires, refreshed, t))
  ensures forall x :: x in finished(r.id, verdict, token, generation, expires, refreshed, t).requests ==> (x in s.requests && x.id != r.id) || x.id == r.id
{
  PublishQueues(s, t, r, renewed, written, verdict, token, generation, expires, refreshed);
  PublishRules(s, finished(r.id, verdict, token, generation, expires, refreshed, t), r, renewed, written, r.(published := written, committedGeneration := (if written then renewed.generation else 0), phase := ResolutionPhase.ResolutionDone, outcome := verdict, resultToken := (if verdict.TokenOk? then token else 0), resultGeneration := generation, resultExpires := expires, decidedAt := s.now, refreshed := refreshed));
  PublishSteps(s, finished(r.id, verdict, token, generation, expires, refreshed, t), r, renewed, written);
}

lemma PublishQueues(s: AccessTokens, t: AccessTokens, r: Resolution, renewed: TokenRecord, written: bool, verdict: ResolutionOutcome, token: int, generation: int, expires: int, refreshed: bool)
  requires inv(s)
  requires r in s.requests && r.phase.Committing? && !(r.published) && !(r.refreshed) && r.outcome.Pending?
  requires forall i :: 0 <= i < |s.requests| && s.requests[i].id == r.id ==> s.requests[i] == r
  requires policyValid(s, r) && present(s, r.root) && recordOf(s, r.root).generation == r.observedGeneration
  requires renewed == recordOf(s, r.root).(generation := s.nextGeneration, token := r.responseToken, grant := r.responseGrant, expires := (s.now + r.responseLifetime))
  requires |t.records| == |s.records| && forall i :: 0 <= i < |s.records| ==> t.records[i] == (if written && s.records[i].root == r.root then renewed else s.records[i])
  requires t.nextGeneration == (if written then s.nextGeneration + 1 else s.nextGeneration)
  requires t.queues == s.queues && t.nextId == s.nextId && t.epochs == s.epochs && t.now == s.now
  requires t.requests == withRequest(r.id, r.(published := written, committedGeneration := (if written then renewed.generation else 0)), s)
  ensures alwaysQueuesKeepArrivalOrder(finished(r.id, verdict, token, generation, expires, refreshed, t)) && alwaysOneRefreshPerAccountKey(finished(r.id, verdict, token, generation, expires, refreshed, t)) && alwaysQueuesHoldTheirOwnRequests(finished(r.id, verdict, token, generation, expires, refreshed, t)) && alwaysRequestsNumberedOnce(finished(r.id, verdict, token, generation, expires, refreshed, t))
  ensures forall x :: x in finished(r.id, verdict, token, generation, expires, refreshed, t).requests ==> (x in s.requests && x.id != r.id) || x == r.(published := written, committedGeneration := (if written then renewed.generation else 0), phase := ResolutionPhase.ResolutionDone, outcome := verdict, resultToken := (if verdict.TokenOk? then token else 0), resultGeneration := generation, resultExpires := expires, decidedAt := s.now, refreshed := refreshed)
  ensures finished(r.id, verdict, token, generation, expires, refreshed, t).records == t.records && finished(r.id, verdict, token, generation, expires, refreshed, t).nextGeneration == t.nextGeneration && finished(r.id, verdict, token, generation, expires, refreshed, t).epochs == s.epochs
{
  var f := finished(r.id, verdict, token, generation, expires, refreshed, t);
  var rp := r.(published := written, committedGeneration := (if written then renewed.generation else 0));
  var c := r.(published := written, committedGeneration := (if written then renewed.generation else 0), phase := ResolutionPhase.ResolutionDone, outcome := verdict, resultToken := (if verdict.TokenOk? then token else 0), resultGeneration := generation, resultExpires := expires, decidedAt := s.now, refreshed := refreshed);
  NumberedIff(s);
  RequestIndex(s, r.id);
  WithRequestAt(r.id, rp, s);
  assert ProofLib.DistinctBy(t.requests, (x: Resolution) => x.id);
  RequestOfText(t, r.id);
  RequestIndex(t, r.id);
  assert requestOf(t, r.id) == rp;
  WithRequestAt(r.id, c, t);
  assert f.requests == withRequest(r.id, c, t);
  DequeuedAt(r.id, s);
  DequeuedAt(r.id, t);
  DequeueKeeps(s, f, r.id);
}

lemma PublishRules(s: AccessTokens, f: AccessTokens, r: Resolution, renewed: TokenRecord, written: bool, c: Resolution)
  requires inv(s)
  requires r in s.requests && r.phase.Committing? && present(s, r.root)
  requires renewed == recordOf(s, r.root).(generation := s.nextGeneration, token := r.responseToken, grant := r.responseGrant, expires := (s.now + r.responseLifetime))
  requires |f.records| == |s.records| && forall i :: 0 <= i < |s.records| ==> f.records[i] == (if written && s.records[i].root == r.root then renewed else s.records[i])
  requires f.nextGeneration == (if written then s.nextGeneration + 1 else s.nextGeneration)
  requires forall x :: x in f.requests ==> (x in s.requests && x.id != r.id) || x == c
  requires c.root == r.root && c.responseGrant == r.responseGrant && c.phase.ResolutionDone? && c.published == written && c.committedGeneration == (if written then renewed.generation else 0)
  requires (c.outcome.TokenOk? == (c.resultToken > 0)) && (!(c.outcome.TokenOk?) || ((c.resultGeneration > 0) && (c.resultExpires > (c.decidedAt + c.buffer)))) && (c.buffer >= 1)
  requires ((c.issuedGrant == 0) || !(c.policy.NoPolicy?)) && !(c.outcome.Transient?) && (!(c.refreshed) || (c.published && c.outcome.TokenOk?))
  ensures alwaysTokenMatchesOutcome(f) && alwaysExplicitPolicyBeforeGrant(f) && alwaysTransientFailureKeepsCapturedGeneration(f) && alwaysRefreshedRequiresPublication(f) && alwaysSettlesBeforeOutcomeOrPublication(f) && alwaysCommitCarriesToken(f) && alwaysCommittedGenerationsBelowNext(f) && alwaysOneCredentialPerAccount(f) && alwaysRotatedGrantIsRetained(f)
{
  CredentialsIff(s);
  CredentialsIff(f);
  var k :| 0 <= k < |s.records| && s.records[k].root == r.root;
  RecordIndex(s, r.root);
  assert renewed.root == r.root;
  assert ProofLib.DistinctBy(f.records, (x: TokenRecord) => x.root);
  RecordIndex(f, r.root);
  forall rt | rt != r.root ensures present(f, rt) == present(s, rt) && recordOf(f, rt) == recordOf(s, rt) {
    RecordIndex(s, rt);
    RecordIndex(f, rt);
    if present(s, rt) {
      var i :| 0 <= i < |s.records| && s.records[i].root == rt;
      assert f.records[i] in f.records;
    }
    if present(f, rt) {
      var i :| 0 <= i < |f.records| && f.records[i].root == rt;
      assert s.records[i] in s.records;
    }
  }
  assert f.records[k] in f.records;
  if !written {
    assert f.records == s.records;
  }
}

lemma PublishSteps(s: AccessTokens, f: AccessTokens, r: Resolution, renewed: TokenRecord, written: bool)
  requires inv(s)
  requires r in s.requests && r.phase.Committing? && policyValid(s, r) && present(s, r.root) && recordOf(s, r.root).generation == r.observedGeneration
  requires renewed == recordOf(s, r.root).(generation := s.nextGeneration, token := r.responseToken, grant := r.responseGrant, expires := (s.now + r.responseLifetime))
  requires |f.records| == |s.records| && forall i :: 0 <= i < |s.records| ==> f.records[i] == (if written && s.records[i].root == r.root then renewed else s.records[i])
  ensures stepStaleResponseCannotReplace(s, "commit", f) && stepStaleResponseCannotReplace(s, "storageFails", f)
  ensures stepRemovedAccountNotResurrected(s, "commit", f) && stepRemovedAccountNotResurrected(s, "storageFails", f)
{
  CredentialsIff(s);
  RecordIndex(s, r.root);
  var k :| 0 <= k < |s.records| && s.records[k].root == r.root;
  assert renewed.root == r.root;
  forall b | b in s.records && b !in f.records ensures exists x :: x in s.requests && x.phase.Committing? && x.root == b.root && x.observedGeneration == b.generation && policyValid(s, x) {
    var i :| 0 <= i < |s.records| && s.records[i] == b;
    assert b.root == r.root;
  }
  forall a | a in f.records ensures exists b :: b in s.records && b.root == a.root {
    var i :| 0 <= i < |f.records| && f.records[i] == a;
    assert s.records[i] in s.records;
  }
}

lemma AdmitFacts(s: AccessTokens, process: int, root: int)
  requires inv(s) && canAdmit(s, process, root)
  ensures 0 < |queueOf(s, process, root).waiting| && queueOf(s, process, root) in s.queues && queueOf(s, process, root).process == process && queueOf(s, process, root).root == root && queueOf(s, process, root).active == 0
  ensures requestOf(s, queueOf(s, process, root).waiting[0]) in s.requests && requestOf(s, queueOf(s, process, root).waiting[0]).id == queueOf(s, process, root).waiting[0]
  ensures requestOf(s, queueOf(s, process, root).waiting[0]).process == process && requestOf(s, queueOf(s, process, root).waiting[0]).root == root && requestOf(s, queueOf(s, process, root).waiting[0]).phase.Queued?
  ensures forall i :: 0 <= i < |s.requests| && s.requests[i].id == queueOf(s, process, root).waiting[0] ==> s.requests[i] == requestOf(s, queueOf(s, process, root).waiting[0])
{
  NumberedIff(s);
  RefreshIff(s);
  var q := queueOf(s, process, root);
  var h := (if ((0 <= 0) && (0 < |q.waiting|)) then q.waiting[0] else 0);
  RequestIndex(s, h);
  assert requestOf(s, h) != noRequest;
  var k :| 0 <= k < |s.requests| && s.requests[k].id == h;
  assert s.requests[k] in s.requests;
  assert 0 < |q.waiting|;
  QueueOfActive(s, process, root);
  QueueIndex(s, process, root);
  assert h in q.waiting;
  var y :| y in s.requests && y.id == h && y.process == q.process && y.root == q.root;
  var j :| 0 <= j < |s.requests| && s.requests[j] == y;
}

lemma AdmitQueues(s: AccessTokens, t: AccessTokens, r: Resolution, c: Resolution)
  requires inv(s)
  requires r in s.requests && r.phase.Queued? && (forall i :: 0 <= i < |s.requests| && s.requests[i].id == r.id ==> s.requests[i] == r)
  requires queueOf(s, r.process, r.root) in s.queues && queueOf(s, r.process, r.root).process == r.process && queueOf(s, r.process, r.root).root == r.root
  requires queueOf(s, r.process, r.root).active == 0 && 0 < |queueOf(s, r.process, r.root).waiting| && queueOf(s, r.process, r.root).waiting[0] == r.id
  requires c.id == r.id && c.process == r.process && c.root == r.root
  requires |t.requests| == |s.requests| && forall i :: 0 <= i < |s.requests| ==> t.requests[i] == (if s.requests[i].id == r.id then c else s.requests[i])
  requires |t.queues| == |s.queues| && forall i :: 0 <= i < |s.queues| ==> t.queues[i] == (if s.queues[i].process == r.process && s.queues[i].root == r.root then s.queues[i].(active := r.id) else s.queues[i])
  requires t.nextId == s.nextId
  ensures alwaysQueuesKeepArrivalOrder(t) && alwaysOneRefreshPerAccountKey(t) && alwaysQueuesHoldTheirOwnRequests(t) && alwaysRequestsNumberedOnce(t)
{
  NumberedIff(s);
  NumberedIff(t);
  RefreshIff(s);
  RefreshIff(t);
  assert ProofLib.DistinctBy(t.requests, (x: Resolution) => x.id);
  assert ProofLib.DistinctBy(t.queues, (q: KeyQueue) => (q.process, q.root));
  forall q | q in t.queues
    ensures ascending(q.waiting) && (forall w :: w in q.waiting ==> w < t.nextId)
    ensures forall w :: w in q.waiting ==> exists x :: x in t.requests && x.id == w && x.process == q.process && x.root == q.root
    ensures q.active == 0 || (if ((0 <= 0) && (0 < |q.waiting|)) then q.waiting[0] else 0) == q.active
  {
    var i :| 0 <= i < |t.queues| && t.queues[i] == q;
    var q0 := s.queues[i];
    assert q0 in s.queues;
    if q0.process == r.process && q0.root == r.root {
      QueueIndex(s, r.process, r.root);
    }
    forall w | w in q.waiting ensures exists x :: x in t.requests && x.id == w && x.process == q.process && x.root == q.root {
      var x0 :| x0 in s.requests && x0.id == w && x0.process == q0.process && x0.root == q0.root;
      var k :| 0 <= k < |s.requests| && s.requests[k] == x0;
      assert t.requests[k] in t.requests;
    }
  }
  QueueIndex(s, r.process, r.root);
  var m :| 0 <= m < |s.queues| && s.queues[m] == queueOf(s, r.process, r.root);
  forall x | x in t.requests && (x.phase.AtProvider? || x.phase.Committing?)
    ensures queueOf(t, x.process, x.root).active == x.id && (if ((0 <= 0) && (0 < |queueOf(t, x.process, x.root).waiting|)) then queueOf(t, x.process, x.root).waiting[0] else 0) == x.id
  {
    var k :| 0 <= k < |t.requests| && t.requests[k] == x;
    QueueIndex(t, x.process, x.root);
    if s.requests[k].id == r.id {
      assert t.queues[m] == s.queues[m].(active := r.id);
    } else {
      var x0 := s.requests[k];
      assert x0 in s.requests && x0 == x;
      QueueOfActive(s, x0.process, x0.root);
      var j :| 0 <= j < |s.queues| && s.queues[j].process == x0.process && s.queues[j].root == x0.root && queueOf(s, x0.process, x0.root) == s.queues[j];
      assert j != m;
      assert t.queues[j] == s.queues[j];
    }
  }
}

lemma NewRequestIds(s: AccessTokens, t: AccessTokens, c: Resolution)
  requires alwaysRequestsNumberedOnce(s) && alwaysQueuesKeepArrivalOrder(s)
  requires c.id == s.nextId && t.nextId == s.nextId + 1 && t.requests == s.requests + [c]
  ensures alwaysRequestsNumberedOnce(t)
  ensures ProofLib.DistinctBy(t.requests, (x: Resolution) => x.id)
  ensures forall q :: q in s.queues ==> forall w :: w in q.waiting ==> 0 < w < s.nextId
{
  NumberedIff(s);
  NumberedIff(t);
  ProofLib.DistinctByConcat(s.requests, [c], (x: Resolution) => x.id);
  QueuesBounded(s);
}

lemma NewRequestSame(s: AccessTokens, t: AccessTokens, c: Resolution)
  requires inv(s)
  requires c.id == s.nextId && t.nextId == s.nextId + 1 && t.requests == s.requests + [c] && t.queues == s.queues
  requires !(c.phase.AtProvider? || c.phase.Committing?)
  ensures alwaysQueuesKeepArrivalOrder(t) && alwaysOneRefreshPerAccountKey(t) && alwaysQueuesHoldTheirOwnRequests(t) && alwaysRequestsNumberedOnce(t)
{
  NewRequestIds(s, t, c);
  RefreshIff(s);
  RefreshIff(t);
}

lemma NewRequestQueued(s: AccessTokens, t: AccessTokens, c: Resolution)
  requires inv(s)
  requires c.id == s.nextId && t.nextId == s.nextId + 1 && t.requests == s.requests + [c] && c.phase.Queued?
  requires t.queues == (if (exists q :: q in s.queues && ((q.process == c.process) && (q.root == c.root))) then (var s_map := s.queues; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var q := s_map[i_map]; (if ((q.process == c.process) && (q.root == c.root)) then q.(waiting := (q.waiting + [c.id])) else q))) else (s.queues + [KeyQueue(c.process, c.root, [c.id], 0)]))
  ensures alwaysQueuesKeepArrivalOrder(t) && alwaysOneRefreshPerAccountKey(t) && alwaysQueuesHoldTheirOwnRequests(t) && alwaysRequestsNumberedOnce(t)
{
  NewRequestIds(s, t, c);
  RefreshIff(s);
  RefreshIff(t);
  var n := c.id;
  var appended := !(exists q :: q in s.queues && ((q.process == c.process) && (q.root == c.root)));
  if appended {
    ProofLib.DistinctByConcat(s.queues, [KeyQueue(c.process, c.root, [n], 0)], (q: KeyQueue) => (q.process, q.root));
  }
  assert ProofLib.DistinctBy(t.queues, (q: KeyQueue) => (q.process, q.root));
  assert c in t.requests;
  forall q | q in t.queues
    ensures ascending(q.waiting) && (forall w :: w in q.waiting ==> w < t.nextId)
    ensures forall w :: w in q.waiting ==> exists x :: x in t.requests && x.id == w && x.process == q.process && x.root == q.root
    ensures q.active == 0 || (if ((0 <= 0) && (0 < |q.waiting|)) then q.waiting[0] else 0) == q.active
  {
    AscIff(q.waiting);
    var i :| 0 <= i < |t.queues| && t.queues[i] == q;
    if i < |s.queues| {
      var q0 := s.queues[i];
      assert q0 in s.queues;
      AscIff(q0.waiting);
      forall w | w in q.waiting ensures exists x :: x in t.requests && x.id == w && x.process == q.process && x.root == q.root {
        if w != n {
          assert w in q0.waiting;
          var x0 :| x0 in s.requests && x0.id == w && x0.process == q0.process && x0.root == q0.root;
          assert x0 in t.requests;
        }
      }
      if q0.process == c.process && q0.root == c.root {
        assert q.waiting == q0.waiting + [n];
        forall a, b | 0 <= a < b < |q.waiting| ensures q.waiting[a] < q.waiting[b] {
          assert q.waiting[a] == q0.waiting[a];
          assert q0.waiting[a] in q0.waiting;
          if b < |q0.waiting| {
            assert q.waiting[b] == q0.waiting[b];
          }
        }
        if 0 < |q0.waiting| {
          assert q.waiting[0] == q0.waiting[0];
        }
      }
    }
  }
  forall x | x in t.requests && (x.phase.AtProvider? || x.phase.Committing?)
    ensures queueOf(t, x.process, x.root).active == x.id && (if ((0 <= 0) && (0 < |queueOf(t, x.process, x.root).waiting|)) then queueOf(t, x.process, x.root).waiting[0] else 0) == x.id
  {
    assert x in s.requests;
    QueueOfActive(s, x.process, x.root);
    var j :| 0 <= j < |s.queues| && s.queues[j].process == x.process && s.queues[j].root == x.root && queueOf(s, x.process, x.root) == s.queues[j];
    QueueIndex(t, x.process, x.root);
    assert t.queues[j].process == x.process && t.queues[j].root == x.root;
    if s.queues[j].process == c.process && s.queues[j].root == c.root {
      assert t.queues[j].waiting[0] == s.queues[j].waiting[0];
    }
  }
}

lemma NewFinished(s: AccessTokens, s2: AccessTokens, r1: Resolution, verdict: ResolutionOutcome, token: int, generation: int, expires: int)
  requires inv(s)
  requires r1.id == s.nextId && r1.phase.AtStart? && r1.outcome.Pending? && !(r1.published) && !(r1.refreshed) && r1.issuedGrant == 0 && r1.buffer >= 1 && r1.committedGeneration == 0
  requires s2 == s.(nextId := (s.nextId + 1), requests := (s.requests + [r1]))
  requires !(verdict.TokenOk?) || (token > 0 && generation > 0 && expires > s.now + r1.buffer)
  requires !(verdict.Transient?)
  ensures inv(finished(r1.id, verdict, token, generation, expires, false, s2))
{
  var f := finished(r1.id, verdict, token, generation, expires, false, s2);
  NewRequestIds(s, s2, r1);
  RequestOfText(s2, r1.id);
  RequestIndex(s2, r1.id);
  assert s2.requests[|s.requests|] == r1;
  assert requestOf(s2, r1.id) == r1;
  var c := r1.(phase := ResolutionPhase.ResolutionDone, outcome := verdict, resultToken := (if verdict.TokenOk? then token else 0), resultGeneration := generation, resultExpires := expires, decidedAt := s.now, refreshed := false);
  WithRequestAt(r1.id, c, s2);
  assert f.requests == s.requests + [c];
  RefreshIff(s);
  forall q | q in s2.queues ensures r1.id !in q.waiting && (q.active != r1.id || q.active == 0) {
    if q.active != 0 {
      assert q.waiting[0] in q.waiting;
    }
  }
  DequeueNone(s2, r1.id);
  NewRequestSame(s, f, c);
  PerRequest(s, f, c);
}

lemma OtherRecords(s: AccessTokens, t: AccessTokens, root: int)
  requires ProofLib.DistinctBy(s.records, (x: TokenRecord) => x.root) && ProofLib.DistinctBy(t.records, (x: TokenRecord) => x.root)
  requires forall x: TokenRecord :: x.root != root ==> (x in t.records <==> x in s.records)
  ensures forall rt :: rt != root ==> present(t, rt) == present(s, rt) && recordOf(t, rt) == recordOf(s, rt)
{
  forall rt | rt != root ensures present(t, rt) == present(s, rt) && recordOf(t, rt) == recordOf(s, rt) {
    RecordIndex(s, rt);
    RecordIndex(t, rt);
    if present(s, rt) {
      var i :| 0 <= i < |s.records| && s.records[i].root == rt;
      assert s.records[i] in s.records;
      var j :| 0 <= j < |t.records| && t.records[j] == s.records[i];
    }
    if present(t, rt) {
      var j :| 0 <= j < |t.records| && t.records[j].root == rt;
      assert t.records[j] in t.records;
      var i :| 0 <= i < |s.records| && s.records[i] == t.records[j];
    }
  }
}
