lemma FlowCounts(s: ConnectorStore)
  ensures alwaysFlowAliasesUnique(s) == (forall entry :: entry in s.flows ==> |ProofLib.Filter((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), s.flows)| == 1)
{}

lemma AccountCounts(s: ConnectorStore)
  ensures alwaysAccountIdentityUnique(s) == (forall account :: account in s.accounts ==> |ProofLib.Filter((other: core__accountValues_AccountValue) => ((other.provider == account.provider) && (other.id == account.id)), s.accounts)| == 1)
{}

lemma BindingCounts(s: ConnectorStore)
  ensures alwaysOwnerBindingIdentityUnique(s) == (forall binding :: binding in s.ownerBindings ==> |ProofLib.Filter((other: OwnerBinding) => (((other.connector == binding.connector) && (other.externalId == binding.externalId)) && (other.instanceId == binding.instanceId)), s.ownerBindings)| == 1)
{}

lemma FlowPairs(s: ConnectorStore)
  ensures alwaysFlowAliasesUnique(s) == (forall i, j :: 0 <= i < |s.flows| && 0 <= j < |s.flows| && i != j ==> !(s.flows[i].value.provider == s.flows[j].value.provider && (s.flows[i].value.id == s.flows[j].value.id || s.flows[i].value.token == s.flows[j].value.token || s.flows[i].value.id == s.flows[j].value.token || s.flows[i].value.token == s.flows[j].value.id)))
{
  FlowCounts(s);
  if alwaysFlowAliasesUnique(s) {
    forall i, j | 0 <= i < |s.flows| && 0 <= j < |s.flows| && i != j
      ensures !(s.flows[i].value.provider == s.flows[j].value.provider && (s.flows[i].value.id == s.flows[j].value.id || s.flows[i].value.token == s.flows[j].value.token || s.flows[i].value.id == s.flows[j].value.token || s.flows[i].value.token == s.flows[j].value.id))
    {
      var entry := s.flows[i];
      assert entry in s.flows;
      if entry.value.provider == s.flows[j].value.provider && (entry.value.id == s.flows[j].value.id || entry.value.token == s.flows[j].value.token || entry.value.id == s.flows[j].value.token || entry.value.token == s.flows[j].value.id) {
        ProofLib.FilterTwo((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), s.flows, i, j);
      }
    }
  } else {
    var entry :| entry in s.flows && |ProofLib.Filter((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), s.flows)| != 1;
    var i :| 0 <= i < |s.flows| && s.flows[i] == entry;
    if forall j :: 0 <= j < |s.flows| && j != i ==> !(s.flows[i].value.provider == s.flows[j].value.provider && (s.flows[i].value.id == s.flows[j].value.id || s.flows[i].value.token == s.flows[j].value.token || s.flows[i].value.id == s.flows[j].value.token || s.flows[i].value.token == s.flows[j].value.id)) {
      ProofLib.FilterOne((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), s.flows, i);
    }
  }
}

lemma FlowsKept(s: ConnectorStore, after: ConnectorStore, keep: FlowEntry -> bool)
  requires alwaysFlowAliasesUnique(s) && after.flows == ProofLib.Filter(keep, s.flows)
  ensures alwaysFlowAliasesUnique(after)
{
  FlowCounts(s); FlowCounts(after);
  forall entry | entry in after.flows
    ensures |ProofLib.Filter((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), after.flows)| == 1
  {
    var same := (other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id)));
    ProofLib.FilterMember(keep, s.flows, entry);
    ProofLib.FilterOfFilterShorter(keep, same, s.flows);
    ProofLib.FilterMember(same, after.flows, entry);
  }
}

lemma FlowsSameKeys(s: ConnectorStore, after: ConnectorStore)
  requires alwaysFlowAliasesUnique(s) && |after.flows| == |s.flows|
  requires forall i :: 0 <= i < |s.flows| ==> after.flows[i].value.provider == s.flows[i].value.provider && after.flows[i].value.id == s.flows[i].value.id && after.flows[i].value.token == s.flows[i].value.token
  ensures alwaysFlowAliasesUnique(after)
{
  FlowPairs(s); FlowPairs(after);
}

lemma AccountsKept(s: ConnectorStore, after: ConnectorStore, keep: core__accountValues_AccountValue -> bool)
  requires alwaysAccountIdentityUnique(s) && after.accounts == ProofLib.Filter(keep, s.accounts)
  ensures alwaysAccountIdentityUnique(after)
{
  AccountCounts(s); AccountCounts(after);
  forall account | account in after.accounts
    ensures |ProofLib.Filter((other: core__accountValues_AccountValue) => ((other.provider == account.provider) && (other.id == account.id)), after.accounts)| == 1
  {
    var same := (other: core__accountValues_AccountValue) => ((other.provider == account.provider) && (other.id == account.id));
    ProofLib.FilterMember(keep, s.accounts, account);
    ProofLib.FilterOfFilterShorter(keep, same, s.accounts);
    ProofLib.FilterMember(same, after.accounts, account);
  }
}

lemma DeleteAccountParts(s: ConnectorStore, provider: string, id: string)
  ensures var removed := accountAt(s, provider, id); deleteAccount(s, provider, id) == (if removed.id == "" then s else s.(accounts := ProofLib.Filter((account: core__accountValues_AccountValue) => ((account.provider != removed.provider) || (account.id != removed.id)), s.accounts), revoked := (if (AccountRef(removed.provider, removed.id) in s.revoked) then s.revoked else (s.revoked + [AccountRef(removed.provider, removed.id)]))))
{}

lemma upsertAccount_ensures(s: ConnectorStore, account: core__accountValues_AccountValue)
  ensures (inv(s) ==> canUpsertAccount(s, account) ==> alwaysOwnerBindingIdentityUnique(upsertAccount(s, account)))
  ensures (inv(s) ==> canUpsertAccount(s, account) ==> alwaysFlowAliasesUnique(upsertAccount(s, account)))
  ensures (inv(s) ==> canUpsertAccount(s, account) ==> alwaysAccountIdentityUnique(upsertAccount(s, account)))
  ensures (inv(s) ==> canUpsertAccount(s, account) ==> stepRemovalRevokes(s, "upsertAccount", upsertAccount(s, account)))
{
  if inv(s) && canUpsertAccount(s, account) {
    var after := upsertAccount(s, account);
    AccountCounts(s); AccountCounts(after);
    forall a | a in s.accounts
      ensures exists kept :: kept in after.accounts && ((kept.provider == a.provider) && (kept.id == a.id))
    {
      var i :| 0 <= i < |s.accounts| && s.accounts[i] == a;
      assert after.accounts[i] in after.accounts;
    }
    if exists prior :: prior in s.accounts && ((prior.provider == account.provider) && (prior.id == account.id)) {
      forall o | o in after.accounts
        ensures |ProofLib.Filter((other: core__accountValues_AccountValue) => ((other.provider == o.provider) && (other.id == o.id)), after.accounts)| == 1
      {
        var i :| 0 <= i < |after.accounts| && after.accounts[i] == o;
        assert s.accounts[i].provider == o.provider && s.accounts[i].id == o.id;
        ProofLib.FilterLengthPointwise((other: core__accountValues_AccountValue) => ((other.provider == o.provider) && (other.id == o.id)), (other: core__accountValues_AccountValue) => ((other.provider == o.provider) && (other.id == o.id)), s.accounts, after.accounts);
        ProofLib.FilterSamePredicate((other: core__accountValues_AccountValue) => ((other.provider == o.provider) && (other.id == o.id)), (other: core__accountValues_AccountValue) => ((other.provider == s.accounts[i].provider) && (other.id == s.accounts[i].id)), s.accounts);
      }
    } else {
      forall o | o in after.accounts
        ensures |ProofLib.Filter((other: core__accountValues_AccountValue) => ((other.provider == o.provider) && (other.id == o.id)), after.accounts)| == 1
      {
        ProofLib.FilterAppend((other: core__accountValues_AccountValue) => ((other.provider == o.provider) && (other.id == o.id)), s.accounts, account);
        if o.provider == account.provider && o.id == account.id { ProofLib.FilterNone((other: core__accountValues_AccountValue) => ((other.provider == o.provider) && (other.id == o.id)), s.accounts); }
        else { assert o in s.accounts; }
      }
    }
  }
}

lemma bindOwner_ensures(s: ConnectorStore, connector: string, externalId: string, instanceId: string, body: string)
  ensures (inv(s) ==> alwaysOwnerBindingIdentityUnique(bindOwner(s, connector, externalId, instanceId, body)))
  ensures (inv(s) ==> alwaysFlowAliasesUnique(bindOwner(s, connector, externalId, instanceId, body)))
  ensures (inv(s) ==> alwaysAccountIdentityUnique(bindOwner(s, connector, externalId, instanceId, body)))
  ensures (inv(s) ==> stepRemovalRevokes(s, "bindOwner", bindOwner(s, connector, externalId, instanceId, body)))
{
  if inv(s) {
    var after := bindOwner(s, connector, externalId, instanceId, body);
    var keep := (binding: OwnerBinding) => (((binding.connector != connector) || (binding.externalId != externalId)) || (binding.instanceId != instanceId));
    var kept := ProofLib.Filter(keep, s.ownerBindings);
    var added := OwnerBinding(connector, externalId, instanceId, body);
    assert after.ownerBindings == kept + [added];
    BindingCounts(s); BindingCounts(after);
    forall o | o in after.ownerBindings
      ensures |ProofLib.Filter((other: OwnerBinding) => (((other.connector == o.connector) && (other.externalId == o.externalId)) && (other.instanceId == o.instanceId)), after.ownerBindings)| == 1
    {
      var same := (other: OwnerBinding) => (((other.connector == o.connector) && (other.externalId == o.externalId)) && (other.instanceId == o.instanceId));
      ProofLib.FilterAppend(same, kept, added);
      if o == added {
        forall i | 0 <= i < |kept| ensures !same(kept[i]) { ProofLib.FilterMember(keep, s.ownerBindings, kept[i]); }
        ProofLib.FilterNone(same, kept);
      } else {
        assert o in kept;
        ProofLib.FilterMember(keep, s.ownerBindings, o);
        ProofLib.FilterOfFilterShorter(keep, same, s.ownerBindings);
        ProofLib.FilterMember(same, kept, o);
      }
    }
  }
}

lemma createFlow_ensures(s: ConnectorStore, value: FlowValue)
  ensures (inv(s) ==> canCreateFlow(s, value) ==> alwaysOwnerBindingIdentityUnique(createFlow(s, value)))
  ensures (inv(s) ==> canCreateFlow(s, value) ==> alwaysFlowAliasesUnique(createFlow(s, value)))
  ensures (inv(s) ==> canCreateFlow(s, value) ==> alwaysAccountIdentityUnique(createFlow(s, value)))
  ensures (inv(s) ==> canCreateFlow(s, value) ==> stepRemovalRevokes(s, "createFlow", createFlow(s, value)))
{
  if inv(s) && canCreateFlow(s, value) {
    var after := createFlow(s, value);
    FlowPairs(s); FlowPairs(after);
    assert forall k :: 0 <= k < |s.flows| ==> after.flows[k] == s.flows[k] && s.flows[k] in s.flows;
  }
}

lemma reinsertFlow_ensures(s: ConnectorStore, value: FlowValue)
  ensures (inv(s) ==> canReinsertFlow(s, value) ==> alwaysOwnerBindingIdentityUnique(reinsertFlow(s, value)))
  ensures (inv(s) ==> canReinsertFlow(s, value) ==> alwaysFlowAliasesUnique(reinsertFlow(s, value)))
  ensures (inv(s) ==> canReinsertFlow(s, value) ==> alwaysAccountIdentityUnique(reinsertFlow(s, value)))
  ensures (inv(s) ==> canReinsertFlow(s, value) ==> stepRemovalRevokes(s, "reinsertFlow", reinsertFlow(s, value)))
{
  if inv(s) && canReinsertFlow(s, value) {
    var after := reinsertFlow(s, value);
    FlowPairs(s); FlowPairs(after);
    assert forall k :: 0 <= k < |s.flows| ==> s.flows[k] in s.flows;
    if exists entry :: entry in s.flows && ((entry.value.provider == value.provider) && (entry.value.id == value.id)) {
      assert forall k :: 0 <= k < |s.flows| ==> after.flows[k] == (if s.flows[k].value.provider == value.provider && s.flows[k].value.id == value.id then FlowEntry(value, s.flows[k].consumed) else s.flows[k]);
    } else {
      assert forall k :: 0 <= k < |s.flows| ==> after.flows[k] == s.flows[k];
    }
  }
}

lemma consumeFlow_ensures(s: ConnectorStore, provider: string, token: string)
  ensures (inv(s) ==> canConsumeFlow(s, provider, token) ==> alwaysOwnerBindingIdentityUnique(consumeFlow(s, provider, token)))
  ensures (inv(s) ==> canConsumeFlow(s, provider, token) ==> alwaysFlowAliasesUnique(consumeFlow(s, provider, token)))
  ensures (inv(s) ==> canConsumeFlow(s, provider, token) ==> alwaysAccountIdentityUnique(consumeFlow(s, provider, token)))
  ensures (inv(s) ==> canConsumeFlow(s, provider, token) ==> stepRemovalRevokes(s, "consumeFlow", consumeFlow(s, provider, token)))
{
  if inv(s) && canConsumeFlow(s, provider, token) {
    FlowsSameKeys(s, consumeFlow(s, provider, token));
  }
}

lemma updateFlow_ensures(s: ConnectorStore, provider: string, id: string, updated: FlowValue)
  ensures (inv(s) ==> alwaysOwnerBindingIdentityUnique(updateFlow(s, provider, id, updated)))
  ensures (inv(s) ==> alwaysFlowAliasesUnique(updateFlow(s, provider, id, updated)))
  ensures (inv(s) ==> alwaysAccountIdentityUnique(updateFlow(s, provider, id, updated)))
  ensures (inv(s) ==> stepRemovalRevokes(s, "updateFlow", updateFlow(s, provider, id, updated)))
{
  if inv(s) {
    FlowsSameKeys(s, updateFlow(s, provider, id, updated));
  }
}

lemma deleteFlow_ensures(s: ConnectorStore, provider: string, id: string)
  ensures (inv(s) ==> alwaysOwnerBindingIdentityUnique(deleteFlow(s, provider, id)))
  ensures (inv(s) ==> alwaysFlowAliasesUnique(deleteFlow(s, provider, id)))
  ensures (inv(s) ==> alwaysAccountIdentityUnique(deleteFlow(s, provider, id)))
  ensures (inv(s) ==> stepRemovalRevokes(s, "deleteFlow", deleteFlow(s, provider, id)))
{
  if inv(s) {
    FlowsKept(s, deleteFlow(s, provider, id), (entry: FlowEntry) => ((entry.value.provider != provider) || ((entry.value.id != id) && (entry.value.token != id))));
  }
}

lemma sweepExpired_ensures(s: ConnectorStore)
  ensures (inv(s) ==> alwaysOwnerBindingIdentityUnique(sweepExpired(s)))
  ensures (inv(s) ==> alwaysFlowAliasesUnique(sweepExpired(s)))
  ensures (inv(s) ==> alwaysAccountIdentityUnique(sweepExpired(s)))
  ensures (inv(s) ==> stepRemovalRevokes(s, "sweepExpired", sweepExpired(s)))
{
  if inv(s) {
    FlowsKept(s, sweepExpired(s), (entry: FlowEntry) => (((entry.consumed || !(entry.value.hasExpiry)) || (entry.value.expiresAt == 0)) || (entry.value.expiresAt > s.now)));
  }
}

lemma deleteAccount_ensures(s: ConnectorStore, provider: string, id: string)
  ensures (inv(s) ==> alwaysOwnerBindingIdentityUnique(deleteAccount(s, provider, id)))
  ensures (inv(s) ==> alwaysFlowAliasesUnique(deleteAccount(s, provider, id)))
  ensures (inv(s) ==> alwaysAccountIdentityUnique(deleteAccount(s, provider, id)))
  ensures (inv(s) ==> stepRemovalRevokes(s, "deleteAccount", deleteAccount(s, provider, id)))
{
  if inv(s) {
    var after := deleteAccount(s, provider, id);
    var removed := accountAt(s, provider, id);
    DeleteAccountParts(s, provider, id);
    if removed.id != "" {
      var keep := (account: core__accountValues_AccountValue) => ((account.provider != removed.provider) || (account.id != removed.id));
      AccountsKept(s, after, keep);
      forall account | account in s.accounts
        ensures (exists kept :: kept in after.accounts && ((kept.provider == account.provider) && (kept.id == account.id))) || (AccountRef(account.provider, account.id) in after.revoked)
      {
        ProofLib.FilterMember(keep, s.accounts, account);
      }
    }
  }
}
