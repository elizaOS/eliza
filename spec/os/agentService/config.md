# Agent data files

The consumer's agent data and the launch the agent service writes from it.
The host profile's `agent` entry (`spec/os/build/androidHost.md`) names three
consumer files, which the build copies to `assets/agent/host.json`,
`assets/agent/character.json` and `assets/agent/policy.json` and declares the
consumer's service subclass with `foregroundServiceType="specialUse"` and
`FOREGROUND_SERVICE_SPECIAL_USE`. At each start the service reads the three
files, decides here whether they are admitted, and writes the agent's launch
document (`spec/agent/host/launch.md`, imported as `Launch`), which owns every
launch field and its meaning; os adds only its service fields.

The host file holds os's own fields, `service` (the subclass's class name),
`notification {channel, title, text, failure {channel, title, text}}` and
`routes` (the renderer's route list, `spec/agent/access/routes.md`), and the launch objects `Launch` types: `model`
(backend, `cloudBaseUrl`, `smallModel`, `largeModel`, `imageModel`, own-key
fields), `embeddings` and `embeddingDimensions`, `persistMemory`,
`callerRole`, `views`, `timeZone`, `hostContextRevision`, `privacy`,
`google`, `retention` and `environment`. The service forwards
`hostContextRevision` as a positive safe integer when the host file
provides it. A host file without `timeZone` launches with the device's zone
at that start. There is no separate `cloud {…}` record. The character file is
`Launch`'s character and the policy file its `policy` (`actions.allowed`,
`plugins.load`, optional `plugins.product`); a deny list or a refused-action
list is not part of it. Reading the assets, JSON decoding, the class-name and
URL patterns, trimming and digests stay in the shell: a file that is missing
or does not decode under its schema is a configuration error before this
spec sees it. The subclass may override `runtimeNotification()`,
`runtimeFailureNotification()` and the channel hooks; the words below are what it shows when it does not. Sources:
the pinned `EmbeddedAgentConfig.java` (asset limit, notification words,
service class, environment and character checks) and the launch settings of
the device hosts it replaces.

## Story: Start my agent with my character, policy and model

> As the maker of an app that embeds the agent, I want my agent started from
> the character, policy and model my app ships, signed in as the person using
> it, so that it behaves as I designed and acts for the right account.

### Each data file is at most 256 KiB, and the host and policy files are schema 1

The size is the file's length in bytes as read from the assets.

```quint
import launch as Launch from "../../agent/host/launch"
import routes as Routes from "../../agent/access/routes"
import credential as C from "../signIn/credential"
import runtimePayload as RP from "../build/runtimePayload"
type ServiceClass = QualifiedClass({ className: str }) | MalformedClass
type Words = { words: str, units: int }
type NoticeWords = { channel: Words, title: Words, text: Words }
type Notification = { channel: Words, title: Words, text: Words, failure: NoticeWords }
type HostLaunch = { backend: Launch::Backend, embeddings: Launch::Embeddings, persistMemory: bool, callerRole: Launch::CallerRole, google: Launch::GoogleConsent, retention: Launch::Retention, environment: List[Launch::EnvEntry] }
type HostFile = { schema: int, service: ServiceClass, notification: Notification, routes: Routes::RouteList, launch: HostLaunch }
type PolicyFile = { schema: int, policy: Launch::LaunchPolicy }
type AgentData = { hostBytes: int, characterBytes: int, policyBytes: int, host: HostFile, character: Launch::Character, policy: PolicyFile }
pure val maxFileBytes: int = 262144
pure def filesFit(d: AgentData): bool =
  d.hostBytes <= maxFileBytes and d.characterBytes <= maxFileBytes and d.policyBytes <= maxFileBytes and d.host.schema == 1 and d.policy.schema == 1
```

### The host file names a qualified service class, and status and failure notification words of 1 to 200 characters on two differently named channels

The status words (`channel`, `title`, `text`) are shown while the agent
starts, runs or stops; the failure words (`failure.channel`, `failure.title`,
`failure.text`) are shown while it has failed, on their own alerts channel, so
an owner who silences the status channel still sees a failure. Each channel
name, title and text is counted after trimming, and the two channel names
differ after trimming, so the owner can tell the channels apart in the
system settings. The class must be a qualified Java name (`a.b.C`), decided
by the shell's pattern.

```quint
pure val maxWordUnits: int = 200
pure def wordsAdmitted(w: Words): bool = w.units >= 1 and w.units <= maxWordUnits
pure def noticeWordsAdmitted(n: NoticeWords): bool = wordsAdmitted(n.channel) and wordsAdmitted(n.title) and wordsAdmitted(n.text)
pure def notificationAdmitted(n: Notification): bool =
  noticeWordsAdmitted({ channel: n.channel, title: n.title, text: n.text }) and noticeWordsAdmitted(n.failure) and n.failure.channel.words != n.channel.words
pure def serviceNamed(s: ServiceClass): bool = match s { | QualifiedClass(q) => q.className != "" | MalformedClass => false }
```

### The renderer's route list is admitted whole by the route gate's own rule

A list the gate would refuse (empty, a bad literal, a repeated prefix or
query key, a non-positive body limit) refuses the files, so the service never
starts with a renderer that can reach nothing. The channel loads this list as
the renderer's gate.

```quint
pure def rendererRoutes(d: AgentData): Routes::RouteList = d.host.routes
pure def routesAdmitted(d: AgentData): bool = Routes::validList(rendererRoutes(d))
```

### The character, policy and launch settings are admitted exactly as the agent admits them

The service applies the agent's own checks, so a file it admits is never
refused by the agent as a configuration error (exit 78). The backend's shape
is checked here, as the agent would judge it with some named account signed
in; whether a cloud backend has an account is the sign-in's question, below.

```quint
pure val someNamedAccount: Launch::OwnerAccount = Launch::SignedIn({ userId: "named", organizationId: "named" })
pure def backendShapeAdmitted(b: Launch::Backend): bool = Launch::backendAdmitted(b, someNamedAccount)
pure def launchSettingsAdmitted(h: HostLaunch): bool =
  backendShapeAdmitted(h.backend) and Launch::embeddingsAdmitted(h.embeddings) and Launch::retentionAdmitted(h.retention) and Launch::environmentAdmitted(h.environment)
pure def filesAdmitted(d: AgentData): bool =
  filesFit(d) and serviceNamed(d.host.service) and notificationAdmitted(d.host.notification) and routesAdmitted(d)
    and Launch::characterAdmitted(d.character) and Launch::policyAdmitted(d.policy.policy) and launchSettingsAdmitted(d.host.launch)
```

### A refused file is a configuration error whoever is signed in, and a cloud launch without an active key is a credential error

The files are judged first. Then a backend that the agent refuses without a
signed-in account (the cloud backend) needs the account of the active device
key (`../signIn/credential.md`); an expired key, a sign-out or
a key whose sign-in answer named no user or organization withholds the
launch as `Credential`. The service reports `Failed(Config)` or
`Failed(Credential)` and spawns nothing; an own-key or keyless launch needs
no signed-in account.

```quint
type AgentLaunch = { document: Launch::LaunchDocument, worker: RP::LaunchWorker }
type StartVerdict = LaunchReady({ launch: AgentLaunch }) | LaunchWithheld({ cause: Launch::BootFailure })
pure def needsAccount(b: Launch::Backend): bool = backendShapeAdmitted(b) and not(Launch::backendAdmitted(b, Launch::NoAccount))
pure def withheldAs(v: StartVerdict, cause: Launch::BootFailure): bool = match v { | LaunchWithheld(w) => w.cause == cause | _ => false }
pure def startVerdict(d: AgentData, cred: C::DeviceCredential, worker: RP::LaunchWorker): StartVerdict =
  if (not(filesAdmitted(d))) LaunchWithheld({ cause: Launch::Config })
  else if (needsAccount(d.host.launch.backend) and signedInAccount(cred) == Launch::NoAccount) LaunchWithheld({ cause: Launch::Credential })
  else LaunchReady({ launch: { document: launchDocument(d, signedInAccount(cred)), worker: worker } })
pure def lawRefusedFilesAreAConfigErrorWhoeverIsSignedIn(d: AgentData, cred: C::DeviceCredential, otherCred: C::DeviceCredential, worker: RP::LaunchWorker): bool =
  (not(filesAdmitted(d)) implies withheldAs(startVerdict(d, cred, worker), Launch::Config))
    and (withheldAs(startVerdict(d, cred, worker), Launch::Config) iff withheldAs(startVerdict(d, otherCred, worker), Launch::Config))
pure def lawCloudLaunchWithoutActiveKeyIsACredentialError(d: AgentData, cred: C::DeviceCredential, worker: RP::LaunchWorker): bool =
  (filesAdmitted(d) and needsAccount(d.host.launch.backend) and C::activeVersion(cred) == 0) implies withheldAs(startVerdict(d, cred, worker), Launch::Credential)
pure def lawLaunchWithoutCloudIgnoresTheSignIn(d: AgentData, cred: C::DeviceCredential, worker: RP::LaunchWorker): bool =
  (filesAdmitted(d) and not(needsAccount(d.host.launch.backend))) implies not(withheldAs(startVerdict(d, cred, worker), Launch::Credential))
```

### The launch carries the active key's account and the staged worker, and never an agent id

The account is `{userId, organizationId}` of the sign-in answer stored with
the active key, filled for every backend when a key is active. The workflow
worker is the one the payload staged under its pin
(`RP::launchWorker`), or none. The launch document has no `agentId` field:
the agent's store creates and keeps that identity.

```quint
pure def signedInAccount(cred: C::DeviceCredential): Launch::OwnerAccount = {
  val a = C::accountOf(cred)
  if (C::activeVersion(cred) >= 1 and a.userId != "" and a.organizationId != "") Launch::SignedIn({ userId: a.userId, organizationId: a.organizationId }) else Launch::NoAccount
}
pure def launchDocument(d: AgentData, account: Launch::OwnerAccount): Launch::LaunchDocument = {
  val h = d.host.launch
  { schema: d.host.schema, character: d.character, policy: d.policy.policy, backend: h.backend, account: account, embeddings: h.embeddings,
    persistMemory: h.persistMemory, callerRole: h.callerRole, google: h.google, retention: h.retention, environment: h.environment }
}
pure def launchAccount(v: StartVerdict): Launch::OwnerAccount = match v { | LaunchReady(r) => r.launch.document.account | _ => Launch::NoAccount }
pure def lawLaunchNamesOnlyTheActiveKeysAccount(d: AgentData, cred: C::DeviceCredential, worker: RP::LaunchWorker): bool = {
  val a = C::accountOf(cred)
  launchAccount(startVerdict(d, cred, worker)) == Launch::NoAccount
    or (C::activeVersion(cred) >= 1 and launchAccount(startVerdict(d, cred, worker)) == Launch::SignedIn({ userId: a.userId, organizationId: a.organizationId }))
}
```

### A launch carries the Google consent the owner saved, else the host file's

The host file's `google` is what the agent may change in the owner's Gmail
and Calendar until the owner chooses. A service subclass that keeps the
owner's own choice gives it once per launch, after the launch hook, and that
launch carries it whole in place of the host file's; the rest of the
document is unchanged. A subclass that keeps none leaves the host file's.
The agent reads consent only from its launch, so a changed choice reaches
it only through a new launch, and the subclass restarts the agent when the
owner changes it. Source: a consumer's Settings switches for Gmail changes
and Calendar edits, which its phone saved while the agent still launched
with both off.

```quint
type SavedConsent = HostConsent | OwnerChose({ consent: Launch::GoogleConsent })
pure def launchConsent(host: Launch::GoogleConsent, saved: SavedConsent): Launch::GoogleConsent =
  match saved { | OwnerChose(o) => o.consent | HostConsent => host }
pure def consentedLaunch(v: StartVerdict, saved: SavedConsent): StartVerdict = match v {
  | LaunchReady(r) => LaunchReady({ launch: { ...r.launch, document: { ...r.launch.document, google: launchConsent(r.launch.document.google, saved) } } })
  | LaunchWithheld(w) => LaunchWithheld(w)
}
pure def launchGoogle(v: StartVerdict): Launch::GoogleConsent = match v {
  | LaunchReady(r) => r.launch.document.google
  | _ => { gmailChanges: false, calendarEdits: false }
}
pure def lawLaunchCarriesTheSavedConsentElseTheHostFiles(d: AgentData, cred: C::DeviceCredential, worker: RP::LaunchWorker, saved: SavedConsent): bool = {
  val v = startVerdict(d, cred, worker)
  val c = consentedLaunch(v, saved)
  val chosen = match saved { | OwnerChose(o) => o.consent | HostConsent => d.host.launch.google }
  match v {
    | LaunchReady(r) => launchGoogle(c) == chosen and launchAccount(c) == r.launch.document.account
    | LaunchWithheld(w) => withheldAs(c, w.cause)
  }
}
pure val savedValues = Set(HostConsent, OwnerChose({ consent: { gmailChanges: true, calendarEdits: true } }),
  OwnerChose({ consent: { gmailChanges: false, calendarEdits: true } }), OwnerChose({ consent: { gmailChanges: false, calendarEdits: false } }))
```

### Only a cloud launch is framed with the device key, and an own-key launch with the owner's provider key or none

The device key authenticates the person to their own cloud and is sent to
no other origin. A cloud launch carries the active key; an own-key launch
carries the provider key the consumer's credential source holds for the
owner, and with none it carries no credential, so the agent refuses it as
a credential error (`Launch::needsCredential`); a launch with no backend
carries none. A newer device key is pushed only to a running cloud launch.
Sources: develop's `NativeProviderSlot.java` and
`NativeProviderAdmission.java`, which keep the provider key apart from the
Cloud credential.

```quint
type FramedKey = DeviceKey({ version: int }) | ProviderKey({ version: int }) | NoFramedKey
pure def framedKey(d: AgentData, cred: C::DeviceCredential, providerVersion: int): FramedKey = {
  val b = d.host.launch.backend
  if (needsAccount(b) and C::activeVersion(cred) >= 1) DeviceKey({ version: C::activeVersion(cred) })
  else if (not(needsAccount(b)) and Launch::needsCredential(b) and providerVersion >= 1) ProviderKey({ version: providerVersion })
  else NoFramedKey
}
pure def framesDeviceKey(k: FramedKey): bool = match k { | DeviceKey(_) => true | _ => false }
pure def lawOnlyACloudLaunchIsFramedWithTheDeviceKey(d: AgentData, cred: C::DeviceCredential, providerVersion: int): bool =
  framesDeviceKey(framedKey(d, cred, providerVersion)) implies needsAccount(d.host.launch.backend)
pure def lawOwnKeyLaunchIsFramedWithTheProviderKeyOrNone(d: AgentData, cred: C::DeviceCredential, providerVersion: int): bool = {
  val b = d.host.launch.backend
  val ownKeyLaunch = not(needsAccount(b)) and Launch::needsCredential(b)
  ownKeyLaunch
    implies framedKey(d, cred, providerVersion) == (if (providerVersion >= 1) ProviderKey({ version: providerVersion }) else NoFramedKey)
}
pure val providerVersionValues = Set(0, 1, 2)
```

### A ready launch is admitted unless its backend needs a fitting credential and the frame lacks one

The service refuses an oversized own-key provider key as invalid launch
configuration and keeps the active device key. It does this before
writing or spawning the launch. Discovered by simulation: the Agent
refuses an own-key launch when its frame carries more than 1,024 units
in the provider key slot.

For a launch that proceeds with an admitted frame, the Agent returns
its credential error when the backend needs a credential and the
frame lacks one that fits. Otherwise the Agent admits the launch.
An admitted frame never makes the Agent refuse a ready launch as
a configuration error.

```quint
type FinalFrame = FrameReady({ launch: AgentLaunch, frame: Launch::LaunchFrame }) | FrameWithheld({ cause: Launch::BootFailure })
pure def oversizedOwnKey(b: Launch::Backend, c: Launch::FrameCredential): bool =
  Launch::isOwnKey(b) and Launch::hasCredential(c) and not(Launch::credentialFits(b, c))
pure def finalFrame(v: StartVerdict, f: Launch::LaunchFrame): FinalFrame = match v {
  | LaunchReady(r) =>
      if (oversizedOwnKey(r.launch.document.backend, f.credential))
        FrameWithheld({ cause: Launch::Config })
      else FrameReady({ launch: r.launch, frame: f })
  | LaunchWithheld(w) => FrameWithheld({ cause: w.cause })
}
pure def readyLaunchMatchesCredential(doc: Launch::LaunchDocument, f: Launch::LaunchFrame): bool = {
  val b = doc.backend
  val expected = if (Launch::needsCredential(b) and not(Launch::credentialFits(b, f.credential)))
    Launch::LaunchRefused({ cause: Launch::Credential }) else Launch::LaunchAdmitted
  Launch::launchVerdict(doc, f) == expected
}
pure def lawReadyLaunchFollowsFrameCredential(d: AgentData, cred: C::DeviceCredential, worker: RP::LaunchWorker, f: Launch::LaunchFrame): bool = {
  val v = startVerdict(d, cred, worker)
  val checked = finalFrame(v, f)
  Launch::frameAdmitted(f) implies (match v {
    | LaunchReady(r) => match checked {
        | FrameWithheld(w) => oversizedOwnKey(r.launch.document.backend, f.credential) and w.cause == Launch::Config
        | FrameReady(ready) =>
            not(oversizedOwnKey(r.launch.document.backend, f.credential)) and
            readyLaunchMatchesCredential(ready.launch.document, ready.frame)
      }
    | LaunchWithheld(_) => true
  })
}
pure val workerValues = Set(RP::NoLaunchWorker, RP::NamedWorker({ runtimeDir: "files/worker", executable: "worker", sha256: "w1" }))
pure val credValues = {
  val active = { ...C::initial, lastVersion: 1, custody: C::Active({ version: 1, credentialId: "c1", account: { userId: "user1", organizationId: "org1" }, keyExpiresAt: 1000 }) }
  Set(C::initial, active, { ...active, custody: C::Expired({ account: { userId: "user1", organizationId: "org1" } }) },
    { ...active, custody: C::Active({ version: 1, credentialId: "c1", account: { userId: "", organizationId: "org1" }, keyExpiresAt: 1000 }) })
}
pure val otherCredValues = credValues
pure val dValues = {
  val words: Words = { words: "Agent", units: 5 }
  val failure: NoticeWords = { channel: { words: "Agent alerts", units: 12 }, title: words, text: words }
  val status: Routes::Route = { method: Routes::Get, delivery: Routes::Buffered, path: List(Routes::Literal({ text: "api" }), Routes::Literal({ text: "status" })), query: List(), limit: Routes::AnySize }
  val cloud = Launch::CloudBackend({ baseUrl: "https://cloud.example", baseUrlShape: Launch::HttpsOrigin, smallModel: "", largeModel: "", imageModel: "" })
  val launch: HostLaunch = { backend: cloud, embeddings: Launch::NoEmbeddings, persistMemory: false, callerRole: Launch::ChatAsUser,
    google: { gmailChanges: false, calendarEdits: false }, retention: Launch::KeepLogs, environment: List() }
  val host: HostFile = { schema: 1, service: QualifiedClass({ className: "app.example.AgentService" }), notification: { channel: words, title: words, text: words, failure: failure },
    routes: List({ prefixes: List(List()), id: Routes::flatParam, routes: List(status) }), launch: launch }
  val good: AgentData = { hostBytes: 900, characterBytes: 400, policyBytes: 300, host: host,
    character: { name: "Agent", nameUnits: 5, systemBlank: false },
    policy: { schema: 1, policy: { actionsAllowed: Set("REPLY"), pluginsLoad: List("inbox"), productPlugin: Launch::NoProductPlugin } } }
  Set(good,
    { ...good, host: { ...host, launch: { ...launch, backend: Launch::NoBackend } } },
    { ...good, host: { ...host, launch: { ...launch, backend: Launch::OwnKeyBackend({ baseUrl: "https://own.example/v1", baseUrlShape: Launch::HttpsWithPath, smallModel: "small", largeModel: "large" }) } } },
    { ...good, host: { ...host, launch: { ...launch, backend: Launch::CloudBackend({ baseUrl: "https://cloud.example/api/v1", baseUrlShape: Launch::HttpsWithPath, smallModel: "", largeModel: "", imageModel: "" }) } } },
    { ...good, hostBytes: maxFileBytes + 1 },
    { ...good, host: { ...host, notification: { channel: words, title: words, text: { words: "", units: 0 }, failure: failure } } },
    { ...good, host: { ...host, notification: { channel: words, title: words, text: words, failure: { ...failure, text: { words: "", units: 0 } } } } },
    { ...good, host: { ...host, notification: { channel: words, title: words, text: words, failure: { ...failure, channel: words } } } },
    { ...good, host: { ...host, service: MalformedClass } },
    { ...good, host: { ...host, routes: List() } },
    { ...good, policy: { ...good.policy, schema: 2 } },
    { ...good, character: { name: "", nameUnits: 0, systemBlank: false } })
}
```
