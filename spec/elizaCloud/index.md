# Eliza Cloud plugin

An on-device plugin binds its model handlers and account information
to the canonical [Cloud service](../cloud/) and the currently signed-in
owner. The cloud owns account standing, funding, model execution, and
usage settlement. The client owns transport readiness and the presentation
of account and funding outcomes.

- [API keys](./apiKeys.md) — chat-minted API key policy, reserved prefixes, single-reveal custody, and account cache invalidation
- [Inference](./inference.md) — chat-brain slot arbitration, warming retries, uniform wire tool strictness, credit severity, and RESEARCH retirement
- [Delegation and relay](./delegation.md) — owner-consented managed Google delegation and managed gateway relay lifecycle

## Story: See which configured Cloud models can answer my request

> As the owner, I want the plugin to identify a retired model setting
> without treating a missing or unreachable catalog as permanent removal.

### The model request and readiness lookup use the same configured identity

Resolve a Cloud-specific override before a generic override, then the
service default. Return the source of that identity for diagnostics.
The catalog decoder normalizes listed IDs and qualified aliases before
presenting model IDs to the model. It does not run inference to check
readiness.

```quint
type CloudOverrideSource = CloudSetting | GenericSetting | CloudDefault
type EffectiveCloudModel = { modelId: str, suppliedBy: CloudOverrideSource }
pure def effectiveCloudModel(cloudOverride: str, genericOverride: str, serviceDefault: str): EffectiveCloudModel =
  if (cloudOverride != "") { modelId: cloudOverride, suppliedBy: CloudSetting }
  else if (genericOverride != "") { modelId: genericOverride, suppliedBy: GenericSetting }
  else { modelId: serviceDefault, suppliedBy: CloudDefault }
pure def lawCloudSpecificSettingWins(cloudOverride: str, genericOverride: str, serviceDefault: str): bool =
  cloudOverride != "" implies effectiveCloudModel(cloudOverride, genericOverride, serviceDefault).modelId == cloudOverride
```

### Only a loaded nonempty catalog establishes a missing model

An unavailable, empty, or not-yet-loaded snapshot leaves readiness
unknown. On a known snapshot, identify whether the effective small
model, large model, or both are absent.

```quint
type CatalogState = CatalogNotLoaded | CatalogUnavailable | CatalogSnapshot
type TextReadiness = UnknownTextModels | TextModelsAvailable | SmallUnavailable | LargeUnavailable | BothUnavailable
pure def cloudTextReadiness(catalog: CatalogState, identifiers: List[str], smallId: str, largeId: str): TextReadiness =
  if (catalog != CatalogSnapshot or identifiers.length() == 0) UnknownTextModels
  else if (identifiers.includes(smallId)) { if (identifiers.includes(largeId)) TextModelsAvailable else LargeUnavailable }
  else if (identifiers.includes(largeId)) SmallUnavailable
  else BothUnavailable
pure def lawEmptyCatalogIsUnknown(catalog: CatalogState, smallId: str, largeId: str): bool =
  cloudTextReadiness(catalog, List(), smallId, largeId) == UnknownTextModels
```

## Story: Read account state and use Cloud under my current connection

> As the owner, I want account status, funding and model calls for my own
> connected account, with a stale response ignored after I reconnect.

### Credential authority binds the exact owner and service origin

Credentials remain in the canonical Cloud client's custody. The shell
validates configured Cloud origins and the identity of authenticated
connections. Account, credit and remote-operation replies accepted here
must match the current account, origin and connection epoch. Logging out
clears displayed data.

```quint
type CloudLink = { accountId: str, originId: str, epoch: int }
type CloudObservation = ProfileSummary | CreditSummary | AccountKeys | AgentInventory
type CloudView = { link: CloudLink, profileReady: bool, creditsReady: bool, keysReady: bool, inventoryReady: bool }
pure val emptyCloudLink: CloudLink = { accountId: "", originId: "", epoch: 0 }
pure val initial: CloudView = { link: emptyCloudLink, profileReady: false, creditsReady: false, keysReady: false, inventoryReady: false }
pure def canAttachCloud(s: CloudView, accountId: str, originId: str, epoch: int, originAllowed: bool): bool =
  accountId != "" and originId != "" and epoch > s.link.epoch and originAllowed
pure def attachCloud(s: CloudView, accountId: str, originId: str, epoch: int, originAllowed: bool): CloudView =
  { ...initial, link: { accountId: accountId, originId: originId, epoch: epoch } }
pure def canDetachCloud(s: CloudView): bool = s.link.accountId != ""
pure def detachCloud(s: CloudView): CloudView =
  { ...initial, link: { ...emptyCloudLink, epoch: s.link.epoch } }
pure def canObserveCloud(s: CloudView, accountId: str, originId: str, epoch: int): bool =
  s.link.accountId != "" and s.link.accountId == accountId and s.link.originId == originId and s.link.epoch == epoch
pure def observeCloud(s: CloudView, accountId: str, originId: str, epoch: int, observation: CloudObservation): CloudView =
  match observation {
    | ProfileSummary => { ...s, profileReady: true }
    | CreditSummary => { ...s, creditsReady: true }
    | AccountKeys => { ...s, keysReady: true }
    | AgentInventory => { ...s, inventoryReady: true }
  }
pure def alwaysSignedOutCloudHasNoObservations(s: CloudView): bool =
  s.link.accountId == "" implies not(s.profileReady or s.creditsReady or s.keysReady or s.inventoryReady)
pure def stepCloudEpochNeverRewinds(before: CloudView, after: CloudView): bool = before.link.epoch <= after.link.epoch
pure def sometimesCloudCreditVisible(s: CloudView): bool = s.creditsReady
pure val eval_witness_sometimesCloudCreditVisible = (("attachCloud", "owner", "cloud", 1, true), ("observeCloud", "owner", "cloud", 1, CreditSummary))
pure val accountIdValues = Set("", "owner", "other")
pure val originIdValues = Set("", "cloud", "outside")
```

### Funding links are scoped to the current account and approved destination

The UI may display balance, account status, and provider funding options.
Checkout helpers return only a parsed secure destination for the account's
bound checkout. An expired connection cannot open it. The client presents
the exact quote and delegates funding to Cloud.

```quint
pure def mayOpenCloudFunding(link: CloudLink, boundAccount: str, checkedOrigin: str, suppliedEpoch: int, secureCheckout: bool): bool =
  link.accountId != "" and link.accountId == boundAccount and link.originId == checkedOrigin and
    link.epoch == suppliedEpoch and secureCheckout
pure val linkValues: Set[CloudLink] = Set(
  emptyCloudLink,
  { accountId: "owner", originId: "cloud", epoch: 1 },
  { accountId: "other", originId: "cloud", epoch: 3 })
pure val boundAccountValues = Set("", "owner", "other")
pure val checkedOriginValues = Set("", "cloud", "outside")
pure def lawExpiredCloudFundingRefuses(link: CloudLink, boundAccount: str, checkedOrigin: str, suppliedEpoch: int, secureCheckout: bool): bool =
  suppliedEpoch != link.epoch implies not(mayOpenCloudFunding(link, boundAccount, checkedOrigin, suppliedEpoch, secureCheckout))
```
