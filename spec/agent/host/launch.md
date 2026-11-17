# Launch contract

The process contract between the agent and the host that starts it: the
launch document, the launch frame on stdin and the exit-code table. The host
runs `agent.mjs serve --launch <file> --state <dir> (--socket <path> | --http 127.0.0.1:<port>)`.
This library has no state and no opaque function, so the agent process, the
model binding and the os agent service import it.

The document is JSON, schema 1, decoded whole by `launch.schema.vibe`, which
holds the full field list: `character`, `policy`, `model` (`backend`,
`cloudBaseUrl`, `smallModel`, `largeModel`, `imageModel`, `ownKeyBaseUrl`,
`ownKeySmall`, `ownKeyLarge`), `account`, `embeddings` and
`embeddingDimensions`, `persistMemory`, `callerRole`, `views`, `timeZone`,
`privacy {secretSwap, piiSwap}`, `google {gmailChanges, calendarEdits}`,
`workflowWorker {runtimeDir, executable, sha256}`, `retention`,
`hostContextRevision` and `environment`. It carries no `agentId`: the store
creates and keeps that identity in the `--state` directory. Shape facts that
need string parsing (a URL's form, an environment key's class, a trimmed
length) are decided by the schema and appear below as fields. Sources:
pinned `EmbeddedAgentConfig.java` (character, origin, environment, allow list)
and the launch settings of the device hosts it replaces.

## Story: Start the agent from one launch document

> As the host that starts my agent, I want to hand it one launch document
> that it accepts whole or refuses whole, so that it never runs on half of
> my configuration.

### The launch document is accepted whole or refused whole as a configuration error

A document is admitted only when it is schema 1 and every part below is
admitted; anything else refuses the whole launch with exit 78 before the
store opens. The character needs a trimmed name of 1 to 50 units and a
nonblank system prompt. The chat caller role is `Owner` or `User`.

```quint
import authorization as Z from "../../core/authorization"
type Character = { name: str, nameUnits: int, systemBlank: bool }
type UrlShape = HttpsOrigin | HttpsWithPath | NotHttps
type Account = { userId: str, organizationId: str }
type Backend =
  | CloudBackend({ baseUrl: str, baseUrlShape: UrlShape, account: Account, smallModel: str, largeModel: str, imageModel: str })
  | OwnKeyBackend({ baseUrl: str, baseUrlShape: UrlShape, smallModel: str, largeModel: str })
  | NoBackend
type Embeddings = LocalEmbeddings({ dimensions: int }) | NoEmbeddings
type ProductPlugin = NamedProductPlugin({ name: str }) | NoProductPlugin
type LaunchPolicy = { actionsAllowed: Set[str], pluginsLoad: List[str], productPlugin: ProductPlugin }
type EnvKeyKind = PluginSetting | ReservedKey | MalformedKey
type EnvEntry = { key: str, keyKind: EnvKeyKind, singleLine: bool }
type Retention = PruneLogs({ dayThousandths: int, maxRowsPerRoom: int, intervalMinutes: int }) | KeepLogs
type GoogleConsent = { gmailChanges: bool, calendarEdits: bool }
type LaunchDocument = { schema: int, character: Character, policy: LaunchPolicy, backend: Backend, embeddings: Embeddings, persistMemory: bool, callerRole: Z::Role, google: GoogleConsent, retention: Retention, environment: List[EnvEntry] }
pure def characterAdmitted(c: Character): bool = c.nameUnits >= 1 and c.nameUnits <= 50 and not(c.systemBlank)
pure def documentAdmitted(doc: LaunchDocument): bool =
  doc.schema == 1 and characterAdmitted(doc.character) and policyAdmitted(doc.policy) and backendAdmitted(doc.backend) and embeddingsAdmitted(doc.embeddings)
    and (doc.callerRole == Z::Owner or doc.callerRole == Z::User) and retentionAdmitted(doc.retention) and environmentAdmitted(doc.environment)
```

### The launch names every action the agent may run, so an action it does not name is refused for every caller

`policy.actions.allowed` is a nonempty set of nonempty names, and the agent
always sets core's product allowlist from it: there is no launch without an
allowlist. `policy.plugins.load` is ordered and names each plugin once; the
optional product plugin is not also in that list. Whether each name is a
plugin of the bundle or a registered action is checked at plugin load.

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
pure val pValues = Set(
  { actionsAllowed: Set("REPLY"), pluginsLoad: List("inbox"), productPlugin: NoProductPlugin },
  { actionsAllowed: Set("REPLY", "CALCULATE"), pluginsLoad: List("inbox", "calendar"), productPlugin: NamedProductPlugin({ name: "product" }) },
  { actionsAllowed: Set(), pluginsLoad: List(), productPlugin: NoProductPlugin },
  { actionsAllowed: Set("REPLY"), pluginsLoad: List("inbox", "inbox"), productPlugin: NoProductPlugin },
  { actionsAllowed: Set("REPLY"), pluginsLoad: List("product"), productPlugin: NamedProductPlugin({ name: "product" }) })
pure val actionNameValues = Set("REPLY", "CALCULATE", "SEND_EMAIL")
pure def lawLaunchAllowlistRefusesUnnamedActions(p: LaunchPolicy, actionName: str): bool =
  not(p.actionsAllowed.contains(actionName)) implies not(AP::productAllows(productAllowlist(p), actionName))
pure def lawAdmittedPolicyPassesTheCoreBootCheck(p: LaunchPolicy): bool =
  policyAdmitted(p) implies AP::allowlistBoot({ present: true, blank: false, parses: true, names: p.actionsAllowed }, p.actionsAllowed) == AP::AllowlistAdmitted
```

### Text goes to the owner's cloud account, the owner's own key, or nowhere

There is no local text backend. `cloudBaseUrl` is an HTTPS origin with no
path, query or fragment (the cloud client builds the `/api/v1/...` paths),
and a cloud launch carries the owner's `account` (it is refused with any
other backend); empty cloud model names leave the choice to cloud. An own
key needs an HTTPS base URL and both model names. Local embeddings need a
positive dimension.

```quint
pure def backendAdmitted(b: Backend): bool = match b {
  | CloudBackend(c) => c.baseUrlShape == HttpsOrigin and c.account.userId != "" and c.account.organizationId != ""
  | OwnKeyBackend(k) => k.baseUrlShape != NotHttps and k.smallModel != "" and k.largeModel != ""
  | NoBackend => true
}
pure def embeddingsAdmitted(e: Embeddings): bool = match e { | LocalEmbeddings(x) => x.dimensions > 0 | NoEmbeddings => true }
pure def needsDeviceKey(b: Backend): bool = match b { | NoBackend => false | _ => true }
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

## Story: Keep the credential out of every file and reply

> As the owner, I want my device key and the launch token handed to the
> agent only on stdin, so that no file, status, receipt or log line ever
> shows them.

### The launch frame is one stdin line with the token, the epoch and the optional device key and storage key

The host writes one JSON line on stdin and closes it:
`{version: 1, token, epoch, credential?: {version, value}, storageKey?}`.
The frame is admitted only at version 1 with a positive epoch and, when a
device key is given, a positive key version; the schema refuses an empty
token or key. Nothing secret arrives in a file or the environment.

```quint
type SecretLaunchToken = str
type SecretDeviceKey = str
type SecretStorageKey = str
type FrameCredential = DeviceKey({ version: int, value: SecretDeviceKey }) | NoDeviceKey
type FrameStorageKey = StorageKey({ key: SecretStorageKey }) | NoStorageKey
type LaunchFrame = { version: int, token: SecretLaunchToken, epoch: int, credential: FrameCredential, storageKey: FrameStorageKey }
pure def credentialVersion(f: LaunchFrame): int = {
  val credential = f.credential
  match credential { | DeviceKey(k) => k.version | NoDeviceKey => 0 }
}
pure def frameAdmitted(f: LaunchFrame): bool = f.version == 1 and f.epoch >= 1 and (f.credential == NoDeviceKey or credentialVersion(f) >= 1)
```

### The token, the device key and the storage key are secrets nothing declassifies, while the epoch is public

The health answer echoes the epoch so a host can tell a stale child from the
current one. No definition here or in an importer lets a secret out.

```quint
pure def frameEpoch(f: LaunchFrame): int = f.epoch
pure def lawNoDeviceKeyHasVersionZero(f: LaunchFrame): bool = f.credential == NoDeviceKey implies credentialVersion(f) == 0
pure def lawAdmittedDeviceKeyStartsAboveZero(f: LaunchFrame): bool = (frameAdmitted(f) and f.credential != NoDeviceKey) implies credentialVersion(f) >= 1
```

### A cloud or own-key launch without a device key is refused as a credential error

A configuration error is reported first; a backend that needs the device key
and has none then exits 77, before the store opens. A launch with no backend
needs no key.

```quint
type BootFailure = Config | Credential | Storage | Agent
type LaunchVerdict = LaunchAdmitted | LaunchRefused({ cause: BootFailure })
pure def launchVerdict(doc: LaunchDocument, f: LaunchFrame): LaunchVerdict =
  if (not(documentAdmitted(doc)) or not(frameAdmitted(f))) LaunchRefused({ cause: Config })
  else if (needsDeviceKey(doc.backend) and f.credential == NoDeviceKey) LaunchRefused({ cause: Credential })
  else LaunchAdmitted
pure val goodCharacter: Character = { name: "Agent", nameUnits: 5, systemBlank: false }
pure val goodPolicy: LaunchPolicy = { actionsAllowed: Set("REPLY"), pluginsLoad: List(), productPlugin: NoProductPlugin }
pure val owner: Account = { userId: "user1", organizationId: "org1" }
pure val cloud: Backend = CloudBackend({ baseUrl: "https://cloud.example", baseUrlShape: HttpsOrigin, account: owner, smallModel: "", largeModel: "", imageModel: "" })
pure val goodDoc: LaunchDocument = { schema: 1, character: goodCharacter, policy: goodPolicy, backend: cloud, embeddings: NoEmbeddings, persistMemory: false, callerRole: Z::User, google: { gmailChanges: false, calendarEdits: false }, retention: KeepLogs, environment: List() }
pure val docValues = Set(goodDoc,
  { ...goodDoc, backend: NoBackend, callerRole: Z::Owner, embeddings: LocalEmbeddings({ dimensions: 384 }), retention: PruneLogs({ dayThousandths: 250, maxRowsPerRoom: 200, intervalMinutes: 30 }) },
  { ...goodDoc, backend: OwnKeyBackend({ baseUrl: "https://own.example/v1", baseUrlShape: HttpsWithPath, smallModel: "small", largeModel: "large" }) },
  { ...goodDoc, backend: CloudBackend({ baseUrl: "https://cloud.example/api/v1", baseUrlShape: HttpsWithPath, account: owner, smallModel: "", largeModel: "", imageModel: "" }) },
  { ...goodDoc, character: { ...goodCharacter, nameUnits: 0 } },
  { ...goodDoc, callerRole: Z::Admin },
  { ...goodDoc, environment: List({ key: "NODE_OPTIONS", keyKind: ReservedKey, singleLine: true }) })
pure val fValues = Set(
  { version: 1, token: "t", epoch: 1, credential: DeviceKey({ version: 1, value: "k" }), storageKey: StorageKey({ key: "s" }) },
  { version: 1, token: "t", epoch: 2, credential: NoDeviceKey, storageKey: NoStorageKey },
  { version: 2, token: "t", epoch: 1, credential: DeviceKey({ version: 1, value: "k" }), storageKey: NoStorageKey },
  { version: 1, token: "t", epoch: 1, credential: DeviceKey({ version: 0, value: "k" }), storageKey: NoStorageKey })
pure def lawKeylessCloudOrOwnKeyLaunchIsACredentialError(doc: LaunchDocument, f: LaunchFrame): bool =
  (documentAdmitted(doc) and frameAdmitted(f) and needsDeviceKey(doc.backend) and f.credential == NoDeviceKey) implies launchVerdict(doc, f) == LaunchRefused({ cause: Credential })
pure def lawLaunchWithoutBackendNeedsNoKey(doc: LaunchDocument, f: LaunchFrame): bool =
  (documentAdmitted(doc) and frameAdmitted(f) and doc.backend == NoBackend) implies launchVerdict(doc, f) == LaunchAdmitted
pure def lawRefusedDocumentIsAConfigErrorWhateverTheKey(doc: LaunchDocument, f: LaunchFrame): bool =
  not(documentAdmitted(doc)) implies launchVerdict(doc, f) == LaunchRefused({ cause: Config })
```

## Story: Tell the supervisor why the process ended

> As the host that supervises my agent, I want each exit code to name one
> cause, so that I restart a crash and never restart a launch that cannot
> work.

### Each boot failure has one exit code, and every code outside the table is a crash

0 is a clean stop, 1 a stop in which a release failed, 78 a configuration
error, 77 a missing device key, 74 a storage failure (locked, blocked
migration, corrupt or another account's store) and 70 a runtime that failed
to initialize. Any other code, and a death by signal, is a crash. This is the
one exit table; the os supervisor maps it to its own states.

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
pure def lawDistinctCausesExitWithDistinctCodes(first: BootFailure, second: BootFailure): bool = first != second implies exitCode(first) != exitCode(second)
pure def lawNoBootFailureLooksLikeAStop(cause: BootFailure): bool = exitCode(cause) != 0 and exitCode(cause) != 1
pure def lawUnlistedCodeIsACrash(code: int): bool = not(Set(0, 1, 70, 74, 77, 78).contains(code)) implies exitClass(code) == Crash
pure def lawLaunchRefusalExitsAsConfigOrCredential(doc: LaunchDocument, f: LaunchFrame): bool = {
  val verdict = launchVerdict(doc, f)
  match verdict { | LaunchRefused(r) => exitCode(r.cause) == 78 or exitCode(r.cause) == 77 | LaunchAdmitted => true }
}
```
