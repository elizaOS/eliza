# Grace participant-reported task support evidence

Grace `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` exposes optional task assistance reports in the task diagnostics panel. `apps/app/host/task-runtime-gateway.ts` always supplies the product support store to `task-routes.ts`. `host/pilot/task-support-store.ts` imports Eliza `7743504b7c936a764b3938a44cad918808b621df` at `packages/agent/native-host/task-evidence-store.mjs`. This evidence is separate from task transitions, effects, and the diagnostics file offered by the panel.

## Story: Keep an owned, ordered record of the help the participant reports

### A report carries only the fixed vocabulary and the exact owned task scope

The product stores in `task_support_events_v1`, stamps source `participant-reported`, and caps a task at 500 events. The generic store validates its configured SQL identifier, source and positive maximum up to 10,000. It requires a callable product decoder. It captures the nonempty agent, actor, connector source and connector account strings in that exact order into its owner key, and requires a nonempty task ID. The snapshot of this owner tuple is copied before returning the task scope. Reads and writes recheck task existence for that exact owner. The task lookup shares the connection and does not open a nested transaction.

Product input has exactly event ID, expected epoch, kind and value. The ID is a lowercase UUID-shaped string, and the epoch is a nonnegative safe integer. A support-report value is alone, eliza or unknown. Help-requested, help-received and setup-help accept a caregiver, researcher, engineer or other. Human is derived from a help-received record. The decoder rejects free text or caller-supplied envelope fields. The model takes UUID and field-shape checks as codec facts.

```quint
type SupportInput = { exactKeys: bool, uuidShape: bool, expectedEpoch: int, kind: str, value: str }
type EvidenceConfig = { identifierSafe: bool, sourceNonempty: bool, validatorPort: bool, maxEvents: int }
type EvidenceOwner = { agent: str, actor: str, connectorSource: str, account: str, taskId: str }
pure def safeSupportNumber(number: int): bool = number >= 0 and number <= 9007199254740991
pure def supportRole(role: str): bool = Set("caregiver", "researcher", "engineer", "other").contains(role)
pure def supportInputValid(submission: SupportInput): bool =
  submission.exactKeys and submission.uuidShape and safeSupportNumber(submission.expectedEpoch) and
  (if (submission.kind == "support-report") Set("alone", "eliza", "unknown").contains(submission.value)
   else Set("help-requested", "help-received", "setup-help").contains(submission.kind) and supportRole(submission.value))
pure def configAdmitted(config: EvidenceConfig): bool =
  config.identifierSafe and config.sourceNonempty and config.validatorPort and config.maxEvents >= 1 and config.maxEvents <= 10000
pure def scopeOwnerValid(owner: EvidenceOwner): bool =
  owner.agent != "" and owner.actor != "" and owner.connectorSource != "" and owner.account != "" and owner.taskId != ""
pure def lawHumanCannotBeReportedDirectly(submission: SupportInput): bool =
  submission.kind == "support-report" and submission.value == "human" implies not(supportInputValid(submission))
pure val helpInput: SupportInput = { exactKeys: true, uuidShape: true, expectedEpoch: 0, kind: "help-received", value: "caregiver" }
pure val submissionValues = Set(helpInput, { ...helpInput, exactKeys: false }, { ...helpInput, uuidShape: false }, { ...helpInput, expectedEpoch: -1 }, { ...helpInput, kind: "support-report", value: "alone" }, { ...helpInput, kind: "support-report", value: "human" }, { ...helpInput, value: "additional text" })
pure val supportConfig: EvidenceConfig = { identifierSafe: true, sourceNonempty: true, validatorPort: true, maxEvents: 500 }
pure val configValues = Set(supportConfig, { ...supportConfig, maxEvents: 0 }, { ...supportConfig, maxEvents: 10001 }, { ...supportConfig, identifierSafe: false })
pure val supportOwner: EvidenceOwner = { agent: "grace", actor: "person", connectorSource: "app", account: "account", taskId: "task" }
pure val ownerValues = Set(supportOwner, { ...supportOwner, taskId: "" }, { ...supportOwner, account: "" })
```

### Every read revalidates the complete append sequence and its database envelope

The store selects only the owned task's rows, ascending by sequence and up to the configured maximum plus one. A result over capacity fails. Each row must contain an object with valid product input and exactly the configured envelope in addition to that input. The envelope binds schema version 1, task ID, source, safe nonnegative timestamp, and sequence. Sequence is contiguous from one and matches both the row's indexed sequence and position. The indexed event ID must match the event. A malformed document, a missing earlier sequence or an invalid returned row rejects the read. A valid legacy row is readable without rewriting its stored bytes.

Plain reads and record operations run inside BEGIN IMMEDIATE and COMMIT. Invalid input is refused before record opens its transaction. A work or commit error causes rollback then propagates the original error if rollback succeeded. A rollback failure returns `TASK_EVIDENCE_STORAGE_UNCERTAIN` and the caller must discard that connection. A failure starting the transaction propagates directly. The model receives row decoding and SQLite operation results as boundary facts.

```quint
type RowFacts = { jsonObject: bool, validProductInput: bool, versionOne: bool, taskMatches: bool, sourceMatches: bool, indexMatches: bool, eventIdMatches: bool, exactEnvelope: bool, sequence: int, at: int }
pure def rowValid(rowFacts: RowFacts): bool =
  rowFacts.jsonObject and rowFacts.validProductInput and rowFacts.versionOne and rowFacts.taskMatches and rowFacts.sourceMatches and rowFacts.indexMatches and rowFacts.eventIdMatches and rowFacts.exactEnvelope and safeSupportNumber(rowFacts.at)
type EvidenceRead = { taskOwned: bool, maximum: int, rows: List[RowFacts] }
type SequenceWalk = { nextSequence: int, valid: bool }
pure def checkRow(walk: SequenceWalk, rowFacts: RowFacts): SequenceWalk =
  { nextSequence: walk.nextSequence + 1, valid: walk.valid and rowValid(rowFacts) and walk.nextSequence == rowFacts.sequence }
pure def evidenceReadable(readFacts: EvidenceRead): bool =
  readFacts.taskOwned and readFacts.rows.length() <= readFacts.maximum and
  readFacts.rows.foldl({ nextSequence: 1, valid: true }, checkRow).valid
type EvidenceTransaction = { began: bool, workSucceeded: bool, commitSucceeded: bool, rollbackSucceeded: bool }
pure def transactionResult(transaction: EvidenceTransaction): str =
  if (not(transaction.began)) "begin-error"
  else if (transaction.workSucceeded and transaction.commitSucceeded) "committed"
  else if (transaction.rollbackSucceeded) "rolled-back"
  else "TASK_EVIDENCE_STORAGE_UNCERTAIN"
pure def lawRollbackFailureCannotBeCommitted(transaction: EvidenceTransaction): bool =
  transaction.began and not(transaction.workSucceeded and transaction.commitSucceeded) and not(transaction.rollbackSucceeded) implies transactionResult(transaction) == "TASK_EVIDENCE_STORAGE_UNCERTAIN"
pure def lawForeignHistoryCannotBeRead(readFacts: EvidenceRead): bool =
  not(readFacts.taskOwned) implies not(evidenceReadable(readFacts))
pure val goodRow: RowFacts = { jsonObject: true, validProductInput: true, versionOne: true, taskMatches: true, sourceMatches: true, indexMatches: true, eventIdMatches: true, exactEnvelope: true, sequence: 1, at: 10 }
pure val rowFactsValues = Set(goodRow, { ...goodRow, sourceMatches: false }, { ...goodRow, indexMatches: false }, { ...goodRow, jsonObject: false }, { ...goodRow, at: -1 })
pure val readFactsValues = Set(
  { taskOwned: true, maximum: 500, rows: List() },
  { taskOwned: true, maximum: 500, rows: List(goodRow) },
  { taskOwned: true, maximum: 500, rows: List({ ...goodRow, sequence: 2 }) },
  { taskOwned: false, maximum: 500, rows: List(goodRow) },
  { taskOwned: true, maximum: 1, rows: List(goodRow, { ...goodRow, sequence: 2 }) })
pure val walkValues = Set({ nextSequence: 1, valid: true }, { nextSequence: 2, valid: true }, { nextSequence: 2, valid: false })
pure val committedReport: EvidenceTransaction = { began: true, workSucceeded: true, commitSucceeded: true, rollbackSucceeded: true }
pure val transactionValues = Set(committedReport, { ...committedReport, began: false }, { ...committedReport, workSucceeded: false }, { ...committedReport, commitSucceeded: false, rollbackSucceeded: false })
```

### A repeat returns the exact previous event while a new append needs the present epoch

Record validates the input and owner, then reads the complete owned history inside its transaction. The same event ID and deep-equal decoded input returns the existing event without changing its sequence, timestamp, source or bytes. A conflicting input with the same ID is refused. This repeat path runs before comparing current epoch or capacity, so a prior accepted event can still be acknowledged after the task moved. A new ID needs the current task epoch and spare capacity. It takes one safe nonnegative host timestamp and appends at the next sequence. Neither a support report nor a resend can act on the website or modify its task epoch.

```quint
type SupportWrite = { productValid: bool, owned: bool, historyValid: bool, prior: bool, exactRepeat: bool, inputEpoch: int, taskEpoch: int, historyLength: int, maximum: int, time: int }
pure def supportWrite(writeFacts: SupportWrite): str =
  if (not(writeFacts.productValid and writeFacts.owned and writeFacts.historyValid)) "invalid"
  else if (writeFacts.prior) (if (writeFacts.exactRepeat) "previous" else "invalid")
  else if (writeFacts.inputEpoch != writeFacts.taskEpoch or writeFacts.historyLength >= writeFacts.maximum or not(safeSupportNumber(writeFacts.time))) "invalid"
  else "append"
pure def lawNewWriteNeedsCurrentEpoch(writeFacts: SupportWrite): bool =
  supportWrite(writeFacts) == "append" implies writeFacts.owned and writeFacts.historyValid and not(writeFacts.prior) and writeFacts.inputEpoch == writeFacts.taskEpoch and writeFacts.historyLength < writeFacts.maximum
pure def lawOldExactDeliveryHasOriginalReceipt(writeFacts: SupportWrite): bool =
  writeFacts.productValid and writeFacts.owned and writeFacts.historyValid and writeFacts.prior and writeFacts.exactRepeat implies supportWrite(writeFacts) == "previous"
pure val writeNew: SupportWrite = { productValid: true, owned: true, historyValid: true, prior: false, exactRepeat: false, inputEpoch: 1, taskEpoch: 1, historyLength: 0, maximum: 500, time: 1000 }
pure val writeFactsValues = Set(writeNew, { ...writeNew, owned: false }, { ...writeNew, historyValid: false }, { ...writeNew, inputEpoch: 0 }, { ...writeNew, prior: true, exactRepeat: true, inputEpoch: 0, historyLength: 500 }, { ...writeNew, prior: true }, { ...writeNew, historyLength: 500 }, { ...writeNew, time: -1 })
```

### The summary separates reported assistance from requested and setup help

The support receipt includes task ID, the ordered events and a summary. Any help-received record makes mode human and source participant-reported. Otherwise the last support-report supplies the mode, including explicit unknown. Without either event, mode is unknown and source missing. Requested and setup assistance have separate role lists and do not themselves establish who helped during the task. Each role list is sorted and deduplicated in the product projection.

```quint
type ReportedSupport = { kind: str, value: str }
type SupportSummary = { mode: str, source: str, humanRoles: List[str], requestedRoles: List[str], setupRoles: List[str] }
pure val emptySummary: SupportSummary = { mode: "unknown", source: "missing", humanRoles: List(), requestedRoles: List(), setupRoles: List() }
pure def recordSupportRole(knownRoles: List[str], role: str): List[str] =
  if (knownRoles.includes(role)) knownRoles else knownRoles.append(role)
pure def addSupport(summary: SupportSummary, report: ReportedSupport): SupportSummary =
  if (report.kind == "help-received") { ...summary, mode: "human", source: "participant-reported", humanRoles: recordSupportRole(summary.humanRoles,report.value) }
  else if (report.kind == "help-requested") { ...summary, requestedRoles: recordSupportRole(summary.requestedRoles,report.value) }
  else if (report.kind == "setup-help") { ...summary, setupRoles: recordSupportRole(summary.setupRoles,report.value) }
  else if (report.kind == "support-report" and summary.humanRoles.length() == 0) { ...summary, mode: report.value, source: "participant-reported" }
  else summary
pure def summarizeSupport(reports: List[ReportedSupport]): SupportSummary = reports.foldl(emptySummary, addSupport)
pure def orderedSupportRoles(recordedRoles: List[str]): List[str] =
  List("caregiver", "engineer", "other", "researcher").select(role => recordedRoles.includes(role))
pure def lawReportedHelperTakesPrecedence(summary: SupportSummary, report: ReportedSupport): bool =
  report.kind == "help-received" implies addSupport(summary, report).mode == "human" and addSupport(summary, report).humanRoles.includes(report.value)
pure def lawSetupAndRequestedHelpDoNotChangeMode(summary: SupportSummary, report: ReportedSupport): bool =
  report.kind == "help-requested" or report.kind == "setup-help" implies addSupport(summary, report).mode == summary.mode and addSupport(summary, report).source == summary.source
pure val reportValues = Set({ kind: "support-report", value: "alone" }, { kind: "support-report", value: "unknown" }, { kind: "help-received", value: "caregiver" }, { kind: "setup-help", value: "engineer" }, { kind: "help-requested", value: "researcher" })
pure val reportsValues = Set(List(), List({ kind: "help-requested", value: "caregiver" }), List({ kind: "support-report", value: "unknown" }), List({ kind: "help-received", value: "engineer" }, { kind: "support-report", value: "alone" }))
pure val summaryValues = Set(emptySummary, { ...emptySummary, mode: "human", source: "participant-reported", humanRoles: List("engineer") })
```

## Story: Retry the same help report when the save reply is lost

### The route owns admission and the renderer keeps one frozen report until acknowledgement

GET and POST are the only support methods. Route lookup requires the bound task, with 404 if its runtime lookup throws. A POST reads bounded JSON of at most 1024 bytes, rejects null with 400, rechecks current authority, records, then reads the summary. Store, parser and other exceptions in the route's try block project to `TASK_SUPPORT_UNAVAILABLE` with 409. An explicit POST owner check failure returns the gateway's unauthorized reply. A committed report can outlive the subsequent response read failure. The route uses its owner-scoped evidence store for both methods.

The renderer permits one current load or save at a time. On first save it reads the task ID and exact safe nonnegative epoch, creates one UUID and stores a help-received choice. A failed task lookup does not create a submission. Before posting it holds the event ID, epoch and role. A failed save read retains all three. Another tap posts the same held input without a fresh task lookup. A current matching summary response clears the hold. A reply requires the same task ID and a human roles array of allowed roles. An old answer after task selection changes cannot update the renderer or clear the new request. The model uses one current screen task generation and the host's success or refusal as input.

Discovered by the proof: the post count and symbolic held identity are
nonnegative, with zero denoting no held report. This keeps both initial
submission and retry tied to a real held report.

```quint
type SupportRoute = { method: str, taskFound: bool, jsonRead: bool, jsonNull: bool, ownerCurrent: bool, storeAnswered: bool }
pure def supportRoute(routeFacts: SupportRoute): str =
  if (not(Set("GET", "POST").contains(routeFacts.method))) "405"
  else if (not(routeFacts.taskFound)) "404"
  else if (routeFacts.method == "POST" and not(routeFacts.jsonRead)) "409"
  else if (routeFacts.method == "POST" and routeFacts.jsonNull) "400"
  else if (routeFacts.method == "POST" and not(routeFacts.ownerCurrent)) "unauthorized"
  else if (not(routeFacts.storeAnswered)) "409"
  else "200"
pure def supportReplyValid(taskMatches: bool, rolesArray: bool, roles: List[str]): bool =
  taskMatches and rolesArray and roles.every(supportRole)
pure def lawPostAuthorityPrecedesStore(routeFacts: SupportRoute): bool =
  routeFacts.method == "POST" and supportRoute(routeFacts) == "200" implies routeFacts.ownerCurrent and routeFacts.taskFound and routeFacts.jsonRead and not(routeFacts.jsonNull)
pure val routeReady: SupportRoute = { method: "POST", taskFound: true, jsonRead: true, jsonNull: false, ownerCurrent: true, storeAnswered: true }
pure val routeFactsValues = Set(routeReady, { ...routeReady, method: "GET" }, { ...routeReady, method: "PUT" }, { ...routeReady, taskFound: false }, { ...routeReady, jsonRead: false }, { ...routeReady, jsonNull: true }, { ...routeReady, ownerCurrent: false }, { ...routeReady, storeAnswered: false })
pure val rolesValues = Set(List(), List("engineer"), List("caregiver", "other"), List("not-a-role"))
type HeldReport = { identity: int, epoch: int, role: str }
type SupportScreen = { generation: int, held: HeldReport, phase: str, postCount: int }
pure val noReport: HeldReport = { identity: 0, epoch: 0, role: "" }
pure val initial: SupportScreen = { generation: 0, held: noReport, phase: "idle", postCount: 0 }
pure def canBeginSupportSave(screen: SupportScreen): bool = screen.phase == "idle"
pure def beginSupportSave(screen: SupportScreen): SupportScreen =
  if (screen.held.identity > 0) { ...screen, phase: "posting", postCount: screen.postCount + 1 }
  else { ...screen, phase: "reading" }
pure def canAcceptTaskDetail(screen: SupportScreen, ticket: int, chosen: HeldReport, sameTask: bool): bool =
  screen.phase == "reading" and ticket == screen.generation and chosen.identity > 0 and safeSupportNumber(chosen.epoch) and supportRole(chosen.role) and sameTask
pure def acceptTaskDetail(screen: SupportScreen, ticket: int, chosen: HeldReport, sameTask: bool): SupportScreen =
  { ...screen, held: chosen, phase: "posting", postCount: screen.postCount + 1 }
pure def canFailTaskDetail(screen: SupportScreen, ticket: int): bool = screen.phase == "reading" and screen.generation == ticket
pure def failTaskDetail(screen: SupportScreen, ticket: int): SupportScreen = { ...screen, phase: "idle" }
pure def canSettleSupportPost(screen: SupportScreen, ticket: int): bool = screen.phase == "posting" and screen.generation == ticket
pure def settleSupportPost(screen: SupportScreen, ticket: int, admittedReply: bool): SupportScreen =
  { ...screen, phase: "idle", held: if (admittedReply) noReport else screen.held }
pure def changeSupportTask(screen: SupportScreen): SupportScreen =
  { generation: screen.generation + 1, held: noReport, phase: "idle", postCount: 0 }
pure def alwaysSupportCounterAndIdentityAreNonnegative(screen: SupportScreen): bool =
  screen.postCount >= 0 and screen.held.identity >= 0
pure def alwaysPostHasInput(screen: SupportScreen): bool =
  screen.phase == "posting" implies screen.held.identity > 0 and screen.postCount > 0
pure def alwaysTaskReadHasNoHeldInput(screen: SupportScreen): bool = screen.phase == "reading" implies screen.held.identity == 0
pure def stepHeldReportStaysOnRetry(before: SupportScreen, via: str, after: SupportScreen): bool =
  before.held.identity > 0 and via == "beginSupportSave" implies after.held.identity == before.held.identity and after.held.epoch == before.held.epoch and after.held.role == before.held.role
pure def sometimesAwaitingSave(screen: SupportScreen): bool = screen.phase == "posting"
pure def sometimesHeldForRetry(screen: SupportScreen): bool = screen.phase == "idle" and screen.held.identity > 0
pure def sometimesRetried(screen: SupportScreen): bool = screen.phase == "posting" and screen.postCount > 1
pure val ticketValues = Set(0, 1, 2)
pure val chosenValues = Set(noReport, { identity: 1, epoch: 1, role: "engineer" }, { identity: 2, epoch: 3, role: "caregiver" }, { identity: 3, epoch: -1, role: "other" })
pure val weight_beginSupportSave = 14
pure val weight_acceptTaskDetail = 14
pure val weight_settleSupportPost = 14
```

The originals cover real SQLite transactions, legacy rows and controlled browser rendering. The model does not implement storage, authorization, or the optional diagnostics file export. The renderer receipt remains evidence of the participant's report.
