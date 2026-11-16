lemma StoreFilteredAccount(xs: seq<core__accountValues_AccountValue>, keeps: core__accountValues_AccountValue -> bool)
  requires forall entry :: entry in xs ==> |ProofLib.Filter((other: core__accountValues_AccountValue) => ((other.provider == entry.provider) && (other.id == entry.id)), xs)| == 1
  ensures forall entry :: entry in ProofLib.Filter(keeps, xs) ==> |ProofLib.Filter((other: core__accountValues_AccountValue) => ((other.provider == entry.provider) && (other.id == entry.id)), ProofLib.Filter(keeps, xs))| == 1
{
  forall entry | entry in ProofLib.Filter(keeps, xs)
    ensures |ProofLib.Filter((other: core__accountValues_AccountValue) => ((other.provider == entry.provider) && (other.id == entry.id)), ProofLib.Filter(keeps, xs))| == 1
  {
    ProofLib.FilterMember(keeps, xs, entry);
    ProofLib.FilterOfFilterLength(keeps, (other: core__accountValues_AccountValue) => ((other.provider == entry.provider) && (other.id == entry.id)), (other: core__accountValues_AccountValue) => ((other.provider == entry.provider) && (other.id == entry.id)), xs);
    ProofLib.FilterMember((other: core__accountValues_AccountValue) => ((other.provider == entry.provider) && (other.id == entry.id)), ProofLib.Filter(keeps, xs), entry);
  }
}
lemma StoreAppendAccount(xs: seq<core__accountValues_AccountValue>, added: core__accountValues_AccountValue)
  requires forall entry :: entry in xs ==> |ProofLib.Filter((other: core__accountValues_AccountValue) => ((other.provider == entry.provider) && (other.id == entry.id)), xs)| == 1
  requires forall entry :: entry in xs ==> !((entry.provider == added.provider) && (entry.id == added.id))
  ensures forall entry :: entry in xs + [added] ==> |ProofLib.Filter((other: core__accountValues_AccountValue) => ((other.provider == entry.provider) && (other.id == entry.id)), xs + [added])| == 1
{
  forall entry | entry in xs + [added]
    ensures |ProofLib.Filter((other: core__accountValues_AccountValue) => ((other.provider == entry.provider) && (other.id == entry.id)), xs + [added])| == 1
  {
    ProofLib.FilterAppend((other: core__accountValues_AccountValue) => ((other.provider == entry.provider) && (other.id == entry.id)), xs, added);
    if entry == added {
      ProofLib.FilterNone((other: core__accountValues_AccountValue) => ((other.provider == entry.provider) && (other.id == entry.id)), xs);
    } else {
      assert entry in xs;
    }
  }
}

lemma StoreFilteredBinding(xs: seq<OwnerBinding>, keeps: OwnerBinding -> bool)
  requires forall entry :: entry in xs ==> |ProofLib.Filter((other: OwnerBinding) => (((other.connector == entry.connector) && (other.externalId == entry.externalId)) && (other.instanceId == entry.instanceId)), xs)| == 1
  ensures forall entry :: entry in ProofLib.Filter(keeps, xs) ==> |ProofLib.Filter((other: OwnerBinding) => (((other.connector == entry.connector) && (other.externalId == entry.externalId)) && (other.instanceId == entry.instanceId)), ProofLib.Filter(keeps, xs))| == 1
{
  forall entry | entry in ProofLib.Filter(keeps, xs)
    ensures |ProofLib.Filter((other: OwnerBinding) => (((other.connector == entry.connector) && (other.externalId == entry.externalId)) && (other.instanceId == entry.instanceId)), ProofLib.Filter(keeps, xs))| == 1
  {
    ProofLib.FilterMember(keeps, xs, entry);
    ProofLib.FilterOfFilterLength(keeps, (other: OwnerBinding) => (((other.connector == entry.connector) && (other.externalId == entry.externalId)) && (other.instanceId == entry.instanceId)), (other: OwnerBinding) => (((other.connector == entry.connector) && (other.externalId == entry.externalId)) && (other.instanceId == entry.instanceId)), xs);
    ProofLib.FilterMember((other: OwnerBinding) => (((other.connector == entry.connector) && (other.externalId == entry.externalId)) && (other.instanceId == entry.instanceId)), ProofLib.Filter(keeps, xs), entry);
  }
}
lemma StoreAppendBinding(xs: seq<OwnerBinding>, added: OwnerBinding)
  requires forall entry :: entry in xs ==> |ProofLib.Filter((other: OwnerBinding) => (((other.connector == entry.connector) && (other.externalId == entry.externalId)) && (other.instanceId == entry.instanceId)), xs)| == 1
  requires forall entry :: entry in xs ==> !(((entry.connector == added.connector) && (entry.externalId == added.externalId)) && (entry.instanceId == added.instanceId))
  ensures forall entry :: entry in xs + [added] ==> |ProofLib.Filter((other: OwnerBinding) => (((other.connector == entry.connector) && (other.externalId == entry.externalId)) && (other.instanceId == entry.instanceId)), xs + [added])| == 1
{
  forall entry | entry in xs + [added]
    ensures |ProofLib.Filter((other: OwnerBinding) => (((other.connector == entry.connector) && (other.externalId == entry.externalId)) && (other.instanceId == entry.instanceId)), xs + [added])| == 1
  {
    ProofLib.FilterAppend((other: OwnerBinding) => (((other.connector == entry.connector) && (other.externalId == entry.externalId)) && (other.instanceId == entry.instanceId)), xs, added);
    if entry == added {
      ProofLib.FilterNone((other: OwnerBinding) => (((other.connector == entry.connector) && (other.externalId == entry.externalId)) && (other.instanceId == entry.instanceId)), xs);
    } else {
      assert entry in xs;
    }
  }
}

lemma StoreFilteredFlow(xs: seq<FlowEntry>, keeps: FlowEntry -> bool)
  requires forall entry :: entry in xs ==> |ProofLib.Filter((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), xs)| == 1
  ensures forall entry :: entry in ProofLib.Filter(keeps, xs) ==> |ProofLib.Filter((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), ProofLib.Filter(keeps, xs))| == 1
{
  forall entry | entry in ProofLib.Filter(keeps, xs)
    ensures |ProofLib.Filter((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), ProofLib.Filter(keeps, xs))| == 1
  {
    ProofLib.FilterMember(keeps, xs, entry);
    ProofLib.FilterOfFilterLength(keeps, (other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), (other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), xs);
    ProofLib.FilterMember((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), ProofLib.Filter(keeps, xs), entry);
  }
}
lemma StoreAppendFlow(xs: seq<FlowEntry>, added: FlowEntry)
  requires forall entry :: entry in xs ==> |ProofLib.Filter((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), xs)| == 1
  requires forall entry :: entry in xs ==> !((entry.value.provider == added.value.provider) && ((((entry.value.id == added.value.id) || (entry.value.token == added.value.token)) || (entry.value.id == added.value.token)) || (entry.value.token == added.value.id)))
  ensures forall entry :: entry in xs + [added] ==> |ProofLib.Filter((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), xs + [added])| == 1
{
  forall entry | entry in xs + [added]
    ensures |ProofLib.Filter((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), xs + [added])| == 1
  {
    ProofLib.FilterAppend((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), xs, added);
    if entry == added {
      ProofLib.FilterNone((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), xs);
    } else {
      assert entry in xs;
    }
  }
}

lemma StoreMappedAccount(before: seq<core__accountValues_AccountValue>, after: seq<core__accountValues_AccountValue>)
  requires forall entry :: entry in before ==> |ProofLib.Filter((other: core__accountValues_AccountValue) => ((other.provider == entry.provider) && (other.id == entry.id)), before)| == 1
  requires |after| == |before|
  requires forall i :: 0 <= i < |before| ==> after[i].provider == before[i].provider && after[i].id == before[i].id
  ensures forall entry :: entry in after ==> |ProofLib.Filter((other: core__accountValues_AccountValue) => ((other.provider == entry.provider) && (other.id == entry.id)), after)| == 1
{
  forall entry | entry in after ensures |ProofLib.Filter((other: core__accountValues_AccountValue) => ((other.provider == entry.provider) && (other.id == entry.id)), after)| == 1 {
    var i :| 0 <= i < |after| && after[i] == entry;
    var prior := before[i];
    assert |ProofLib.Filter((other: core__accountValues_AccountValue) => ((other.provider == prior.provider) && (other.id == prior.id)), before)| == 1;
    ProofLib.FilterLengthPointwise((other: core__accountValues_AccountValue) => ((other.provider == entry.provider) && (other.id == entry.id)), (other: core__accountValues_AccountValue) => ((other.provider == prior.provider) && (other.id == prior.id)), after, before);
  }
}

lemma StoreMappedFlow(before: seq<FlowEntry>, after: seq<FlowEntry>)
  requires forall entry :: entry in before ==> |ProofLib.Filter((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), before)| == 1
  requires |after| == |before|
  requires forall i :: 0 <= i < |before| ==> after[i].value.provider == before[i].value.provider && after[i].value.id == before[i].value.id && after[i].value.token == before[i].value.token
  ensures forall entry :: entry in after ==> |ProofLib.Filter((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), after)| == 1
{
  forall entry | entry in after ensures |ProofLib.Filter((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), after)| == 1 {
    var i :| 0 <= i < |after| && after[i] == entry;
    var prior := before[i];
    assert |ProofLib.Filter((other: FlowEntry) => ((other.value.provider == prior.value.provider) && ((((other.value.id == prior.value.id) || (other.value.token == prior.value.token)) || (other.value.id == prior.value.token)) || (other.value.token == prior.value.id))), before)| == 1;
    ProofLib.FilterLengthPointwise((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), (other: FlowEntry) => ((other.value.provider == prior.value.provider) && ((((other.value.id == prior.value.id) || (other.value.token == prior.value.token)) || (other.value.id == prior.value.token)) || (other.value.token == prior.value.id))), after, before);
  }
}

lemma StoreAlwaysAccountIdentityUniqueView(s: ConnectorStore)
  ensures alwaysAccountIdentityUnique(s) == (!((exists account :: account in s.accounts && !((|ProofLib.Filter((other: core__accountValues_AccountValue) => ((other.provider == account.provider) && (other.id == account.id)), s.accounts)| == 1)))))
{
}

lemma StoreAlwaysOwnerBindingIdentityUniqueView(s: ConnectorStore)
  ensures alwaysOwnerBindingIdentityUnique(s) == (!((exists binding :: binding in s.ownerBindings && !((|ProofLib.Filter((other: OwnerBinding) => (((other.connector == binding.connector) && (other.externalId == binding.externalId)) && (other.instanceId == binding.instanceId)), s.ownerBindings)| == 1)))))
{
}

lemma StoreAlwaysFlowAliasesUniqueView(s: ConnectorStore)
  ensures alwaysFlowAliasesUnique(s) == (!((exists entry :: entry in s.flows && !((|ProofLib.Filter((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), s.flows)| == 1)))))
{
}

lemma StoreDeleteAccountView(s: ConnectorStore, provider: string, id: string)
  ensures deleteAccount(s, provider, id) == (s.(accounts := ProofLib.Filter((account: core__accountValues_AccountValue) => ((account.provider != provider) || (account.id != accountAt(s, provider, id).id)), s.accounts)))
{
}

lemma StoreBindOwnerView(s: ConnectorStore, connector: string, externalId: string, instanceId: string, body: string)
  ensures bindOwner(s, connector, externalId, instanceId, body) == (s.(ownerBindings := (ProofLib.Filter((binding: OwnerBinding) => (((binding.connector != connector) || (binding.externalId != externalId)) || (binding.instanceId != instanceId)), s.ownerBindings) + [OwnerBinding(connector, externalId, instanceId, body)])))
{
}

lemma StoreDeleteFlowView(s: ConnectorStore, provider: string, id: string)
  ensures deleteFlow(s, provider, id) == (s.(flows := ProofLib.Filter((entry: FlowEntry) => ((entry.value.provider != provider) || ((entry.value.id != id) && (entry.value.token != id))), s.flows)))
{
}

lemma StoreSweepExpiredView(s: ConnectorStore)
  ensures sweepExpired(s) == (s.(flows := ProofLib.Filter((entry: FlowEntry) => (((entry.consumed || !(entry.value.hasExpiry)) || (entry.value.expiresAt == 0)) || (entry.value.expiresAt > s.now)), s.flows)))
{
}

lemma StoreFlowPositions(xs: seq<FlowEntry>)
  requires forall entry :: entry in xs ==> |ProofLib.Filter((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), xs)| == 1
  ensures forall i, j :: 0 <= i < |xs| && 0 <= j < |xs| && i != j ==> !((xs[j].value.provider == xs[i].value.provider) && ((((xs[j].value.id == xs[i].value.id) || (xs[j].value.token == xs[i].value.token)) || (xs[j].value.id == xs[i].value.token)) || (xs[j].value.token == xs[i].value.id)))
{
  forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j
    ensures !((xs[j].value.provider == xs[i].value.provider) && ((((xs[j].value.id == xs[i].value.id) || (xs[j].value.token == xs[i].value.token)) || (xs[j].value.id == xs[i].value.token)) || (xs[j].value.token == xs[i].value.id)))
  {
    var entry := xs[i];
    assert |ProofLib.Filter((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), xs)| == 1;
    if ((xs[j].value.provider == entry.value.provider) && ((((xs[j].value.id == entry.value.id) || (xs[j].value.token == entry.value.token)) || (xs[j].value.id == entry.value.token)) || (xs[j].value.token == entry.value.id))) {
      ProofLib.FilterTwo((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), xs, i, j);
    }
  }
}

lemma StoreFlowCounts(xs: seq<FlowEntry>)
  requires forall i, j :: 0 <= i < |xs| && 0 <= j < |xs| && i != j ==> !((xs[j].value.provider == xs[i].value.provider) && ((((xs[j].value.id == xs[i].value.id) || (xs[j].value.token == xs[i].value.token)) || (xs[j].value.id == xs[i].value.token)) || (xs[j].value.token == xs[i].value.id)))
  ensures forall entry :: entry in xs ==> |ProofLib.Filter((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), xs)| == 1
{
  forall entry | entry in xs ensures |ProofLib.Filter((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), xs)| == 1 {
    var i :| 0 <= i < |xs| && xs[i] == entry;
    ProofLib.FilterOne((other: FlowEntry) => ((other.value.provider == entry.value.provider) && ((((other.value.id == entry.value.id) || (other.value.token == entry.value.token)) || (other.value.id == entry.value.token)) || (other.value.token == entry.value.id))), xs, i);
  }
}

lemma upsertAccount_ensures(s: ConnectorStore, account: core__accountValues_AccountValue)
  ensures (inv(s) ==> canUpsertAccount(s, account) ==> alwaysAccountIdentityUnique(upsertAccount(s, account)))
  ensures (inv(s) ==> canUpsertAccount(s, account) ==> alwaysOwnerBindingIdentityUnique(upsertAccount(s, account)))
  ensures (inv(s) ==> canUpsertAccount(s, account) ==> alwaysFlowAliasesUnique(upsertAccount(s, account)))
{
  if inv(s) && canUpsertAccount(s, account) {
    StoreAlwaysAccountIdentityUniqueView(s);
    var after := upsertAccount(s, account);
    StoreAlwaysAccountIdentityUniqueView(after);
    if exists prior :: prior in s.accounts && prior.provider == account.provider && prior.id == account.id {
      StoreMappedAccount(s.accounts, after.accounts);
    } else {
      StoreAppendAccount(s.accounts, account);
    }
  }
}

lemma deleteAccount_ensures(s: ConnectorStore, provider: string, id: string)
  ensures (inv(s) ==> alwaysAccountIdentityUnique(deleteAccount(s, provider, id)))
  ensures (inv(s) ==> alwaysOwnerBindingIdentityUnique(deleteAccount(s, provider, id)))
  ensures (inv(s) ==> alwaysFlowAliasesUnique(deleteAccount(s, provider, id)))
{
  if inv(s) {
    StoreDeleteAccountView(s, provider, id);
    StoreAlwaysAccountIdentityUniqueView(s);
    StoreAlwaysAccountIdentityUniqueView(deleteAccount(s, provider, id));
    StoreFilteredAccount(s.accounts, (account: core__accountValues_AccountValue) => ((account.provider != provider) || (account.id != accountAt(s, provider, id).id)));
  }
}

lemma bindOwner_ensures(s: ConnectorStore, connector: string, externalId: string, instanceId: string, body: string)
  ensures (inv(s) ==> alwaysAccountIdentityUnique(bindOwner(s, connector, externalId, instanceId, body)))
  ensures (inv(s) ==> alwaysOwnerBindingIdentityUnique(bindOwner(s, connector, externalId, instanceId, body)))
  ensures (inv(s) ==> alwaysFlowAliasesUnique(bindOwner(s, connector, externalId, instanceId, body)))
{
  if inv(s) {
    StoreBindOwnerView(s, connector, externalId, instanceId, body);
    StoreAlwaysOwnerBindingIdentityUniqueView(s);
    StoreAlwaysOwnerBindingIdentityUniqueView(bindOwner(s, connector, externalId, instanceId, body));
    var kept := ProofLib.Filter((binding: OwnerBinding) => (((binding.connector != connector) || (binding.externalId != externalId)) || (binding.instanceId != instanceId)), s.ownerBindings);
    StoreFilteredBinding(s.ownerBindings, (binding: OwnerBinding) => (((binding.connector != connector) || (binding.externalId != externalId)) || (binding.instanceId != instanceId)));
    forall entry | entry in kept ensures !(((entry.connector == OwnerBinding(connector, externalId, instanceId, body).connector) && (entry.externalId == OwnerBinding(connector, externalId, instanceId, body).externalId)) && (entry.instanceId == OwnerBinding(connector, externalId, instanceId, body).instanceId)) {
      ProofLib.FilterMember((binding: OwnerBinding) => (((binding.connector != connector) || (binding.externalId != externalId)) || (binding.instanceId != instanceId)), s.ownerBindings, entry);
    }
    StoreAppendBinding(kept, OwnerBinding(connector, externalId, instanceId, body));
  }
}

lemma deleteFlow_ensures(s: ConnectorStore, provider: string, id: string)
  ensures (inv(s) ==> alwaysAccountIdentityUnique(deleteFlow(s, provider, id)))
  ensures (inv(s) ==> alwaysOwnerBindingIdentityUnique(deleteFlow(s, provider, id)))
  ensures (inv(s) ==> alwaysFlowAliasesUnique(deleteFlow(s, provider, id)))
{
  if inv(s) {
    StoreDeleteFlowView(s, provider, id);
    StoreAlwaysFlowAliasesUniqueView(s);
    StoreAlwaysFlowAliasesUniqueView(deleteFlow(s, provider, id));
    StoreFilteredFlow(s.flows, (entry: FlowEntry) => ((entry.value.provider != provider) || ((entry.value.id != id) && (entry.value.token != id))));
  }
}

lemma sweepExpired_ensures(s: ConnectorStore)
  ensures (inv(s) ==> alwaysAccountIdentityUnique(sweepExpired(s)))
  ensures (inv(s) ==> alwaysOwnerBindingIdentityUnique(sweepExpired(s)))
  ensures (inv(s) ==> alwaysFlowAliasesUnique(sweepExpired(s)))
{
  if inv(s) {
    StoreSweepExpiredView(s);
    StoreAlwaysFlowAliasesUniqueView(s);
    StoreAlwaysFlowAliasesUniqueView(sweepExpired(s));
    StoreFilteredFlow(s.flows, (entry: FlowEntry) => (((entry.consumed || !(entry.value.hasExpiry)) || (entry.value.expiresAt == 0)) || (entry.value.expiresAt > s.now)));
  }
}

lemma consumeFlow_ensures(s: ConnectorStore, provider: string, token: string)
  ensures (inv(s) ==> canConsumeFlow(s, provider, token) ==> alwaysAccountIdentityUnique(consumeFlow(s, provider, token)))
  ensures (inv(s) ==> canConsumeFlow(s, provider, token) ==> alwaysOwnerBindingIdentityUnique(consumeFlow(s, provider, token)))
  ensures (inv(s) ==> canConsumeFlow(s, provider, token) ==> alwaysFlowAliasesUnique(consumeFlow(s, provider, token)))
{
  if inv(s) && canConsumeFlow(s, provider, token) {
    StoreAlwaysFlowAliasesUniqueView(s);
    StoreAlwaysFlowAliasesUniqueView(consumeFlow(s, provider, token));
    StoreMappedFlow(s.flows, consumeFlow(s, provider, token).flows);
  }
}

lemma updateFlow_ensures(s: ConnectorStore, provider: string, id: string, updated: FlowValue)
  ensures (inv(s) ==> alwaysAccountIdentityUnique(updateFlow(s, provider, id, updated)))
  ensures (inv(s) ==> alwaysOwnerBindingIdentityUnique(updateFlow(s, provider, id, updated)))
  ensures (inv(s) ==> alwaysFlowAliasesUnique(updateFlow(s, provider, id, updated)))
{
  if inv(s) {
    StoreAlwaysFlowAliasesUniqueView(s);
    StoreAlwaysFlowAliasesUniqueView(updateFlow(s, provider, id, updated));
    StoreMappedFlow(s.flows, updateFlow(s, provider, id, updated).flows);
  }
}

lemma createFlow_ensures(s: ConnectorStore, value: FlowValue)
  ensures (inv(s) ==> canCreateFlow(s, value) ==> alwaysAccountIdentityUnique(createFlow(s, value)))
  ensures (inv(s) ==> canCreateFlow(s, value) ==> alwaysOwnerBindingIdentityUnique(createFlow(s, value)))
  ensures (inv(s) ==> canCreateFlow(s, value) ==> alwaysFlowAliasesUnique(createFlow(s, value)))
{
  if inv(s) && canCreateFlow(s, value) {
    StoreAlwaysFlowAliasesUniqueView(s);
    StoreAlwaysFlowAliasesUniqueView(createFlow(s, value));
    StoreAppendFlow(s.flows, FlowEntry(value, false));
  }
}

lemma reinsertFlow_ensures(s: ConnectorStore, value: FlowValue)
  ensures (inv(s) ==> canReinsertFlow(s, value) ==> alwaysAccountIdentityUnique(reinsertFlow(s, value)))
  ensures (inv(s) ==> canReinsertFlow(s, value) ==> alwaysOwnerBindingIdentityUnique(reinsertFlow(s, value)))
  ensures (inv(s) ==> canReinsertFlow(s, value) ==> alwaysFlowAliasesUnique(reinsertFlow(s, value)))
{
  if inv(s) && canReinsertFlow(s, value) {
    StoreAlwaysFlowAliasesUniqueView(s);
    var after := reinsertFlow(s, value);
    StoreAlwaysFlowAliasesUniqueView(after);
    if exists prior :: prior in s.flows && prior.value.provider == value.provider && prior.value.id == value.id {
      StoreFlowPositions(s.flows);
      assert |after.flows| == |s.flows|;
      forall i, j | 0 <= i < |after.flows| && 0 <= j < |after.flows| && i != j
        ensures !((after.flows[j].value.provider == after.flows[i].value.provider) && ((((after.flows[j].value.id == after.flows[i].value.id) || (after.flows[j].value.token == after.flows[i].value.token)) || (after.flows[j].value.id == after.flows[i].value.token)) || (after.flows[j].value.token == after.flows[i].value.id)))
      {
        var left := s.flows[i];
        var right := s.flows[j];
        var changedLeft := left.value.provider == value.provider && left.value.id == value.id;
        var changedRight := right.value.provider == value.provider && right.value.id == value.id;
        assert !(changedLeft && changedRight);
        if changedLeft {
          assert right.value.provider != value.provider || right.value.id != value.id;
        } else if changedRight {
          assert left.value.provider != value.provider || left.value.id != value.id;
        }
      }
      StoreFlowCounts(after.flows);
    } else {
      StoreAppendFlow(s.flows, FlowEntry(value, false));
    }
  }
}
