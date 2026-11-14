# Typed phone workflow authoring

AlphaPhone imports `validatePhoneWorkflowSpec`, `parsePhoneWorkflowCatalog`,
`assertPhoneWorkflowCapabilities` and `parsePhoneWorkflowSaveReceipt` from
`packages/contracts/src/phone-workflow.ts`. Its authoring also uses
`checkWorkflowScope` from `workflow-scope.ts` before asking for generation.
The pinned agent normalizes the same typed input before compiling it.
AlphaPhone's `WorkflowAuthoring.qnt` covers reviewed save admission.

## Story: Review the exact typed workflow that my agent will save

### A draft uses the advertised operation catalog and only earlier step outputs

Each decoded step has a unique validated ID and correct kind, operation
and fields. Steps that consume output must name an earlier step. Read
steps have no predecessor. Input and canonical JSON must each fit 64 KiB,
and the draft has one to 32 steps. A device operation requires a verified
installation and enrollment. The installed protocol is at least two for
foreground presentation, three for selected reminders and five for
calendar ranges relative to the run. The advertised catalog admits the
trigger and every step. Recognized unsupported phrases are refused
before generation. Wording which passes that filter still must pass the
same typed catalog. The shell supplies byte sizes, normalized operations,
and field validation. The model retains the order needed to enforce
predecessor and uniqueness constraints.

```quint
type StepKind = ReadStep | IfStep | WriteStep | NotifyStep | SpeakStep
type PhoneOperation = SuppliedText | SelectedNotes | SelectedReminders | CalendarRange | ContainsText | ComposeDraft | ModelDraft | SaveNote | AppNotification | ReadAloud
type StepShape = { id: str, source: str, kind: StepKind, operation: PhoneOperation, fieldsValid: bool, catalogAvailable: bool, relativeCalendar: bool }
type DraftFacts = { inputBytes: int, canonicalBytes: int, schemaValid: bool, triggerAvailable: bool, phoneEnrolled: bool, phoneProtocol: int }
type StepCheck = { valid: bool, seen: List[str] }
pure def operationKind(operation: PhoneOperation): StepKind =
  if (operation == SuppliedText or operation == SelectedNotes or operation == SelectedReminders or operation == CalendarRange) ReadStep
  else if (operation == ContainsText) IfStep
  else if (operation == AppNotification) NotifyStep
  else if (operation == ReadAloud) SpeakStep
  else WriteStep
pure def usesDevice(operation: PhoneOperation): bool = operation == SelectedNotes or operation == SelectedReminders or operation == CalendarRange or operation == SaveNote or operation == AppNotification or operation == ReadAloud
pure def requiredProtocol(stepShape: StepShape): int =
  if (stepShape.operation == CalendarRange and stepShape.relativeCalendar) 5
  else if (stepShape.operation == SelectedReminders) 3
  else if (stepShape.operation == AppNotification or stepShape.operation == ReadAloud) 2
  else 1
pure def acceptsDraft(draft: DraftFacts, steps: List[StepShape]): bool =
  draft.schemaValid and draft.triggerAvailable and draft.inputBytes >= 0 and draft.inputBytes <= 65536 and draft.canonicalBytes >= 0 and draft.canonicalBytes <= 65536 and steps.length() >= 1 and steps.length() <= 32 and
    steps.foldl({ valid: true, seen: List() }, (checked, stepInput) => {
      { valid: checked.valid and stepInput.id != "" and not(checked.seen.includes(stepInput.id)) and stepInput.fieldsValid and stepInput.catalogAvailable and stepInput.kind == operationKind(stepInput.operation) and (stepInput.kind == ReadStep or checked.seen.includes(stepInput.source)) and (not(usesDevice(stepInput.operation)) or (draft.phoneEnrolled and draft.phoneProtocol >= requiredProtocol(stepInput))), seen: checked.seen.append(stepInput.id) }
    }).valid
pure val readKind: StepKind = ReadStep
pure val writeKind: StepKind = WriteStep
pure val readTextOp: PhoneOperation = SuppliedText
pure val saveNoteOp: PhoneOperation = SaveNote
pure val sampleRead: StepShape = { id: "first", source: "", kind: readKind, operation: readTextOp, fieldsValid: true, catalogAvailable: true, relativeCalendar: false }
pure val sampleWrite: StepShape = { id: "second", source: "first", kind: writeKind, operation: saveNoteOp, fieldsValid: true, catalogAvailable: true, relativeCalendar: false }
pure val stepsValues = Set(List(), List(sampleRead), List(sampleRead, sampleWrite), List(sampleWrite, sampleRead), List(sampleRead, sampleRead))
pure val draftValues = Set(
  { inputBytes: 1000, canonicalBytes: 1000, schemaValid: true, triggerAvailable: true, phoneEnrolled: true, phoneProtocol: 5 },
  { inputBytes: 1000, canonicalBytes: 1000, schemaValid: true, triggerAvailable: true, phoneEnrolled: false, phoneProtocol: 0 },
  { inputBytes: 65537, canonicalBytes: 1000, schemaValid: true, triggerAvailable: true, phoneEnrolled: true, phoneProtocol: 5 })
pure def lawOversizedDraftRefused(draft: DraftFacts, steps: List[StepShape]): bool = (draft.inputBytes > 65536 or draft.canonicalBytes > 65536) implies not(acceptsDraft(draft, steps))
pure def lawStepCountBound(draft: DraftFacts, steps: List[StepShape]): bool = acceptsDraft(draft, steps) implies steps.length() > 0 and steps.length() <= 32
```

### A save receipt identifies the reviewed bytes and compiler

The result is accepted only for the exact mutation ID, canonical spec
SHA-256, compiler revision, create/edit discriminant, previous version,
and edited definition ID when present. The result has a valid fresh
version, definition ID and a bounded applied-time field. HTTP response
or model output alone is not evidence of a successful reviewed save.

```quint
type SaveFacts = { validShape: bool, mutationMatches: bool, digestMatches: bool, compilerMatches: bool, operationMatches: bool, previousVersionMatches: bool, workflowMatches: bool, hasExistingWorkflow: bool }
pure def admitsSaveReceipt(save: SaveFacts): bool = save.validShape and save.mutationMatches and save.digestMatches and save.compilerMatches and save.operationMatches and save.previousVersionMatches and (not(save.hasExistingWorkflow) or save.workflowMatches)
pure val saveValues = Set(
  { validShape: true, mutationMatches: true, digestMatches: true, compilerMatches: true, operationMatches: true, previousVersionMatches: true, workflowMatches: true, hasExistingWorkflow: true },
  { validShape: true, mutationMatches: true, digestMatches: false, compilerMatches: true, operationMatches: true, previousVersionMatches: true, workflowMatches: true, hasExistingWorkflow: true })
pure def lawSaveCannotSubstituteBytes(save: SaveFacts): bool = admitsSaveReceipt(save) implies save.mutationMatches and save.digestMatches and save.compilerMatches and save.previousVersionMatches
```
