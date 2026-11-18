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
`notification {channel, title, text}` and `routes` (the renderer's route list,
`spec/agent/access/routes.md`), and the launch objects `Launch` types: `model`
(backend, `cloudBaseUrl`, `smallModel`, `largeModel`, `imageModel`, own-key
fields), `embeddings` and `embeddingDimensions`, `persistMemory`,
`callerRole`, `views`, `timeZone`, `privacy`, `google`, `retention` and
`environment`. There is no separate `cloud {…}` record. The character file is
`Launch`'s character and the policy file its `policy` (`actions.allowed`,
`plugins.load`, optional `plugins.product`); a deny list or a refused-action
list is not part of it. Reading the assets, JSON decoding, the class-name and
URL patterns, trimming and digests stay in the shell: a file that is missing
or does not decode under its schema is a configuration error before this
spec sees it. The subclass may override `runtimeNotification()` and the
channel hook; the words below are what it shows when it does not. Sources:
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
type Notification = { channel: Words, title: Words, text: Words }
type HostLaunch = { backend: Launch::Backend, embeddings: Launch::Embeddings, persistMemory: bool, callerRole: Launch::CallerRole, google: Launch::GoogleConsent, retention: Launch::Retention, environment: List[Launch::EnvEntry] }
type HostFile = { schema: int, service: ServiceClass, notification: Notification, routes: Routes::RouteList, launch: HostLaunch }
type PolicyFile = { schema: int, policy: Launch::LaunchPolicy }
type AgentData = { hostBytes: int, characterBytes: int, policyBytes: int, host: HostFile, character: Launch::Character, policy: PolicyFile }
pure val maxFileBytes: int = 262144
pure def filesFit(d: AgentData): bool =
  d.hostBytes <= maxFileBytes and d.characterBytes <= maxFileBytes and d.policyBytes <= maxFileBytes and d.host.schema == 1 and d.policy.schema == 1
```

### The host file names a qualified service class and notification words of 1 to 200 characters

The channel name, title and text are each counted after trimming. The class
must be a qualified Java name (`a.b.C`), decided by the shell's pattern.

```quint
pure val maxWordUnits: int = 200
pure def wordsAdmitted(w: Words): bool = w.units >= 1 and w.units <= maxWordUnits
pure def notificationAdmitted(n: Notification): bool = wordsAdmitted(n.channel) and wordsAdmitted(n.title) and wordsAdmitted(n.text)
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
is checked here; whether a cloud backend has an account is the sign-in's
question, below.

```quint
pure val anyAccount: Launch::OwnerAccount = Launch::SignedIn({ userId: "account", organizationId: "organization" })
pure def backendShapeAdmitted(b: Launch::Backend): bool = Launch::backendAdmitted(b, anyAccount)
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
pure def lawRefusedFilesAreAConfigErrorWhoeverIsSignedIn(d: AgentData, cred: C::DeviceCredential, worker: RP::LaunchWorker): bool =
  not(filesAdmitted(d)) implies withheldAs(startVerdict(d, cred, worker), Launch::Config)
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

### The agent admits every launch the service writes, given a launch frame with a key

A ready launch, sent with an admitted frame that carries a credential, passes
the agent's own launch verdict, so the agent never exits 78 or 77 on a start
the service judged ready.

```quint
pure def readyDocumentAdmitted(v: StartVerdict, f: Launch::LaunchFrame): bool = match v {
  | LaunchReady(r) => Launch::launchVerdict(r.launch.document, f) == Launch::LaunchAdmitted
  | _ => true
}
pure def lawAgentAdmitsEveryReadyLaunch(d: AgentData, cred: C::DeviceCredential, worker: RP::LaunchWorker, f: Launch::LaunchFrame): bool =
  (Launch::frameAdmitted(f) and Launch::hasCredential(f.credential)) implies readyDocumentAdmitted(startVerdict(d, cred, worker), f)
pure val workerValues = Set(RP::NoLaunchWorker, RP::NamedWorker({ runtimeDir: "files/worker", executable: "worker", sha256: "w1" }))
pure val credValues = {
  val active = { ...C::initial, lastVersion: 1, custody: C::Active({ version: 1, credentialId: "c1", account: { userId: "user1", organizationId: "org1" }, keyExpiresAt: 1000 }) }
  Set(C::initial, active, { ...active, custody: C::Expired({ account: { userId: "user1", organizationId: "org1" } }) },
    { ...active, custody: C::Active({ version: 1, credentialId: "c1", account: { userId: "", organizationId: "org1" }, keyExpiresAt: 1000 }) })
}
pure val dValues = {
  val words = { words: "Agent", units: 5 }
  val status = { method: Routes::Get, delivery: Routes::Buffered, path: List(Routes::Literal({ text: "api" }), Routes::Literal({ text: "status" })), query: List(), limit: Routes::AnySize }
  val cloud = Launch::CloudBackend({ baseUrl: "https://cloud.example", baseUrlShape: Launch::HttpsOrigin, smallModel: "", largeModel: "", imageModel: "" })
  val launch = { backend: cloud, embeddings: Launch::NoEmbeddings, persistMemory: false, callerRole: Launch::ChatAsUser,
    google: { gmailChanges: false, calendarEdits: false }, retention: Launch::KeepLogs, environment: List() }
  val host = { schema: 1, service: QualifiedClass({ className: "app.example.AgentService" }), notification: { channel: words, title: words, text: words },
    routes: List({ prefixes: List(List()), id: Routes::flatParam, routes: List(status) }), launch: launch }
  val good = { hostBytes: 900, characterBytes: 400, policyBytes: 300, host: host,
    character: { name: "Agent", nameUnits: 5, systemBlank: false },
    policy: { schema: 1, policy: { actionsAllowed: Set("REPLY"), pluginsLoad: List("inbox"), productPlugin: Launch::NoProductPlugin } } }
  Set(good,
    { ...good, host: { ...host, launch: { ...launch, backend: Launch::NoBackend } } },
    { ...good, host: { ...host, launch: { ...launch, backend: Launch::OwnKeyBackend({ baseUrl: "https://own.example/v1", baseUrlShape: Launch::HttpsWithPath, smallModel: "small", largeModel: "large" }) } } },
    { ...good, host: { ...host, launch: { ...launch, backend: Launch::CloudBackend({ baseUrl: "https://cloud.example/api/v1", baseUrlShape: Launch::HttpsWithPath, smallModel: "", largeModel: "", imageModel: "" }) } } },
    { ...good, hostBytes: maxFileBytes + 1 },
    { ...good, host: { ...host, notification: { channel: words, title: words, text: { words: "", units: 0 } } } },
    { ...good, host: { ...host, service: MalformedClass } },
    { ...good, host: { ...host, routes: List() } },
    { ...good, policy: { ...good.policy, schema: 2 } },
    { ...good, character: { name: "", nameUnits: 0, systemBlank: false } })
}
```
