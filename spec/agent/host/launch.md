# Launch contract

The process contract between the agent and the host that starts it: the
launch document, the launch frame on stdin and the exit-code table. The host
runs `agent.mjs serve --launch <file> --state <dir> (--socket <path> | --http 127.0.0.1:<port>)`.
This library has no state and no opaque function, so the agent process, the
model binding and the os agent service import it.

The document is JSON, schema 1, decoded whole by `launch.schema.vibe`, which
holds the full field list: `character` (`name`, `system`; optional `bio`,
`adjectives`, `style`, `messageExamples`), `policy`, `model` (`backend`,
`cloudBaseUrl`, `smallModel`, `largeModel`, `imageModel`, `ownKeyBaseUrl`,
`ownKeySmall`, `ownKeyLarge`), `account`, `embeddings` and
`embeddingDimensions`, `persistMemory` (default false: the store is in
memory), `callerRole`, `views`, `timeZone`, `privacy {secretSwap, piiSwap}`,
`google {gmailChanges, calendarEdits}` (default false),
`workflowWorker {runtimeDir, executable, sha256}`, `retention`,
`hostContextRevision` and `environment`. It carries no `agentId`: the store
creates and keeps that identity in the `--state` directory. Facts that need
string parsing (a URL's form, an environment key's class, a trimmed length,
an IANA zone, a digest's shape) are decided by the schema; those a rule
here needs appear below as fields. The workflow worker and privacy switches
are checked by the plugin plan, which owns them. Source: the pinned `EmbeddedAgentConfig.java` (character, cloud
origin, environment, allow list, in-memory default) and the launch settings
of the device hosts it replaces.

Schema 1 sends `callerRole` as `owner` or `user` and uses `own-key` for
the supplied-key model backend. The optional product plugin sits at
`policy.plugins.product` and an optional `hostContextRevision` is a
positive integer. Host and executable use this representation for both
new installs and existing launch documents.

## Story: Start the agent from one launch document

> As the host that starts my agent, I want to hand it one launch document
> that it accepts whole or refuses whole, so that it never runs on half of
> my configuration.

### The launch document is accepted whole or refused whole

A document is admitted only when it is schema 1 and every part below is
admitted. The character needs a trimmed name of 1 to 50 units and a
nonblank system prompt. Chat callers act as the owner or as a user.

```quint
import authorization as Z from "../../core/authorization"
type Character = { name: str, nameUnits: int, systemBlank: bool }
type UrlShape = HttpsOrigin | HttpsWithPath | NotHttps
type OwnerAccount = SignedIn({ userId: str, organizationId: str }) | NoAccount
type Backend =
  | CloudBackend({ baseUrl: str, baseUrlShape: UrlShape, smallModel: str, largeModel: str, imageModel: str })
  | OwnKeyBackend({ baseUrl: str, baseUrlShape: UrlShape, smallModel: str, largeModel: str })
  | NoBackend
type Embeddings = LocalEmbeddings({ dimensions: int }) | NoEmbeddings
type ProductPlugin = NamedProductPlugin({ name: str }) | NoProductPlugin
type LaunchPolicy = { actionsAllowed: Set[str], pluginsLoad: List[str], productPlugin: ProductPlugin }
type CallerRole = ChatAsOwner | ChatAsUser
type EnvKeyKind = PluginSetting | ReservedKey | MalformedKey
type EnvEntry = { key: str, keyKind: EnvKeyKind, singleLine: bool }
type Retention = PruneLogs({ dayThousandths: int, maxRowsPerRoom: int, intervalMinutes: int }) | KeepLogs
type GoogleConsent = { gmailChanges: bool, calendarEdits: bool }
type LaunchDocument = { schema: int, character: Character, policy: LaunchPolicy, backend: Backend, account: OwnerAccount, embeddings: Embeddings, persistMemory: bool, callerRole: CallerRole, google: GoogleConsent, retention: Retention, environment: List[EnvEntry] }
pure def chatRole(r: CallerRole): Z::Role = if (r == ChatAsOwner) Z::Owner else Z::User
pure def characterAdmitted(c: Character): bool = c.nameUnits >= 1 and c.nameUnits <= 50 and not(c.systemBlank)
pure def documentAdmitted(doc: LaunchDocument): bool =
  doc.schema == 1 and characterAdmitted(doc.character) and policyAdmitted(doc.policy) and backendAdmitted(doc.backend, doc.account)
    and embeddingsAdmitted(doc.embeddings) and retentionAdmitted(doc.retention) and environmentAdmitted(doc.environment)
```

### The launch names every action the agent may run, so an action it does not name is refused for every caller

`policy.actions.allowed` is a nonempty set of nonempty names, and the agent
always hands it to core as a set product allowlist: there is no launch
without one, and core's boot check then refuses any name no plugin
registered. `policy.plugins.load` is ordered and names each plugin once; the
optional product plugin is not also in that list. Whether each name is a
plugin of the bundle is checked at plugin load.

```quint
import actionPlanning as AP from "../../core/actionPlanning"
pure def productPluginAdmitted(product: ProductPlugin, load: List[str]): bool = match product {
  | NamedProductPlugin(x) => x.name != "" and not(load.includes(x.name))
  | NoProductPlugin => true
}
pure def policyAdmitted(p: LaunchPolicy): bool =
  p.actionsAllowed.size() > 0 and not(p.actionsAllowed.contains("")) and not(p.pluginsLoad.includes(""))
    and p.pluginsLoad.every(n => p.pluginsLoad.select(m => m == n).length() == 1) and productPluginAdmitted(p.productPlugin, p.pluginsLoad)
pure def productAllowlist(p: LaunchPolicy): AP::ProductAllowlist = { set: true, names: p.actionsAllowed }
pure def allowlistSetting(p: LaunchPolicy): AP::AllowlistSetting = { present: true, blank: false, parses: true, names: p.actionsAllowed }
pure val pValues = Set(
  { actionsAllowed: Set("REPLY"), pluginsLoad: List("inbox"), productPlugin: NoProductPlugin },
  { actionsAllowed: Set("REPLY", "CALCULATE"), pluginsLoad: List("inbox", "calendar"), productPlugin: NamedProductPlugin({ name: "product" }) },
  { actionsAllowed: Set(), pluginsLoad: List(), productPlugin: NoProductPlugin },
  { actionsAllowed: Set("REPLY"), pluginsLoad: List("inbox", "inbox"), productPlugin: NoProductPlugin },
  { actionsAllowed: Set("REPLY"), pluginsLoad: List("product"), productPlugin: NamedProductPlugin({ name: "product" }) })
pure val actionNameValues = Set("REPLY", "CALCULATE", "SEND_EMAIL")
pure val registeredValues = Set(Set("REPLY"), Set("REPLY", "CALCULATE"), Set("SEND_EMAIL"))
pure def lawLaunchAllowlistRefusesUnnamedActions(p: LaunchPolicy, actionName: str): bool =
  not(p.actionsAllowed.contains(actionName)) implies not(AP::productAllows(productAllowlist(p), actionName))
pure def lawAdmittedPolicyBootsOnlyWhenEveryNameIsRegistered(p: LaunchPolicy, registered: Set[str]): bool =
  policyAdmitted(p) implies (AP::allowlistBoot(allowlistSetting(p), registered) == AP::AllowlistAdmitted iff p.actionsAllowed.subseteq(registered))
```

### Text goes to the owner's cloud account, the owner's own key, or nowhere

There is no local text backend. `cloudBaseUrl` is an HTTPS origin with no
path, query or fragment (the cloud client builds the `/api/v1/...` paths),
and a cloud launch names the signed-in `account`, whose store it opens;
empty cloud model names leave the choice to cloud. An own key needs an HTTPS
base URL, which may have a path, and both model names. Local embeddings need
a positive dimension.

```quint
pure def backendAdmitted(b: Backend, account: OwnerAccount): bool = match b {
  | CloudBackend(c) => c.baseUrlShape == HttpsOrigin and accountNamed(account)
  | OwnKeyBackend(k) => k.baseUrlShape != NotHttps and k.smallModel != "" and k.largeModel != ""
  | NoBackend => true
}
pure def accountNamed(account: OwnerAccount): bool = match account {
  | SignedIn(a) => a.userId != "" and a.organizationId != ""
  | NoAccount => false
}
pure def embeddingsAdmitted(e: Embeddings): bool = match e { | LocalEmbeddings(x) => x.dimensions > 0 | NoEmbeddings => true }
pure def needsCredential(b: Backend): bool = match b { | NoBackend => false | _ => true }
```

### Plugin settings never set a reserved key, and log retention bounds are positive

`environment` holds plugin settings only: a key outside `[A-Z][A-Z0-9_]*`,
one with the prefix `ELIZA_AGENT_`, `ELIZA_CLOUD_`, `ELIZA_OWN_`, `LD_` or
`NODE_`, and `PATH`, `HOME` or `TMPDIR` are refused, as is a value holding
NUL, CR or LF. Retention, when given, has a positive age (`days` as a
decimal, kept here in thousandths of a day, so 0.25 is 250), row limit and
sweep interval.

```quint
pure def environmentAdmitted(entries: List[EnvEntry]): bool = entries.every(e => e.keyKind == PluginSetting and e.singleLine)
pure def retentionAdmitted(r: Retention): bool = match r {
  | PruneLogs(x) => x.dayThousandths > 0 and x.maxRowsPerRoom > 0 and x.intervalMinutes > 0
  | KeepLogs => true
}
```

### Local embeddings boot only when the device serves them: no operator endpoint or chosen hosted service takes precedence, and the local inference plugin is listed

An operator endpoint is an `EMBEDDING_BASE_URL` in `environment`, or an
`EMBEDDING_PROVIDER` other than empty or `local`. A hosted service is chosen
by a cloud launch whose `environment` sets `ELIZAOS_CLOUD_USE_EMBEDDINGS` on.
Either one owns embeddings ahead of the device, so a launch that asks for
`local` embeddings while one of them takes precedence contradicts itself, as
does one that asks for them without listing `@elizaos/plugin-local-inference`;
both are configuration errors at boot, before anything is opened. That
plugin checks the dimension against the model it holds.

```quint
type EmbeddingServer = OperatorServed | HostedServed | DeviceServed
pure val deviceEmbeddingsPlugin = "@elizaos/plugin-local-inference"
pure def embeddingServer(operatorEndpoint: bool, cloudBackend: bool, hostedChosen: bool): EmbeddingServer =
  if (operatorEndpoint) OperatorServed else if (cloudBackend and hostedChosen) HostedServed else DeviceServed
pure def localEmbeddingsBoot(asked: bool, server: EmbeddingServer, listed: bool): bool = not(asked) or (server == DeviceServed and listed)
pure def lawAnOperatorEndpointTakesPrecedence(cloudBackend: bool, hostedChosen: bool, listed: bool): bool =
  not(localEmbeddingsBoot(true, embeddingServer(true, cloudBackend, hostedChosen), listed))
pure def lawTheDeviceServesWhenNothingElseIsChosenAndThePluginIsListed(cloudBackend: bool): bool =
  localEmbeddingsBoot(true, embeddingServer(false, cloudBackend, false), true)
pure def lawALaunchWithoutLocalEmbeddingsIsNeverRefusedHere(server: EmbeddingServer, listed: bool): bool = localEmbeddingsBoot(false, server, listed)
```

### A refused document is a configuration error, and a cloud or own-key launch without a credential is a credential error

A configuration error is decided first; a backend that needs a credential
and has none in the frame, or an own-key launch whose key is longer than
the 1,024 characters the own-key slot takes, is then refused as a
credential error. Both are decided before the store opens, so binding never
meets a key its slot refuses. A launch with no backend needs no credential.

```quint
type BootFailure = Config | Credential | Storage | Agent
type LaunchVerdict = LaunchAdmitted | LaunchRefused({ cause: BootFailure })
pure def launchVerdict(doc: LaunchDocument, f: LaunchFrame): LaunchVerdict =
  if (not(documentAdmitted(doc)) or not(frameAdmitted(f))) LaunchRefused({ cause: Config })
  else if (needsCredential(doc.backend) and not(credentialFits(doc.backend, f.credential))) LaunchRefused({ cause: Credential })
  else LaunchAdmitted
pure val ownKeyMaxUnits = 1024
pure def isOwnKey(b: Backend): bool = match b { | OwnKeyBackend(_) => true | _ => false }
pure def credentialUnits(c: FrameCredential): int = match c { | Keyed(k) => k.units | NoCredential => 0 }
pure def credentialFits(b: Backend, c: FrameCredential): bool =
  hasCredential(c) and (not(isOwnKey(b)) or credentialUnits(c) <= ownKeyMaxUnits)
pure val docValues = {
  val good: LaunchDocument = { schema: 1, character: { name: "Agent", nameUnits: 5, systemBlank: false },
    policy: { actionsAllowed: Set("REPLY"), pluginsLoad: List(), productPlugin: NoProductPlugin },
    backend: CloudBackend({ baseUrl: "https://cloud.example", baseUrlShape: HttpsOrigin, smallModel: "", largeModel: "", imageModel: "" }),
    account: SignedIn({ userId: "user1", organizationId: "org1" }), embeddings: NoEmbeddings, persistMemory: false,
    callerRole: ChatAsUser, google: { gmailChanges: false, calendarEdits: false }, retention: KeepLogs, environment: List() }
  Set(good,
    { ...good, backend: NoBackend, account: NoAccount, callerRole: ChatAsOwner, embeddings: LocalEmbeddings({ dimensions: 384 }), retention: PruneLogs({ dayThousandths: 250, maxRowsPerRoom: 200, intervalMinutes: 30 }) },
    { ...good, account: NoAccount, backend: OwnKeyBackend({ baseUrl: "https://own.example/v1", baseUrlShape: HttpsWithPath, smallModel: "small", largeModel: "large" }) },
    { ...good, backend: CloudBackend({ baseUrl: "https://cloud.example/api/v1", baseUrlShape: HttpsWithPath, smallModel: "", largeModel: "", imageModel: "" }) },
    { ...good, account: NoAccount },
    { ...good, character: { ...good.character, nameUnits: 0 } },
    { ...good, environment: List({ key: "NODE_OPTIONS", keyKind: ReservedKey, singleLine: true }) })
}
pure val fValues = Set(
  { version: 1, token: "t", epoch: 1, credential: Keyed({ version: 1, value: "k", units: 64 }), storageKey: StorageKey({ key: "s" }) },
  { version: 1, token: "t", epoch: 1, credential: Keyed({ version: 1, value: "k", units: 2048 }), storageKey: NoStorageKey },
  { version: 1, token: "t", epoch: 2, credential: NoCredential, storageKey: NoStorageKey },
  { version: 2, token: "t", epoch: 1, credential: Keyed({ version: 1, value: "k", units: 64 }), storageKey: NoStorageKey },
  { version: 1, token: "t", epoch: 1, credential: Keyed({ version: 0, value: "k", units: 64 }), storageKey: NoStorageKey })
pure def lawRefusedDocumentIsAConfigErrorWhateverTheFrame(doc: LaunchDocument, f: LaunchFrame): bool =
  not(documentAdmitted(doc)) implies launchVerdict(doc, f) == LaunchRefused({ cause: Config })
pure def lawKeylessCloudOrOwnKeyLaunchIsACredentialError(doc: LaunchDocument, f: LaunchFrame): bool =
  (documentAdmitted(doc) and frameAdmitted(f) and needsCredential(doc.backend) and not(hasCredential(f.credential))) implies launchVerdict(doc, f) == LaunchRefused({ cause: Credential })
pure def lawAnOwnKeyLongerThanItsSlotIsACredentialError(doc: LaunchDocument, f: LaunchFrame): bool =
  (documentAdmitted(doc) and frameAdmitted(f) and isOwnKey(doc.backend) and credentialUnits(f.credential) > ownKeyMaxUnits) implies launchVerdict(doc, f) == LaunchRefused({ cause: Credential })
pure def lawAnAdmittedOwnKeyLaunchFitsItsSlot(doc: LaunchDocument, f: LaunchFrame): bool =
  (launchVerdict(doc, f) == LaunchAdmitted and isOwnKey(doc.backend)) implies (hasCredential(f.credential) and credentialUnits(f.credential) <= ownKeyMaxUnits)
pure def lawLaunchWithoutBackendNeedsNoCredential(doc: LaunchDocument, f: LaunchFrame): bool =
  (documentAdmitted(doc) and frameAdmitted(f) and doc.backend == NoBackend) implies launchVerdict(doc, f) == LaunchAdmitted
```

### A phone agent without a usable system resolver resolves external names through the native host's resolvers

On Android and iOS the operating system brokers name lookups, and an agent
runtime that is not linked against Android's own C library cannot reach
that broker. Before it reads the launch, such a process points every lookup
of an external name at the resolvers the native host lists in
`ELIZA_MOBILE_DNS_SERVERS` (one to eight IP addresses, comma separated) or,
when it lists none, at Cloudflare's and Google's public resolvers, so the
pinned fetch's lookup, made when each request is made, finds them. An IP
literal or `localhost` never goes to a resolver. A runtime linked against
Android's C library keeps the system resolver, with its VPN and private DNS.
A list that is not one to eight IP addresses is a configuration error.

```quint
type ResolverHost = NativeAndroid | OtherMobile | NotMobile
type LookupName = ExternalName | LoopbackName | AddressLiteral
type LookupRoute = SystemResolver | ExplicitResolvers | NoLookup
pure val maxMobileResolvers = 8
pure def lookupRoute(host: ResolverHost, name: LookupName): LookupRoute =
  if (host != OtherMobile) SystemResolver else if (name == ExternalName) ExplicitResolvers else NoLookup
pure def resolverListAdmitted(count: int, allAddresses: bool): bool = count >= 1 and count <= maxMobileResolvers and allAddresses
pure def lawANativeAndroidRuntimeKeepsTheSystemResolver(name: LookupName): bool = lookupRoute(NativeAndroid, name) == SystemResolver
pure def lawOnlyAnExternalNameOnAPhoneWithoutResolverUsesTheListedResolvers(host: ResolverHost, name: LookupName): bool =
  (lookupRoute(host, name) == ExplicitResolvers) iff (host == OtherMobile and name == ExternalName)
```

## Story: Keep the credential out of every file and reply

> As the owner, I want my credential and the launch token handed to the
> agent only on stdin, so that no file, status, receipt or log line ever
> shows them.

### The launch frame is one stdin line with the token, the epoch, and the optional credential and storage key

The host writes one JSON line on stdin and closes it:
`{version: 1, token, epoch, credential?: {version, value}, storageKey?}`.
The credential is the cloud device key for a cloud launch and the owner's
provider key for an own-key launch; the storage key seals the task store.
The frame is admitted only at version 1 with a positive epoch and, when a
credential is given, a positive credential version; the schema refuses an
empty token or storage key, and a credential that is not 8 to 16,384
visible ASCII characters ([model binding](../models/binding.md) bounds each
slot). `units` is the credential's length in characters, which the shell
counts; it says nothing else about the value. Nothing secret arrives in a file,
and no credential arrives in the environment: a cloud launch's environment
names at most the device's mail broker and a bearer that admits only that
broker's reads ([agent data files](../../os/agentService/config.md)).

```quint
type SecretLaunchToken = str
type SecretCredential = str
type SecretStorageKey = str
type FrameCredential = Keyed({ version: int, value: SecretCredential, units: int }) | NoCredential
type FrameStorageKey = StorageKey({ key: SecretStorageKey }) | NoStorageKey
type LaunchFrame = { version: int, token: SecretLaunchToken, epoch: int, credential: FrameCredential, storageKey: FrameStorageKey }
pure def hasCredential(c: FrameCredential): bool = match c { | Keyed(_) => true | NoCredential => false }
pure def credentialVersion(f: LaunchFrame): int = {
  val credential = f.credential
  match credential { | Keyed(k) => k.version | NoCredential => 0 }
}
pure def frameAdmitted(f: LaunchFrame): bool = f.version == 1 and f.epoch >= 1 and (not(hasCredential(f.credential)) or credentialVersion(f) >= 1)
```

### Only the epoch and the credential version of a frame may be shown, never the token, the credential or the storage key

A health answer echoes the epoch, so a host can tell a stale child of an
earlier launch from the current one, and a credential push must name a
higher version than the one held. Nothing else of the frame leaves the
process: the secret types keep the token, the credential and the storage
key out of every public value, and no definition declassifies them.

```quint
type FrameView = { epoch: int, credentialVersion: int }
pure def frameView(f: LaunchFrame): FrameView = { epoch: f.epoch, credentialVersion: credentialVersion(f) }
pure def lawFrameViewIsTheSameForAnyTokenAndKey(f: LaunchFrame, token: SecretLaunchToken): bool =
  frameView({ ...f, token: token, storageKey: NoStorageKey }) == frameView(f)
pure val tokenValues = Set("t", "u")
```

## Story: Tell the supervisor why the process ended

> As the host that supervises my agent, I want each exit code to name one
> cause, so that I restart a crash and never restart a launch that cannot
> work.

### Each boot failure has one exit code, and every code outside the table is a crash

0 is a clean stop, 1 a stop in which a release failed, 78 a configuration
error, 77 a missing credential, 74 a storage failure (locked, blocked
migration, corrupt or another account's store) and 70 a runtime that failed
to initialize. Any other code, and a death by signal, is a crash. This is
the one exit table; the os supervisor maps it to its own states.

```quint
type ExitClass = Clean | ReleaseFailed | BootFailed({ cause: BootFailure }) | Crash
pure def exitCode(cause: BootFailure): int = match cause { | Config => 78 | Credential => 77 | Storage => 74 | Agent => 70 }
pure def exitClass(code: int): ExitClass =
  if (code == 0) Clean else if (code == 1) ReleaseFailed
  else if (code == 78) BootFailed({ cause: Config }) else if (code == 77) BootFailed({ cause: Credential })
  else if (code == 74) BootFailed({ cause: Storage }) else if (code == 70) BootFailed({ cause: Agent })
  else Crash
pure val codeValues = Set(-1, 0, 1, 2, 70, 74, 75, 77, 78, 137)
pure def lawEachBootFailureExitsWithItsOwnCode(cause: BootFailure): bool = exitClass(exitCode(cause)) == BootFailed({ cause: cause })
pure def lawUnlistedCodeIsACrash(code: int): bool = not(Set(0, 1, 70, 74, 77, 78).contains(code)) implies exitClass(code) == Crash
pure def lawLaunchRefusalExitsAsConfigOrCredential(doc: LaunchDocument, f: LaunchFrame): bool = {
  val verdict = launchVerdict(doc, f)
  match verdict { | LaunchRefused(r) => exitClass(exitCode(r.cause)) == BootFailed({ cause: Config }) or exitClass(exitCode(r.cause)) == BootFailed({ cause: Credential }) | LaunchAdmitted => true }
}
```
