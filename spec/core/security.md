# Content and outbound security

This library decides what keeps untrusted content and outbound data inside their boundaries: which addresses may be fetched, which environment keys a spawned process inherits, how log fields and secrets are redacted, and when outbound text is blocked. The fetch that applies the address decision is [media](./media.md); PII scrubbing is [privacy](./privacy.md); which processing a confidential request may use is [processing policy](./processingPolicy.md).

## Story: Admit content and outbound data

> As a user, I want the agent never to fetch an internal address on an
> attacker's behalf, never to hand a child process an environment that
> changes what it runs, never to write my secrets into a log and never to
> send me its own prompt armor, so that content it reads cannot turn it
> against me or my network.

### A blocked address is never fetched

A host is screened before any connection. Unless the caller's policy allows the private network or names the host explicitly, a blocked hostname, such as `localhost` or an internal domain, is refused, and so is a host any of whose resolved addresses is loopback, private, link-local or a cloud metadata address, including an IPv4 address embedded in an IPv6 transition form. A host that resolves to nothing is refused. The connection then uses only the addresses screened, so a DNS answer that changes afterwards cannot redirect it.

```quint
type AddressClass = PublicAddress | LoopbackAddress | PrivateAddress | LinkLocalAddress | MetadataAddress
type SsrfPolicy = { allowPrivateNetwork: bool, hostAllowed: bool }
type FetchDecision = FetchRefused | FetchPinned({ addresses: List[AddressClass] })
pure val policyValues = Set({ allowPrivateNetwork: false, hostAllowed: false }, { allowPrivateNetwork: true, hostAllowed: false }, { allowPrivateNetwork: false, hostAllowed: true })
pure val resolvedValues = Set(List(), List(PublicAddress), List(PublicAddress, PrivateAddress), List(MetadataAddress), List(LoopbackAddress), List(LinkLocalAddress, PublicAddress))
pure def screened(policy: SsrfPolicy): bool = not(policy.allowPrivateNetwork or policy.hostAllowed)
pure def screenFetch(policy: SsrfPolicy, blockedName: bool, resolved: List[AddressClass]): FetchDecision =
  if (resolved.length() == 0) FetchRefused
  else if (screened(policy) and (blockedName or resolved.some(a => a != PublicAddress))) FetchRefused
  else FetchPinned({ addresses: resolved })
pure def connects(decision: FetchDecision): bool = match decision { | FetchPinned(p) => true | _ => false }
pure def pinnedTo(decision: FetchDecision): List[AddressClass] = match decision { | FetchPinned(p) => p.addresses | _ => List() }
pure def lawBlockedAddressIsNeverFetched(policy: SsrfPolicy, blockedName: bool, resolved: List[AddressClass]): bool =
  (screened(policy) and connects(screenFetch(policy, blockedName, resolved))) implies (not(blockedName) and pinnedTo(screenFetch(policy, blockedName, resolved)).every(a => a == PublicAddress))
pure def lawUnresolvedHostIsRefused(policy: SsrfPolicy, blockedName: bool): bool = not(connects(screenFetch(policy, blockedName, List())))
pure def lawConnectionUsesTheScreenedAddresses(policy: SsrfPolicy, blockedName: bool, resolved: List[AddressClass]): bool =
  connects(screenFetch(policy, blockedName, resolved)) implies pinnedTo(screenFetch(policy, blockedName, resolved)) == resolved
```

### A spawned process never inherits a blocked environment key

Before a child process starts, its environment loses every key that could change what it loads or runs: dynamic loader hooks, interpreter and library search paths, shell startup files, package manager and container tool configuration, and proxy and certificate trust settings, matched by upper-cased name or listed prefix. Every other key passes unchanged.

```quint
type EnvFamily = OrdinaryKey | LoaderHookKey | InterpreterPathKey | ShellStartupKey | ToolchainConfigKey | ProxyOrTrustKey
type EnvEntry = { name: str, family: EnvFamily, processOnly: bool }
pure val envValues = Set(
  List(),
  List({ name: "LANG", family: OrdinaryKey, processOnly: false }, { name: "LD_PRELOAD", family: LoaderHookKey, processOnly: false }),
  List({ name: "NODE_OPTIONS", family: InterpreterPathKey, processOnly: false }, { name: "API_PORT", family: OrdinaryKey, processOnly: false }, { name: "HTTPS_PROXY", family: ProxyOrTrustKey, processOnly: false }),
  List({ name: "BASH_ENV", family: ShellStartupKey, processOnly: false }, { name: "NPM_CONFIG_PREFIX", family: ToolchainConfigKey, processOnly: false })
)
pure def blockedForSpawn(e: EnvEntry): bool = e.family != OrdinaryKey
pure def sanitizeSpawnEnv(env: List[EnvEntry]): List[EnvEntry] = env.select(e => not(blockedForSpawn(e)))
pure def lawSpawnEnvHoldsNoBlockedKey(env: List[EnvEntry]): bool = sanitizeSpawnEnv(env).every(e => not(blockedForSpawn(e)))
pure def lawSpawnEnvKeepsOrdinaryKeys(env: List[EnvEntry]): bool = env.every(e => blockedForSpawn(e) or sanitizeSpawnEnv(env).includes(e))
```

### A process-only key never comes from configuration

Keys that admit a confidential runtime, a protected profile or a private host endpoint are read only from the measured process environment. A configuration file or an API write that names one is ignored, even at boot when the process left it unset, so configuration can never relax them.

```quint
type EnvSource = ProcessEnvironment | ConfigurationFile | ApiWrite
pure val entryValues = Set({ name: "LANG", family: OrdinaryKey, processOnly: false }, { name: "PROTECTED_PROFILE", family: OrdinaryKey, processOnly: true })
pure def acceptsEnvWrite(entry: EnvEntry, source: EnvSource): bool = source == ProcessEnvironment or not(entry.processOnly)
pure def lawConfigurationNeverSuppliesAProcessOnlyKey(entry: EnvEntry, source: EnvSource): bool =
  (entry.processOnly and source != ProcessEnvironment) implies not(acceptsEnvWrite(entry, source))
```

### A secret never appears in a log line

Before a log line is written, a field whose name marks it sensitive, or whose value contains a known secret or matches a credential pattern, has its value replaced by a redaction marker. A field that cannot be read, such as one behind a throwing getter, is written as a distinct failure marker, never as its value. Classification happens at the sink; a caller cannot mark a field safe to bypass masking. Other fields are written as they are.

```quint
type LogField = { name: str, sensitiveName: bool, containsSecret: bool, unreadable: bool, value: str }
pure val redactionMarker = "[REDACTED]"
pure val unreadableMarker = "[REDACTION_FAILED]"
pure val logFieldsValues = Set(
  List(),
  List({ name: "apiKey", sensitiveName: true, containsSecret: true, unreadable: false, value: "k-123" }, { name: "room", sensitiveName: false, containsSecret: false, unreadable: false, value: "lobby" }),
  List({ name: "text", sensitiveName: false, containsSecret: true, unreadable: false, value: "token k-123" }, { name: "hostile", sensitiveName: false, containsSecret: false, unreadable: true, value: "" })
)
pure def mustRedact(f: LogField): bool = f.sensitiveName or f.containsSecret or f.unreadable
pure def redactLine(logFields: List[LogField]): List[LogField] = logFields.listMap(f => if (f.unreadable) { ...f, value: unreadableMarker } else if (mustRedact(f)) { ...f, value: redactionMarker } else f)
pure def lawLoggedSecretsAreRedacted(logFields: List[LogField]): bool = redactLine(logFields).every(f => not(mustRedact(f)) or f.value == (if (f.unreadable) unreadableMarker else redactionMarker))
pure def lawOrdinaryFieldsAreLoggedUnchanged(logFields: List[LogField]): bool = logFields.every(f => mustRedact(f) or redactLine(logFields).includes(f))
```

### Outbound text carrying the content envelope is blocked

Untrusted content reaches the model wrapped in a security envelope that is prompt armor, never meant for a person. A reply about to be sent that contains envelope material, in any spelling, partial or quoted, is not sent: a short notice replaces it, and the blocked text goes only to the error report.

```quint
type OutboundText = { text: str, envelopeMaterial: bool }
type Delivery = { text: str, blocked: bool }
pure val leakNotice = "an internal formatting leak was stopped"
pure val outboundValues = Set({ text: "hello", envelopeMaterial: false }, { text: "<<external>>", envelopeMaterial: true })
pure def deliver(outbound: OutboundText): Delivery = if (outbound.envelopeMaterial) { text: leakNotice, blocked: true } else { text: outbound.text, blocked: false }
pure def lawEnvelopeMaterialIsNeverDelivered(outbound: OutboundText): bool =
  outbound.envelopeMaterial implies (deliver(outbound).blocked and deliver(outbound).text == leakNotice)
pure def lawCleanTextIsDeliveredUnchanged(outbound: OutboundText): bool = not(outbound.envelopeMaterial) implies deliver(outbound) == { text: outbound.text, blocked: false }
```

### The first positive detection trips the stream and reports once

A streamed reply is checked against everything it has produced so far. The first chunk that brings envelope material trips the stream: it is reported once and nothing more is forwarded, whatever later chunks hold.

```quint
type EnvelopeLatch = { tripped: bool, reports: int, forwarded: int }
pure val latchValues = Set({ tripped: false, reports: 0, forwarded: 0 }, { tripped: false, reports: 0, forwarded: 2 }, { tripped: true, reports: 1, forwarded: 1 })
pure def observeChunk(latch: EnvelopeLatch, soFarHasEnvelope: bool): EnvelopeLatch =
  if (latch.tripped) latch
  else if (soFarHasEnvelope) { ...latch, tripped: true, reports: latch.reports + 1 }
  else { ...latch, forwarded: latch.forwarded + 1 }
pure def reportsOnce(latch: EnvelopeLatch): bool = latch.reports == (if (latch.tripped) 1 else 0)
pure def lawLatchReportsOnce(latch: EnvelopeLatch, soFarHasEnvelope: bool): bool = reportsOnce(latch) implies reportsOnce(observeChunk(latch, soFarHasEnvelope))
pure def lawTripForwardsNothingMore(latch: EnvelopeLatch, soFarHasEnvelope: bool): bool = latch.tripped implies observeChunk(latch, soFarHasEnvelope) == latch
pure def lawDetectionTrips(latch: EnvelopeLatch): bool = not(latch.tripped) implies (observeChunk(latch, true).tripped and observeChunk(latch, true).forwarded == latch.forwarded)
```

## Story: Trust only a request from this machine

> As the owner, I want my agent to accept a request without a token only
> when it really comes from my own machine, so that a request relayed by a
> proxy from another machine is never trusted as mine.

### Every element of a proxy client header must name this machine for a request to be trusted as local

A request is trusted as coming from this machine only when its peer is a
loopback address and no proxy client header names another client. A
`Forwarded` header is read by its `for=` pairs. Every other client header
(`X-Forwarded-For`, `X-Real-IP` and the like) is read element by element
between commas: an element that holds a `for=` pair is read by that pair,
and any other element is read as an address on its own. A proxy on this
machine appends the address it saw as a plain element after whatever the
client sent, so a `for=` element never hides the plain elements next to
it: "for=127.0.0.1, 203.0.113.5" and "for=\"[::1]:4000\", 2001:db8::7" are
refused. An element that is neither a `for=` pair nor an address, such
as "xfor=127.0.0.1", refuses trust; an empty element, "unknown" or an
obfuscated identifier names no client. "for=127.0.0.1, ::1" names only
this machine and keeps its trust.

```quint
type ProxyElement = LoopbackElement | NeutralElement | RemoteElement | UnparseableElement
pure def headerAllowsLocalTrust(proxyElements: List[ProxyElement]): bool =
  proxyElements.every(e => e == LoopbackElement or e == NeutralElement)
pure def trustedAsLocal(loopbackPeer: bool, proxyElements: List[ProxyElement]): bool = loopbackPeer and headerAllowsLocalTrust(proxyElements)
pure val proxyElementsValues = Set(List(), List(LoopbackElement), List(LoopbackElement, RemoteElement), List(LoopbackElement, LoopbackElement),
  List(NeutralElement), List(LoopbackElement, UnparseableElement), List(RemoteElement, LoopbackElement))
pure def lawARemoteOrUnparseableElementRefusesTrust(loopbackPeer: bool, proxyElements: List[ProxyElement]): bool =
  proxyElements.some(e => e == RemoteElement or e == UnparseableElement) implies not(trustedAsLocal(loopbackPeer, proxyElements))
pure def lawOnlyThisMachineKeepsTrust(proxyElements: List[ProxyElement]): bool =
  proxyElements.every(e => e == LoopbackElement) implies trustedAsLocal(true, proxyElements)
pure def lawARemotePeerIsNeverTrusted(proxyElements: List[ProxyElement]): bool = not(trustedAsLocal(false, proxyElements))
```
