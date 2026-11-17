# Model providers

Model providers are thin plugins that reach a hosted model with a
credential, or the cloud's inference routing, and count tokens with lazily
loaded encoders. Provider precedence is applied again after every additive
registration; choosing among admitted providers is in
[model selection](../host/models.md).

## Story: Admit model providers by credential and routing

> As the owner of a branded deployment, my agent uses a hosted model only
> when it has a key for it, and the cloud takes over inference only when I
> routed inference to it.

### A provider is admitted only with a usable credential

A credential that is present but unusable admits nothing.

```quint
pure def providerAdmitted(credentialPresent: bool, credentialUsable: bool): bool = credentialPresent and credentialUsable
pure def lawUnusableCredentialAdmitsNothing(credentialPresent: bool): bool =
  not(providerAdmitted(credentialPresent, false))
```

### The cloud displaces a direct provider only when routing uses it and it holds a usable key or a managed container

A provisioned cloud credential alone does not make the cloud the inference
owner: the active inference topology must route to it as well.

```quint
pure def cloudInferenceOwnsProvider(topologyUsesCloud: bool, usableKey: bool, managedContainer: bool): bool =
  topologyUsesCloud and (usableKey or managedContainer)
pure def lawCloudCannotDisplaceWithoutRouting(usableKey: bool, managedContainer: bool): bool =
  not(cloudInferenceOwnsProvider(false, usableKey, managedContainer))
pure def lawProvisionedCredentialAloneIsNotOwnership(topologyUsesCloud: bool): bool =
  not(cloudInferenceOwnsProvider(topologyUsesCloud, false, false))
```

### A deployment bound to the owner's cloud account admits no other model provider

When the runtime profile binds inference to the owner's cloud account, a
direct provider is not admitted even with a usable credential, so a model
call reaches the cloud account or fails; it never falls back to another
provider or to a model on the device.

```quint
type ProviderKind = CloudAccountProvider | DirectProvider | DeviceModelProvider
pure def providerLoads(cloudBound: bool, kind: ProviderKind, credentialPresent: bool, credentialUsable: bool): bool =
  if (cloudBound) kind == CloudAccountProvider and providerAdmitted(credentialPresent, credentialUsable)
  else kind == DeviceModelProvider or providerAdmitted(credentialPresent, credentialUsable)
pure def lawCloudBoundDeploymentLoadsOnlyTheCloudAccount(kind: ProviderKind, credentialPresent: bool, credentialUsable: bool): bool =
  providerLoads(true, kind, credentialPresent, credentialUsable) implies kind == CloudAccountProvider
```

## Story: Load a tokenizer once per encoding

> As the owner, counting tokens never loads the same encoder twice at once,
> and one failed load does not break counting for good.

### Callers of one encoding share its pending load, and each caller's result is its load's result

Encoders are loaded lazily and cached per encoding: callers waiting on the
same encoding share one load and see its result. A caller waits on one
encoder at a time, and each load has its own number, issued once and never
reused.

```quint
type LoadPhase = LoadPending | LoadRejecting | LoadReady | LoadFailed
type WaitPhase = Waiting | Resolved | Failed
type EncoderLoad = { load: int, encoding: int, phase: LoadPhase }
type EncoderWait = { caller: int, encoding: int, load: int, phase: WaitPhase }
type Tokenizers = { slots: List[int], loads: List[EncoderLoad], waits: List[EncoderWait], nextLoad: int }
pure val initial: Tokenizers = { slots: List(-1, -1), loads: List(), waits: List(), nextLoad: 0 }
pure val encodingValues = Set(0, 1)
pure val callerValues = Set(0, 1, 2, 3)
pure val loadValues = Set(0, 1, 2, 3)
pure val noLoad: EncoderLoad = { load: -1, encoding: -1, phase: LoadFailed }
pure def loadAt(t: Tokenizers, load: int): EncoderLoad = t.loads.select(l => l.load == load).nthOr(0, noLoad)
pure def slotOf(t: Tokenizers, encoding: int): int = t.slots.nthOr(encoding, -1)
pure def withSlot(slots: List[int], encoding: int, load: int): List[int] = List(if (encoding == 0) load else slots.nthOr(0, -1), if (encoding == 1) load else slots.nthOr(1, -1))
pure def canRequestEncoder(t: Tokenizers, caller: int, encoding: int): bool =
  encoding >= 0 and encoding < 2 and caller >= 0 and not(t.waits.some(w => w.caller == caller and w.phase == Waiting))
pure def requestEncoder(t: Tokenizers, caller: int, encoding: int): Tokenizers = {
  val hit = slotOf(t, encoding) >= 0
  val load = if (hit) slotOf(t, encoding) else t.nextLoad
  { ...t, slots: withSlot(t.slots, encoding, load),
    loads: if (hit) t.loads else t.loads.append({ load: load, encoding: encoding, phase: LoadPending }),
    nextLoad: if (hit) t.nextLoad else t.nextLoad + 1,
    waits: t.waits.select(w => w.caller != caller).append({ caller: caller, encoding: encoding, load: load, phase: Waiting }) }
}
pure def canObserveEncoder(t: Tokenizers, caller: int): bool =
  t.waits.some(w => w.caller == caller and w.phase == Waiting and (loadAt(t, w.load).phase == LoadReady or loadAt(t, w.load).phase == LoadFailed))
pure def observeEncoder(t: Tokenizers, caller: int): Tokenizers =
  { ...t, waits: t.waits.listMap(w => if (w.caller == caller and w.phase == Waiting) { ...w, phase: if (loadAt(t, w.load).phase == LoadReady) Resolved else Failed } else w) }
pure def alwaysCallersOwnTheirLoad(t: Tokenizers): bool =
  t.waits.every(w => loadAt(t, w.load).load == w.load and loadAt(t, w.load).encoding == w.encoding and
    (w.phase == Resolved implies loadAt(t, w.load).phase == LoadReady) and (w.phase == Failed implies loadAt(t, w.load).phase == LoadFailed))
pure def alwaysLoadNumbersAreIssuedOnce(t: Tokenizers): bool =
  t.nextLoad >= 0 and t.loads.every(l => l.load >= 0 and l.load < t.nextLoad and t.loads.select(o => o.load == l.load).length() == 1)
pure def alwaysOneWaitPerCaller(t: Tokenizers): bool =
  t.waits.every(w => t.waits.select(v => v.caller == w.caller).length() == 1)
pure def sometimesTwoCallersShareALoad(t: Tokenizers): bool = t.waits.some(a => t.waits.some(b => a.caller != b.caller and a.load == b.load and a.phase == Waiting and b.phase == Waiting))
```

### A slot names only a live load of its own encoding, and every live load is its encoding's slot

A failed load is evicted from its own slot only, so the next caller
retries. A rejected load is evicted only after its rejection handler ran; a caller
that joined the rejected load in between still sees the failure.

```quint
pure def retained(phase: LoadPhase): bool = phase == LoadPending or phase == LoadRejecting or phase == LoadReady
pure def canFinishLoad(t: Tokenizers, load: int, ok: bool): bool = loadAt(t, load).phase == LoadPending
pure def finishLoad(t: Tokenizers, load: int, ok: bool): Tokenizers =
  { ...t, loads: t.loads.listMap(l => if (l.load == load) { ...l, phase: if (ok) LoadReady else LoadRejecting } else l) }
pure def canClearRejection(t: Tokenizers, load: int): bool = loadAt(t, load).phase == LoadRejecting
pure def clearRejection(t: Tokenizers, load: int): Tokenizers = {
  val encoding = loadAt(t, load).encoding
  { ...t, slots: if (slotOf(t, encoding) == load) withSlot(t.slots, encoding, -1) else t.slots,
    loads: t.loads.listMap(l => if (l.load == load) { ...l, phase: LoadFailed } else l) }
}
pure def slotCoherent(t: Tokenizers, encoding: int): bool = {
  val load = slotOf(t, encoding)
  load == -1 or (loadAt(t, load).load == load and loadAt(t, load).encoding == encoding and retained(loadAt(t, load).phase))
}
pure def alwaysCacheCoherent(t: Tokenizers): bool =
  t.slots.length() == 2 and slotCoherent(t, 0) and slotCoherent(t, 1) and
  t.loads.every(l => retained(l.phase) iff slotOf(t, l.encoding) == l.load)
pure def sometimesRetryAfterFailure(t: Tokenizers): bool =
  t.loads.some(l => l.phase == LoadFailed) and t.loads.some(l => l.phase == LoadReady and t.loads.some(f => f.phase == LoadFailed and f.encoding == l.encoding))
```
