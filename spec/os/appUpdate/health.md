# App update health evidence

The installed app answers the updater's health requests with evidence about
one installation. One worker serves one request at a time: it reads the
agent through the agent service for the current launch, reads task storage,
asks the WebView observer for one read of the screen, and answers. The
installation journal (`appUpdate/install.md`) decides what the evidence
means for its plan; this machine only produces evidence that names the
installation it was collected for. Sources: the develop health service,
runtime probe and WebView observer (`plugins/plugin-native-agent/android/.../health/*`),
rewritten against the agent socket client: there is no gateway and no
loopback port.

The shell maps the Android sending UID to `Supervisor` only when it
resolves to exactly one package, the configured updater package, signed
like the app; it parses the request bundle (exactly a nonce, the version
code, the deadline and the journal subject, each of its exact type) through
`parseEvent` before `receive`. The agent half is a request through the
`AgentService` Java API for the current epoch: `GET /api/health`, read with
`agentService/health.md`. When the launch loads `@elizaos/agent/tasks`, the
storage half is the agent's read-only `GET /api/tasks/storage`
(`taskStorage: ok | deferred | unavailable`, no provider call), sent only
after a ready health answer; otherwise it is `TasksNotLoaded` and the
agent's readiness stands for it. The elapsed monotonic clock, the 64-hex
nonce and the reply UID and installed-identity checks on the updater side
stay in the shell.

## Story: Accept an update only after the app proves healthy

> As a device owner, I want a new app version accepted only after my agent,
> its task storage and its screen proved healthy for that exact
> installation, so that a broken update is caught and a slow start or a
> hidden screen never rolls one back.

### Only a well-timed updater request for this version starts the worker

A foreign sender is answered `Unauthorized` whatever it sent, and nothing
changes. The updater's request is refused as invalid or busy when the
service is closed, the worker is busy, the version code is not the app's
own, or the deadline is not ahead of now by at most 20 s.

```quint
import install as I from "./install"
import health as H from "../agentService/health"
type Sender = Supervisor | OtherSender
type Subject = { planId: int, generation: int, revision: int, installed: I::ArtifactId }
type HealthRequest = { subject: Subject, versionCode: int, deadline: int }
type Answer = NoAnswer | Unauthorized | InvalidOrBusy | Unavailable | Observed({ evidence: I::HealthEvidence })
type WorkStage = Idle | Probing | Observing
type AgentHalf = AgentUnread | AgentHealthy | AgentWaiting | AgentFailing
type TaskStorage = TasksOk | TasksDeferred | TasksUnavailable | TasksNotLoaded
type UiReading = UiUnread | UiPending | UiAbsent | UiBackground | UiFailed | UiForeground({ content: bool })
type UiBinding = { activity: int, view: int, resumed: bool, generation: int }
type UiLease = { id: int, generation: int, deadline: int }
type HealthWork = { clock: int, closed: bool, stage: WorkStage, subject: Subject, deadline: int, epoch: int, agent: AgentHalf, storage: TaskStorage, binding: UiBinding, issued: int, pending: UiLease, uiLease: int, ui: UiReading, lastAnswer: Answer }
type HealthStep = { state: HealthWork, out: List[Answer] }
pure val maxRequestMs = 20000
pure val noSubject: Subject = { planId: 0, generation: 0, revision: 0, installed: 0 }
pure val noLease: UiLease = { id: 0, generation: 0, deadline: 0 }
pure val initial: HealthWork = { clock: 0, closed: false, stage: Idle, subject: noSubject, deadline: 0, epoch: 0, agent: AgentUnread, storage: TasksUnavailable, binding: { activity: 0, view: 0, resumed: false, generation: 0 }, issued: 0, pending: noLease, uiLease: 0, ui: UiUnread, lastAnswer: NoAnswer }
pure def admission(by: Sender, request: HealthRequest, compiledVersion: int, clock: int, free: bool): Answer =
  if (by != Supervisor) Unauthorized
  else if (not(free) or request.versionCode != compiledVersion or request.deadline <= clock or request.deadline - clock > maxRequestMs) InvalidOrBusy
  else NoAnswer
pure def receive(s: HealthWork, by: Sender, request: HealthRequest, compiledVersion: int): HealthStep = {
  val a = admission(by, request, compiledVersion, s.clock, not(s.closed) and s.stage == Idle)
  if (a == NoAnswer) { state: { ...s, stage: Probing, subject: request.subject, deadline: request.deadline }, out: List() }
  else { state: { ...s, lastAnswer: a }, out: List(a) }
}
pure def canAdvanceClock(s: HealthWork, later: int): bool = later > s.clock
pure def advanceClock(s: HealthWork, later: int): HealthWork = { ...s, clock: later }
pure def canClose(s: HealthWork): bool = not(s.closed)
pure def close(s: HealthWork): HealthWork = { ...s, closed: true }
pure val requestValues = Set(
  { subject: { planId: 1, generation: 0, revision: 6, installed: 2 }, versionCode: 1, deadline: 3000 },
  { subject: { planId: 1, generation: 0, revision: 6, installed: 2 }, versionCode: 1, deadline: 25000 },
  { subject: { planId: 1, generation: 0, revision: 6, installed: 2 }, versionCode: 2, deadline: 3000 }
)
pure val anotherValues = requestValues
pure val compiledVersionValues = Set(1)
pure val clockValues = Set(0, 1000, 3000)
pure val laterValues = Set(1000, 1600, 3000)
pure val weight_receive = 3
pure def lawForeignSenderLearnsNothing(request: HealthRequest, another: HealthRequest, compiledVersion: int, clock: int, free: bool): bool =
  admission(OtherSender, request, compiledVersion, clock, free) == admission(OtherSender, another, compiledVersion, clock, free)
pure def lawAdmittedDeadlineIsAheadAndBounded(by: Sender, request: HealthRequest, compiledVersion: int, clock: int, free: bool): bool =
  admission(by, request, compiledVersion, clock, free) == NoAnswer implies (by == Supervisor and free and clock < request.deadline and request.deadline <= clock + maxRequestMs)
pure def stepForeignSenderChangesNothing(before: HealthWork, after: HealthWork, out: List[Answer]): bool =
  out.includes(Unauthorized) implies { ...after, lastAnswer: before.lastAnswer } == before
pure def sometimesForeignSenderRefused(s: HealthWork): bool = s.lastAnswer == Unauthorized
```

### The agent half is the agent service's verdict for the current launch, and storage counts only from a ready agent

A ready answer of this epoch is healthy. The agent fails only when the
agent service's own watch would restart it (`H::verdict` is `Restart`), so
one unready answer right after an update never fails it. Anything else
waits. Task storage read from an agent that is not healthy is unavailable.

```quint
type AgentReading = { watch: H::HealthWatch, reply: H::ProbeReply }
pure def agentHalf(reading: AgentReading, epoch: int): AgentHalf =
  if (H::classify(reading.reply, epoch) == H::Ok) AgentHealthy
  else if (H::verdict(reading.watch, H::Probed({ reply: reading.reply }), epoch) == H::Restart) AgentFailing
  else AgentWaiting
pure def canReadRuntime(s: HealthWork): bool = s.stage == Probing
pure def readRuntime(s: HealthWork, reading: AgentReading, tasks: TaskStorage, epoch: int): HealthWork = {
  val half = agentHalf(reading, epoch)
  { ...s, stage: Observing, epoch: epoch, agent: half, storage: if (half == AgentHealthy) tasks else TasksUnavailable }
}
pure val readingValues = Set(
  { watch: { strikes: 0, busyTicks: 0, refusals: 0 }, reply: H::Answered({ status: 200, body: H::Parsed({ ready: true, runtime: "ok", agentState: "running", epoch: 1 }) }) },
  { watch: { strikes: 0, busyTicks: 0, refusals: 0 }, reply: H::Unanswered({ childAlive: true, socketAccepts: false }) },
  { watch: { strikes: 2, busyTicks: 0, refusals: 0 }, reply: H::Unanswered({ childAlive: false, socketAccepts: false }) }
)
pure val weight_readRuntime = 3
pure def lawOneBadProbeNeverFails(reply: H::ProbeReply, epoch: int): bool =
  agentHalf({ watch: H::freshWatch, reply: reply }, epoch) != AgentFailing
pure def alwaysStorageNeedsAReadyAgent(s: HealthWork): bool = s.storage != TasksUnavailable implies s.agent == AgentHealthy
pure def sometimesAgentWaiting(s: HealthWork): bool = s.agent == AgentWaiting
```

### Only a failing agent fails an update, and a pass needs a ready agent, its storage and visible content of the same launch

An absent or background screen, a page with no content, deferred storage
and an answer from another launch decide nothing: the worker answers
`Unavailable` and the updater asks again later.

```quint
type Conclusion = Undecided | Decided({ verdict: I::HealthVerdict })
pure def storageReady(storage: TaskStorage): bool = storage == TasksOk or storage == TasksNotLoaded
pure def conclude(agent: AgentHalf, storage: TaskStorage, ui: UiReading, sameLaunch: bool): Conclusion =
  if (not(sameLaunch)) Undecided
  else if (agent == AgentFailing) Decided({ verdict: I::HealthFailed })
  else if (agent == AgentHealthy and storageReady(storage) and ui == UiForeground({ content: true })) Decided({ verdict: I::HealthPassed })
  else Undecided
pure val uiValues = Set(UiAbsent, UiBackground, UiFailed, UiForeground({ content: true }), UiForeground({ content: false }))
pure def lawOnlyTheAgentFails(agent: AgentHalf, storage: TaskStorage, ui: UiReading, sameLaunch: bool): bool =
  agent != AgentFailing implies conclude(agent, storage, ui, sameLaunch) != Decided({ verdict: I::HealthFailed })
pure def lawUnseenScreenNeverPasses(agent: AgentHalf, storage: TaskStorage, ui: UiReading, sameLaunch: bool): bool =
  (ui == UiAbsent or ui == UiBackground or ui == UiForeground({ content: false })) implies conclude(agent, storage, ui, sameLaunch) != Decided({ verdict: I::HealthPassed })
pure def lawAnotherLaunchDecidesNothing(agent: AgentHalf, storage: TaskStorage, ui: UiReading): bool =
  conclude(agent, storage, ui, false) == Undecided
```

### Evidence names the installation it was asked about and is sent only before the deadline of an open service

The answer echoes the journal subject of the request (plan, channel
generation, journal revision and installed artifact), so the journal's
`canObserveHealth` matches it against its own state. A UI read still
pending at its own deadline counts as failed and is left to be retired. A
closed service or a passed deadline sends nothing. The updater then
rechecks that the installed identity did not change during the request.

```quint
pure def canFinish(s: HealthWork): bool = s.stage == Observing and s.ui != UiUnread and (s.ui != UiPending or s.clock >= s.pending.deadline)
pure def finish(s: HealthWork, epoch: int): HealthStep = {
  val ui = if (s.ui == UiPending) UiFailed else s.ui
  val c = conclude(s.agent, s.storage, ui, epoch == s.epoch)
  val answer = match c {
    | Decided(d) => Observed({ evidence: { planId: s.subject.planId, generation: s.subject.generation, revision: s.subject.revision, installed: s.subject.installed, verdict: d.verdict } })
    | Undecided => Unavailable
  }
  val late = s.closed or s.clock >= s.deadline
  val idle = { ...s, stage: Idle, subject: noSubject, agent: AgentUnread, storage: TasksUnavailable, uiLease: 0, ui: UiUnread }
  if (late) { state: idle, out: List() } else { state: { ...idle, lastAnswer: answer }, out: List(answer) }
}
pure def admissibleEvidence(subject: Subject, installedNow: I::ArtifactId, answer: Answer): bool = match answer {
  | Observed(o) => installedNow == subject.installed and o.evidence.planId == subject.planId and o.evidence.generation == subject.generation and o.evidence.revision == subject.revision and o.evidence.installed == subject.installed
  | _ => false
}
pure def namesSubject(subject: Subject, answer: Answer): bool = admissibleEvidence(subject, subject.installed, answer)
pure def isObserved(answer: Answer): bool = match answer { | Observed(o) => true | _ => false }
pure def answered(answer: Answer, verdict: I::HealthVerdict): bool = match answer { | Observed(o) => o.evidence.verdict == verdict | _ => false }
pure val weight_finish = 3
pure def stepEvidenceIsTimelyAndNamesItsSubject(before: HealthWork, via: str, after: HealthWork, out: List[Answer]): bool =
  out.some(a => isObserved(a)) implies (via == "finish" and not(before.closed) and before.clock < before.deadline and out.every(a => namesSubject(before.subject, a)))
pure def sometimesPassed(s: HealthWork): bool = answered(s.lastAnswer, I::HealthPassed)
pure def sometimesFailed(s: HealthWork): bool = answered(s.lastAnswer, I::HealthFailed)
pure def sometimesUndecided(s: HealthWork): bool = s.lastAnswer == Unavailable
pure def sometimesLateRequest(s: HealthWork): bool = s.stage == Observing and s.clock >= s.deadline
```

### The worker's readings belong to its current request

These are the facts about reachable states the UI rules rely on. A request
that is not observing has read nothing, and the UI reading is pending
exactly while this request's evaluation is outstanding.

```quint
pure def alwaysReadingsFollowTheStage(s: HealthWork): bool =
  (s.stage != Observing implies (s.agent == AgentUnread and s.ui == UiUnread)) and (s.stage == Observing implies s.agent != AgentUnread) and
  (s.ui == UiUnread implies s.uiLease == 0) and ((s.ui == UiPending) iff (s.uiLease > 0 and s.pending.id == s.uiLease)) and
  s.issued >= 0 and s.pending.id >= 0 and s.pending.id <= s.issued and s.uiLease >= 0 and s.uiLease <= s.issued
```

## Story: Check the screen without disturbing me

> As a device owner, I want the health check to look at my app's screen
> only as it already is, so that it never brings a screen forward and a
> late answer from one check never decides another.

### The observer evaluates only the current resumed view and reports an absent or background screen as such

Main-thread lifecycle callbacks bind an Activity and its WebView on resume;
pause marks the binding background and destroy clears it. Each of them
retires an outstanding evaluation. A read admits an evaluation only for a
live, shown and focused view of the resumed binding, at the configured
HTTPS origin, within `uiBudgetMs` and the request's deadline; an expired
evaluation left by an earlier request is retired first. The observer never
launches, resumes or repairs the screen. The read-only script checks the
exact JavaScript origin and a visible main region with text and a visible
control, and returns only `true` or `false`.

```quint
type UiFacts = { activityAlive: bool, shown: bool, originMatches: bool }
type RendererAnswer = AnswerTrue | AnswerFalse | AnswerOther
pure val uiBudgetMs = 1500
pure def retire(result: UiReading, s: HealthWork): HealthWork =
  if (s.pending.id > 0) { ...s, pending: noLease, ui: if (s.pending.id == s.uiLease) result else s.ui } else s
pure def uiDeadline(s: HealthWork): int = if (s.clock + uiBudgetMs < s.deadline) s.clock + uiBudgetMs else s.deadline
pure def canResumeUi(s: HealthWork, activity: int, view: int): bool = activity > 0 and view > 0
pure def resumeUi(s: HealthWork, activity: int, view: int): HealthWork =
  { ...retire(UiFailed, s), binding: { activity: activity, view: view, resumed: true, generation: s.binding.generation + 1 } }
pure def canLeaveUi(s: HealthWork, activity: int, destroyed: bool): bool = activity > 0 and activity == s.binding.activity
pure def leaveUi(s: HealthWork, activity: int, destroyed: bool): HealthWork = {
  val g = s.binding.generation + 1
  { ...retire(UiFailed, s), binding: if (destroyed) { activity: 0, view: 0, resumed: false, generation: g } else { ...s.binding, resumed: false, generation: g } }
}
pure def canInspectUi(s: HealthWork, facts: UiFacts): bool = s.stage == Observing and s.ui == UiUnread
pure def inspectUi(s: HealthWork, facts: UiFacts): HealthWork = {
  val ready = retire(UiFailed, s)
  val id = s.issued + 1
  if (uiDeadline(s) <= s.clock) { ...ready, ui: UiFailed }
  else if (s.binding.activity <= 0 or not(facts.activityAlive)) { ...ready, ui: UiAbsent }
  else if (not(s.binding.resumed and facts.shown)) { ...ready, ui: UiBackground }
  else if (not(facts.originMatches)) { ...ready, ui: UiFailed }
  else { ...ready, issued: id, uiLease: id, ui: UiPending, pending: { id: id, generation: s.binding.generation, deadline: uiDeadline(s) } }
}
pure val activityValues = Set(1, 2)
pure val viewValues = Set(11)
pure val factsValues = Set({ activityAlive: true, shown: true, originMatches: true }, { activityAlive: true, shown: false, originMatches: true }, { activityAlive: false, shown: true, originMatches: true }, { activityAlive: true, shown: true, originMatches: false })
pure val weight_inspectUi = 3
pure val weight_resumeUi = 2
pure def alwaysEvaluationIsOnTheCurrentView(s: HealthWork): bool =
  s.pending.id > 0 implies (s.pending.generation == s.binding.generation and s.binding.resumed and s.binding.activity > 0 and (s.pending.id == s.uiLease implies s.pending.deadline <= s.deadline))
pure def sometimesUiAbsent(s: HealthWork): bool = s.ui == UiAbsent
pure def sometimesUiBackground(s: HealthWork): bool = s.ui == UiBackground
pure def sometimesPageWithoutContent(s: HealthWork): bool = s.ui == UiForeground({ content: false })
```

### A renderer answer settles only its own unexpired evaluation of the unchanged view

The callback names its lease. It counts only for the outstanding lease,
before that lease's deadline, with the view still focused on the exact URL
it was read at; then `true` means content present and `false` a page
without content, and any other value fails. A request that gave up on its
read leaves the lease outstanding: a late answer or the cleanup retires it
and changes no later request's reading, and a new read gets a new lease.

```quint
pure def canDeliverUiCallback(s: HealthWork, leaseId: int, unchanged: bool, answer: RendererAnswer): bool = leaseId > 0 and s.pending.id == leaseId
pure def deliverUiCallback(s: HealthWork, leaseId: int, unchanged: bool, answer: RendererAnswer): HealthWork = {
  val result = if (s.clock >= s.pending.deadline or not(unchanged)) UiFailed else if (answer == AnswerTrue) UiForeground({ content: true }) else if (answer == AnswerFalse) UiForeground({ content: false }) else UiFailed
  retire(result, s)
}
pure def canEndUiRead(s: HealthWork, leaseId: int): bool = leaseId > 0 and s.pending.id == leaseId
pure def endUiRead(s: HealthWork, leaseId: int): HealthWork = retire(UiFailed, s)
pure val leaseIdValues = Set(1, 2)
pure val weight_deliverUiCallback = 3
pure def isForeground(ui: UiReading): bool = match ui { | UiForeground(f) => true | _ => false }
pure def alwaysAbandonedEvaluationHasExpired(s: HealthWork): bool = (s.pending.id > 0 and s.pending.id != s.uiLease) implies s.clock >= s.pending.deadline
pure def stepRendererSettlesOnlyItsOwnRead(before: HealthWork, via: str, after: HealthWork): bool =
  ((via == "deliverUiCallback" or via == "endUiRead") and after.ui != before.ui implies (before.ui == UiPending and before.pending.id == before.uiLease)) and
  ((after.ui != before.ui and isForeground(after.ui)) implies (via == "deliverUiCallback" and before.clock < before.pending.deadline))
pure def sometimesAbandonedEvaluation(s: HealthWork): bool = s.pending.id > 0 and s.pending.id != s.uiLease
```
