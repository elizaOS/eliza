# Device operations

The closed set of operations the agent may propose to an enrolled device,
shared by the proposal service and the device executor. Each operation has
one wire type, belongs to one family, and needs the capabilities its request
negotiated ([capabilities](./capabilities.md)). The exact keys of each
operation, its result shape and the wire schemas are the agent's
(`device-actions/operations.schema.vibe`); the bounds of each field are owned
where the data is: [calendar availability](../../calendar/availability.md),
[note reads](../../notes/read.md), the [workflow](../../workflow/index.md)
device protocol, and the os executor specs for telephony, camera, photos and
files. The [device request](./index.md) owns offer, claim and settlement;
this spec decides which proposals are well formed and what a receipt may
claim.

## Story: Propose only operations the device can check

> As a device owner, I want the agent to propose only operations from a
> closed list, each with exactly its own fields and only when my device
> negotiated what it needs, so that my device never receives an operation it
> cannot check.

### The operation vocabulary is closed, and each wire type belongs to one family

Every operation has one wire type. A named calendar review is one wire type
whose read and edit need different capabilities, so it is two operations
here; no other two operations share a wire type.

```quint
import capabilities.* from "./capabilities"
type OperationType =
  CalendarCreateLocal | CalendarReadNext | CalendarCreate | CalendarReadSelected | CalendarUpdate | CalendarDelete
  | ReminderReadSelected | ReminderUpdate | ReminderComplete | ReminderSnooze | ReminderCancel | ReminderCreate
  | CameraCapturePhoto | FilesFilter | FilesOpen | FilesShare | FilesMove | FilesTrash | FilesFolderCreate
  | CalendarAvailability | NotesSearch | NotesNamed | CalendarNamedRead | CalendarNamedEdit | ReminderNamed
  | MapsReadSelected | NotesReadSelected | NotesUpdate | NotesDelete
  | NotesFilter | NotesListFilter | NotesMove | NotesFolderCreate | NotesRestore | NotesRecord | NotesQuery
  | PhotoLibrarySearch | PhotoLibraryInspect | PhotoLibrarySelect | PhotoLibraryReview
  | PhotosFilter | PhotosOpen | PhotosAlbumCreate | PhotosShare
  | SmsSend | MmsSend | PhoneDial | PhoneCall | ContactCreate | ContactUpdate | ContactDelete | SmsCompose | SmsReplySelected
  | MessagesReadSelected | VoicemailReadSelected | VoicemailDeleteSelected | ClockHandoff
  | ReadSelectedNotes | ReadCalendarRange | ReadSelectedReminders | PostNotification | SpeakText
  | CreateNote | CreateReminder | OpenView | BrowserNavigate
type Family = CalendarFamily | ReminderFamily | ReminderCreateFamily | CameraFamily | FilesFamily | ReviewFamily | MapsFamily | NotesFamily
  | NotesOrganizeFamily | NotesQueryFamily | PhotoLibraryFamily | PhotosViewFamily | TelephonyFamily | ClockFamily | WorkflowFamily | BaseFamily
pure def wireType(t: OperationType): str = match t {
  | CalendarCreateLocal => "calendar_create_local" | CalendarReadNext => "calendar_read_next" | CalendarCreate => "calendar_create"
  | CalendarReadSelected => "calendar_read_selected" | CalendarUpdate => "calendar_update" | CalendarDelete => "calendar_delete"
  | ReminderReadSelected => "reminder_read_selected" | ReminderUpdate => "reminder_update" | ReminderComplete => "reminder_complete"
  | ReminderSnooze => "reminder_snooze" | ReminderCancel => "reminder_cancel" | ReminderCreate => "reminder_create"
  | CameraCapturePhoto => "camera_capture_photo" | FilesFilter => "files_filter" | FilesOpen => "files_open" | FilesShare => "files_share"
  | FilesMove => "files_move" | FilesTrash => "files_trash" | FilesFolderCreate => "files_folder_create"
  | CalendarAvailability => "calendar_availability" | NotesSearch => "notes_search" | NotesNamed => "notes_named"
  | CalendarNamedRead => "calendar_named" | CalendarNamedEdit => "calendar_named" | ReminderNamed => "reminder_named"
  | MapsReadSelected => "maps_read_selected" | NotesReadSelected => "notes_read_selected" | NotesUpdate => "notes_update" | NotesDelete => "notes_delete"
  | NotesFilter => "notes_filter" | NotesListFilter => "notes_list_filter" | NotesMove => "notes_move" | NotesFolderCreate => "notes_folder_create"
  | NotesRestore => "notes_restore" | NotesRecord => "notes_record" | NotesQuery => "notes_query"
  | PhotoLibrarySearch => "photo_library_search" | PhotoLibraryInspect => "photo_library_inspect" | PhotoLibrarySelect => "photo_library_select"
  | PhotoLibraryReview => "photo_library_review" | PhotosFilter => "photos_filter" | PhotosOpen => "photos_open"
  | PhotosAlbumCreate => "photos_album_create" | PhotosShare => "photos_share"
  | SmsSend => "sms_send" | MmsSend => "mms_send" | PhoneDial => "phone_dial" | PhoneCall => "phone_call" | ContactCreate => "contact_create"
  | ContactUpdate => "contact_update" | ContactDelete => "contact_delete" | SmsCompose => "sms_compose" | SmsReplySelected => "sms_reply_selected"
  | MessagesReadSelected => "messages_read_selected" | VoicemailReadSelected => "voicemail_read_selected"
  | VoicemailDeleteSelected => "voicemail_delete_selected" | ClockHandoff => "clock_handoff"
  | ReadSelectedNotes => "read_selected_notes" | ReadCalendarRange => "read_calendar_range" | ReadSelectedReminders => "read_selected_reminders"
  | PostNotification => "post_notification" | SpeakText => "speak_text"
  | CreateNote => "create_note" | CreateReminder => "create_reminder" | OpenView => "open_view" | BrowserNavigate => "browser_navigate"
}
pure def family(t: OperationType): Family = match t {
  | CalendarCreateLocal => CalendarFamily | CalendarReadNext => CalendarFamily | CalendarCreate => CalendarFamily
  | CalendarReadSelected => CalendarFamily | CalendarUpdate => CalendarFamily | CalendarDelete => CalendarFamily
  | ReminderReadSelected => ReminderFamily | ReminderUpdate => ReminderFamily | ReminderComplete => ReminderFamily
  | ReminderSnooze => ReminderFamily | ReminderCancel => ReminderFamily | ReminderCreate => ReminderCreateFamily
  | CameraCapturePhoto => CameraFamily | FilesFilter => FilesFamily | FilesOpen => FilesFamily | FilesShare => FilesFamily
  | FilesMove => FilesFamily | FilesTrash => FilesFamily | FilesFolderCreate => FilesFamily
  | CalendarAvailability => ReviewFamily | NotesSearch => ReviewFamily | NotesNamed => ReviewFamily
  | CalendarNamedRead => ReviewFamily | CalendarNamedEdit => ReviewFamily | ReminderNamed => ReviewFamily
  | MapsReadSelected => MapsFamily | NotesReadSelected => NotesFamily | NotesUpdate => NotesFamily | NotesDelete => NotesFamily
  | NotesFilter => NotesOrganizeFamily | NotesListFilter => NotesOrganizeFamily | NotesMove => NotesOrganizeFamily
  | NotesFolderCreate => NotesOrganizeFamily | NotesRestore => NotesOrganizeFamily | NotesRecord => NotesOrganizeFamily | NotesQuery => NotesQueryFamily
  | PhotoLibrarySearch => PhotoLibraryFamily | PhotoLibraryInspect => PhotoLibraryFamily | PhotoLibrarySelect => PhotoLibraryFamily
  | PhotoLibraryReview => PhotoLibraryFamily | PhotosFilter => PhotosViewFamily | PhotosOpen => PhotosViewFamily
  | PhotosAlbumCreate => PhotosViewFamily | PhotosShare => PhotosViewFamily
  | SmsSend => TelephonyFamily | MmsSend => TelephonyFamily | PhoneDial => TelephonyFamily | PhoneCall => TelephonyFamily
  | ContactCreate => TelephonyFamily | ContactUpdate => TelephonyFamily | ContactDelete => TelephonyFamily | SmsCompose => TelephonyFamily
  | SmsReplySelected => TelephonyFamily | MessagesReadSelected => TelephonyFamily | VoicemailReadSelected => TelephonyFamily
  | VoicemailDeleteSelected => TelephonyFamily | ClockHandoff => ClockFamily
  | ReadSelectedNotes => WorkflowFamily | ReadCalendarRange => WorkflowFamily | ReadSelectedReminders => WorkflowFamily
  | PostNotification => WorkflowFamily | SpeakText => WorkflowFamily
  | CreateNote => BaseFamily | CreateReminder => BaseFamily | OpenView => BaseFamily | BrowserNavigate => BaseFamily
}
pure def lawOneWireTypeIsOneOperation(a: OperationType, b: OperationType): bool =
  wireType(a) == wireType(b) implies (a == b or (family(a) == ReviewFamily and wireType(a) == "calendar_named"))
```

### Each operation needs the capabilities of its family, and a clock-only device receives only clock handoffs

`versionTwo` marks a reminder read or edit whose target or timing is
version two, a named reminder edit that sets alert minutes, and a Clock
handoff that carries its own repeat days. The base and workflow operations
need any capability other than the Clock handoff, so a device that
advertised only the Clock handoff never receives them. Every operation
names a need, so none is impossible by construction.

```quint
pure def needAll(a: Capability, b: Capability): Need = { required: Set(a).union(Set(b)), oneOf: Set() }
pure val anyButClock: Need = { required: Set(), oneOf: allCapabilities.exclude(Set(ClockHandoffV1, ClockHandoffV2)) }
pure def operationNeed(t: OperationType, versionTwo: bool): Need = familyNeed(family(t), t, versionTwo)
pure def familyNeed(f: Family, t: OperationType, versionTwo: bool): Need = match f {
  | CalendarFamily => if (t == CalendarCreateLocal) needOne(CalendarCreateV1) else if (t == CalendarReadNext) needOne(CalendarNextReadV1) else needOne(CalendarLocalEventV1)
  | ReminderFamily => reminderRecordNeed(versionTwo)
  | ReminderCreateFamily => needOne(RemindersCreateV1)
  | CameraFamily => needOne(CameraCapturePhotoV1)
  | FilesFamily => needOne(FilesBrowserV1)
  | ReviewFamily =>
      if (t == CalendarAvailability) needOne(CalendarAvailabilityReadV1)
      else if (t == NotesSearch) needAll(NotesSearchV1, NotesLocalRecordV1)
      else if (t == NotesNamed) needAll(NamedTargetV1, NotesLocalRecordV1)
      else if (t == CalendarNamedRead) needAll(CalendarNamedReadV1, CalendarLocalEventV1)
      else if (t == CalendarNamedEdit) needAll(NamedTargetV1, CalendarLocalEventV1)
      else if (versionTwo) needAll(NamedTargetV1, RemindersLocalRecordV2)
      else { required: Set(NamedTargetV1), oneOf: Set(RemindersLocalRecordV1, RemindersLocalRecordV2) }
  | MapsFamily => needOne(MapsSelectedReadV1)
  | NotesFamily => needOne(NotesLocalRecordV1)
  | NotesOrganizeFamily => if (t == NotesListFilter) needOne(NotesListFilterV1) else needAll(NotesOrganizeV1, NotesLocalRecordV1)
  | NotesQueryFamily => needAll(NotesQueryV1, NotesLocalRecordV1)
  | PhotoLibraryFamily => needOne(PhotosLibraryV1)
  | PhotosViewFamily => needAll(PhotosLibraryV1, PhotosViewV1)
  | TelephonyFamily =>
      if (t == SmsSend) needOne(SmsSendV1) else if (t == MmsSend) needOne(MmsSendV1) else if (t == PhoneDial) needOne(PhoneDialV1)
      else if (t == PhoneCall) needOne(PhoneCallV1) else if (t == SmsCompose or t == SmsReplySelected) needOne(SmsComposeV1)
      else if (t == MessagesReadSelected) needOne(MessagesReadV1) else if (t == VoicemailReadSelected) needOne(VoicemailReadV1)
      else if (t == VoicemailDeleteSelected) needOne(VoicemailDeleteV1) else needOne(ContactsWriteV1)
  | ClockFamily => clockHandoffNeed(versionTwo)
  | WorkflowFamily => anyButClock
  | BaseFamily => anyButClock
}
pure val negValues: Set[Negotiation] = Set(Refused, Negotiated({ capabilities: Set() }), Negotiated({ capabilities: Set(ClockHandoffV1) }),
  Negotiated({ capabilities: Set(ClockHandoffV1, ClockHandoffV2) }), Negotiated({ capabilities: Set(NamedTargetV1, RemindersLocalRecordV1, NotesLocalRecordV1) }),
  Negotiated({ capabilities: Set(NamedTargetV1, RemindersLocalRecordV2, CalendarAgendaReadV1, NotesQueryV1, NotesLocalRecordV1) }))
pure def clockOnly(neg: Negotiation): bool = allCapabilities.forall(c => negotiatedHas(neg, c) implies (c == ClockHandoffV1 or c == ClockHandoffV2))
pure def lawEveryOperationNamesANeed(t: OperationType, versionTwo: bool): bool =
  namesSome(operationNeed(t, versionTwo).required) or namesSome(operationNeed(t, versionTwo).oneOf)
pure def lawAClockOnlyDeviceReceivesOnlyClockHandoffs(t: OperationType, versionTwo: bool, neg: Negotiation): bool =
  (clockOnly(neg) and meets(neg, operationNeed(t, versionTwo))) implies t == ClockHandoff
pure def lawANamedEditNeedsTheNamedTarget(t: OperationType, versionTwo: bool, neg: Negotiation): bool =
  ((t == NotesNamed or t == CalendarNamedEdit or t == ReminderNamed) and meets(neg, operationNeed(t, versionTwo))) implies negotiatedHas(neg, NamedTargetV1)
pure def lawNewerReminderTimingIsNeverDowngraded(t: OperationType, neg: Negotiation): bool =
  ((family(t) == ReminderFamily or t == ReminderNamed) and meets(neg, operationNeed(t, true))) implies negotiatedHas(neg, RemindersLocalRecordV2)
```

### A proposal is valid only when its shape, its need and its binding all hold

`shapeValid` is the family schema's verdict: exactly the operation's own
keys, every field within the bounds of its owning spec. A workflow read or
presentation needs a workflow binding, except that a calendar range read may
instead be a standalone agenda read bound to the owner's message, which also
needs the agenda capability. No other operation may carry an agenda binding.
The proposal, decide and claim requests each validate against their own
negotiation.

```quint
type ReadBinding = NoBinding | WorkflowBinding | AgendaBinding
type Proposal = { opType: OperationType, versionTwo: bool, binding: ReadBinding, shapeValid: bool }
pure def bindingAdmitted(prop: Proposal, neg: Negotiation): bool =
  if (prop.binding == AgendaBinding) prop.opType == ReadCalendarRange and negotiatedHas(neg, CalendarAgendaReadV1)
  else family(prop.opType) != WorkflowFamily or prop.binding == WorkflowBinding
pure def validate(prop: Proposal, neg: Negotiation): bool = prop.shapeValid and meets(neg, operationNeed(prop.opType, prop.versionTwo)) and bindingAdmitted(prop, neg)
pure val propValues: Set[Proposal] = Set(
  { opType: ReadCalendarRange, versionTwo: false, binding: AgendaBinding, shapeValid: true },
  { opType: ReadSelectedNotes, versionTwo: false, binding: NoBinding, shapeValid: true },
  { opType: ReadSelectedNotes, versionTwo: false, binding: WorkflowBinding, shapeValid: true },
  { opType: NotesQuery, versionTwo: false, binding: AgendaBinding, shapeValid: true },
  { opType: NotesQuery, versionTwo: false, binding: NoBinding, shapeValid: true },
  { opType: NotesQuery, versionTwo: false, binding: NoBinding, shapeValid: false },
  { opType: ClockHandoff, versionTwo: true, binding: NoBinding, shapeValid: true })
pure def lawAWorkflowOperationIsBound(prop: Proposal, neg: Negotiation): bool =
  (validate(prop, neg) and family(prop.opType) == WorkflowFamily) implies (prop.binding == WorkflowBinding or (prop.opType == ReadCalendarRange and prop.binding == AgendaBinding))
pure def lawAStandaloneAgendaReadNegotiatedTheAgenda(prop: Proposal, neg: Negotiation): bool =
  (validate(prop, neg) and prop.binding == AgendaBinding) implies (prop.opType == ReadCalendarRange and negotiatedHas(neg, CalendarAgendaReadV1))
```

### Only filtering or opening an item, or starting a voice note, may run without a review

Filtering or opening files, filtering or listing notes, starting or stopping
a voice note in the open Notes view, and filtering or opening photos may run
without a review when bound to the owner's own current message. Every other operation is reviewed on the
device first; no phone, clock, photo library or sharing operation ever runs
directly.

```quint
pure def mayRunDirectly(t: OperationType): bool =
  t == FilesFilter or t == FilesOpen or t == NotesFilter or t == NotesListFilter or t == NotesRecord or t == PhotosFilter or t == PhotosOpen
pure def lawNoPhoneClockOrLibraryOperationRunsDirectly(t: OperationType): bool =
  mayRunDirectly(t) implies (family(t) != TelephonyFamily and family(t) != ClockFamily and family(t) != PhotoLibraryFamily and t != FilesShare and t != PhotosShare)
```

## Story: Learn exactly what the device did

> As a device owner, I want the agent to accept from my device only a
> receipt its own evidence supports, so that a send, a call or an edit is
> never reported as done, or as not done, without proof.

### A receipt is admitted only when its evidence agrees with what it reports

A receipt reports applied, failed or unknown, may name the native operation
and a failure code, and may carry a typed result. The family's result
function says what a valid result shows; it must show what the receipt
reports. Phone and Clock results are evidence: one is missing only from an
unknown receipt. Other reads and edits carry a result exactly when applied;
files, notes organizing, workflow presentations and the base operations
never carry one. An applied receipt names its native operation. An SMS or
MMS send, or a contact SMS, names the journal key of its claim, so a lost
response reconciles against one native row and never sends twice. A
failure the device reports as never dispatched, with no result, is admitted
for any operation.

```quint
type ReportedOutcome = ReportsApplied | ReportsFailed | ReportsUnknown
type FailureCode = NoCode | NotDispatched | OtherCode
type ResultEvidence = NoResult | InvalidResult | ValidResult({ shows: ReportedOutcome, nothingSubmitted: bool })
type DeviceReceipt = { reported: ReportedOutcome, operationId: str, code: FailureCode, result: ResultEvidence }
type EvidenceKind = OutcomeEvidence | ResultWhenApplied | NoResultEver
pure def evidenceOf(t: OperationType): EvidenceKind =
  if (family(t) == TelephonyFamily or family(t) == ClockFamily) OutcomeEvidence
  else if (family(t) == FilesFamily or family(t) == NotesOrganizeFamily or family(t) == BaseFamily or t == PostNotification or t == SpeakText) NoResultEver
  else ResultWhenApplied
pure def sharesSimJournal(t: OperationType): bool = t == SmsSend or t == MmsSend or t == SmsCompose
pure def agrees(e: ResultEvidence, reported: ReportedOutcome): bool = match e { | ValidResult(x) => x.shows == reported | NoResult => true | InvalidResult => false }
pure def notDispatchedFailure(r: DeviceReceipt): bool = r.reported == ReportsFailed and r.code == NotDispatched and r.result == NoResult
pure def resultAdmitted(t: OperationType, r: DeviceReceipt): bool =
  agrees(r.result, r.reported) and (
    if (evidenceOf(t) == OutcomeEvidence) r.result != NoResult or r.reported == ReportsUnknown
    else if (evidenceOf(t) == ResultWhenApplied) (r.result != NoResult) == (r.reported == ReportsApplied)
    else r.result == NoResult)
pure def receiptAdmitted(t: OperationType, r: DeviceReceipt, claimKey: str): bool =
  (r.reported != ReportsApplied or r.operationId != "") and
  (notDispatchedFailure(r) or (resultAdmitted(t, r) and (not(sharesSimJournal(t)) or r.operationId == claimKey)))
pure val rValues: Set[DeviceReceipt] = Set(
  { reported: ReportsApplied, operationId: "n1", code: NoCode, result: ValidResult({ shows: ReportsApplied, nothingSubmitted: false }) },
  { reported: ReportsApplied, operationId: "", code: NoCode, result: ValidResult({ shows: ReportsApplied, nothingSubmitted: false }) },
  { reported: ReportsApplied, operationId: "n1", code: NoCode, result: NoResult },
  { reported: ReportsFailed, operationId: "n1", code: NoCode, result: ValidResult({ shows: ReportsFailed, nothingSubmitted: true }) },
  { reported: ReportsFailed, operationId: "n1", code: NoCode, result: ValidResult({ shows: ReportsFailed, nothingSubmitted: false }) },
  { reported: ReportsFailed, operationId: "", code: NotDispatched, result: NoResult },
  { reported: ReportsFailed, operationId: "", code: OtherCode, result: NoResult },
  { reported: ReportsUnknown, operationId: "n1", code: NoCode, result: NoResult },
  { reported: ReportsUnknown, operationId: "n1", code: NoCode, result: ValidResult({ shows: ReportsApplied, nothingSubmitted: false }) },
  { reported: ReportsApplied, operationId: "n1", code: NoCode, result: InvalidResult })
pure val claimKeyValues = Set("n1", "n2")
pure def lawAnAppliedReceiptNamesItsNativeOperation(t: OperationType, r: DeviceReceipt, claimKey: str): bool =
  (receiptAdmitted(t, r, claimKey) and r.reported == ReportsApplied) implies r.operationId != ""
pure def lawEvidenceNeverContradictsTheReceipt(t: OperationType, r: DeviceReceipt, claimKey: str): bool =
  (receiptAdmitted(t, r, claimKey) and r.result != NoResult) implies (agrees(r.result, r.reported) and r.result != InvalidResult)
pure def lawPhoneEvidenceIsMissingOnlyFromAnUnknownReceipt(t: OperationType, r: DeviceReceipt, claimKey: str): bool =
  (receiptAdmitted(t, r, claimKey) and evidenceOf(t) == OutcomeEvidence and r.result == NoResult and not(notDispatchedFailure(r))) implies r.reported == ReportsUnknown
pure def lawASimSendNamesItsClaim(t: OperationType, r: DeviceReceipt, claimKey: str): bool =
  (receiptAdmitted(t, r, claimKey) and sharesSimJournal(t) and not(notDispatchedFailure(r))) implies r.operationId == claimKey
```

### Only an applied receipt settles applied, and only a trusted refusal settles that nothing ran

An admitted receipt settles the request: applied when it reports applied;
nothing ran when the device never dispatched, or when phone evidence shows
the owner cancelled or was denied a send, dismissed a contact SMS, or had
no conversation open for a reply draft (`nothingSubmitted`); otherwise the
request stays uncertain, because the device may have acted. The
[device request](./index.md) records these as `ReportedApplied`,
`ReportedNothingRan` and `ReportedUnknown`.

```quint
type Settlement = SettlesApplied | SettlesNothingRan | StaysUncertain
type ReceiptAdmission = ReceiptRefused | ReceiptAdmitted({ settles: Settlement })
pure def trustedRefusal(t: OperationType, r: DeviceReceipt): bool =
  evidenceOf(t) == OutcomeEvidence and r.result == ValidResult({ shows: ReportsFailed, nothingSubmitted: true })
pure def settlementOf(t: OperationType, r: DeviceReceipt): Settlement =
  if (r.reported == ReportsApplied) SettlesApplied
  else if (notDispatchedFailure(r) or trustedRefusal(t, r)) SettlesNothingRan
  else StaysUncertain
pure def receiptOutcome(t: OperationType, r: DeviceReceipt, claimKey: str): ReceiptAdmission =
  if (receiptAdmitted(t, r, claimKey)) ReceiptAdmitted({ settles: settlementOf(t, r) }) else ReceiptRefused
pure def lawOnlyAnAppliedReceiptSettlesApplied(t: OperationType, r: DeviceReceipt, claimKey: str): bool =
  receiptOutcome(t, r, claimKey) == ReceiptAdmitted({ settles: SettlesApplied }) implies (r.reported == ReportsApplied and r.operationId != "")
pure def lawNothingRanNeedsATrustedRefusal(t: OperationType, r: DeviceReceipt, claimKey: str): bool =
  receiptOutcome(t, r, claimKey) == ReceiptAdmitted({ settles: SettlesNothingRan }) implies
    (notDispatchedFailure(r) or ((family(t) == TelephonyFamily or family(t) == ClockFamily) and r.result == ValidResult({ shows: ReportsFailed, nothingSubmitted: true })))
pure def lawAnUnknownReceiptStaysUncertain(t: OperationType, r: DeviceReceipt, claimKey: str): bool =
  (r.reported == ReportsUnknown and receiptAdmitted(t, r, claimKey)) implies receiptOutcome(t, r, claimKey) == ReceiptAdmitted({ settles: StaysUncertain })
```
