# Device operations

The closed set of operations the agent may propose to an enrolled device,
shared by the proposal service and the device executor: which proposals are
well formed and what a receipt may claim. Exact keys and result shapes are
the agent's wire schemas (`device-actions/operations.schema.vibe`); field
bounds are owned where the data is ([calendar availability](../../calendar/availability.md),
[note reads](../../notes/read.md), the [workflow](../../workflow/index.md)
protocol, the os executor specs); offer, claim and settlement are the
[device request](./index.md)'s.

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
  | MessagesReadSelected | VoicemailReadSelected | VoicemailDeleteSelected | SmsLatestSender | ClockHandoff
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
  | VoicemailDeleteSelected => "voicemail_delete_selected" | SmsLatestSender => "sms_latest_sender" | ClockHandoff => "clock_handoff"
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
  | VoicemailDeleteSelected => TelephonyFamily | SmsLatestSender => TelephonyFamily | ClockHandoff => ClockFamily
  | ReadSelectedNotes => WorkflowFamily | ReadCalendarRange => WorkflowFamily | ReadSelectedReminders => WorkflowFamily
  | PostNotification => WorkflowFamily | SpeakText => WorkflowFamily
  | CreateNote => BaseFamily | CreateReminder => BaseFamily | OpenView => BaseFamily | BrowserNavigate => BaseFamily
}
pure def lawOneWireTypeIsOneOperation(a: OperationType, b: OperationType): bool =
  wireType(a) == wireType(b) implies (a == b or (family(a) == ReviewFamily and wireType(a) == "calendar_named"))
```

### Each operation has one capability need, which a clock-only device meets only for the Clock handoff

`versionTwo` marks a reminder read or edit whose target or timing is
version two, a named reminder edit that sets alert minutes, a Clock
handoff that carries its own repeat days, a latest-sender read that asks
for the sender's whole address, and a voice-note recording offered under
`notes.record.v1`, which needs neither folders nor a local Notes record;
without it a recording still runs under the pair `notes.organize.v1` and
`notes.local-record.v1`. It also marks a Photos album or share that names
`{selected: true}` in place of library IDs: the one item the owner has open
in the Photos viewer, which the phone resolves at review, so the agent
never needs or guesses that item's ID. That form needs
`photos.view-selected.v1` beside the library and view capabilities. The base and workflow operations
need any capability other than the Clock handoff, so a device that
advertised only the Clock handoff never receives them.

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
  | NotesOrganizeFamily =>
      if (t == NotesListFilter) needOne(NotesListFilterV1) else if (t == NotesRecord and versionTwo) needOne(NotesRecordV1)
      else needAll(NotesOrganizeV1, NotesLocalRecordV1)
  | NotesQueryFamily => needAll(NotesQueryV1, NotesLocalRecordV1)
  | PhotoLibraryFamily => needOne(PhotosLibraryV1)
  | PhotosViewFamily =>
      if (versionTwo and (t == PhotosAlbumCreate or t == PhotosShare)) { required: Set(PhotosLibraryV1).union(Set(PhotosViewV1)).union(Set(PhotosViewSelectedV1)), oneOf: Set() }
      else needAll(PhotosLibraryV1, PhotosViewV1)
  | TelephonyFamily =>
      if (t == SmsSend) needOne(SmsSendV1) else if (t == MmsSend) needOne(MmsSendV1) else if (t == PhoneDial) needOne(PhoneDialV1)
      else if (t == PhoneCall) needOne(PhoneCallV1) else if (t == SmsCompose or t == SmsReplySelected) needOne(SmsComposeV1)
      else if (t == MessagesReadSelected) needOne(MessagesReadV1) else if (t == VoicemailReadSelected) needOne(VoicemailReadV1)
      else if (t == VoicemailDeleteSelected) needOne(VoicemailDeleteV1) else if (t == SmsLatestSender) smsLatestSenderNeed(versionTwo)
      else needOne(ContactsWriteV1)
  | ClockFamily => clockHandoffNeed(versionTwo)
  | WorkflowFamily => anyButClock
  | BaseFamily => anyButClock
}
pure val negValues: Set[Negotiation] = Set(Refused, Negotiated({ capabilities: Set() }), Negotiated({ capabilities: Set(ClockHandoffV1) }),
  Negotiated({ capabilities: Set(ClockHandoffV1, ClockHandoffV2) }), Negotiated({ capabilities: Set(NamedTargetV1, RemindersLocalRecordV1, NotesLocalRecordV1) }),
  Negotiated({ capabilities: Set(NamedTargetV1, RemindersLocalRecordV2, CalendarAgendaReadV1, NotesQueryV1, NotesLocalRecordV1) }))
pure def clockOnly(neg: Negotiation): bool = allCapabilities.forall(c => negotiatedHas(neg, c) implies (c == ClockHandoffV1 or c == ClockHandoffV2))
pure def recordingAlone(neg: Negotiation): bool = negotiatedHas(neg, NotesRecordV1)
pure def lawRecordingRunsUnderItsOwnCapabilityAlone(t: OperationType): bool =
  t == NotesRecord implies meets(Negotiated({ capabilities: Set(NotesRecordV1) }), operationNeed(t, true))
pure def lawTheLegacyPairStillRecords(neg: Negotiation): bool =
  (negotiatedHas(neg, NotesOrganizeV1) and negotiatedHas(neg, NotesLocalRecordV1)) implies meets(neg, operationNeed(NotesRecord, recordingAlone(neg)))
pure def lawTheOpenPhotoFormNeedsItsCapability(t: OperationType, neg: Negotiation): bool =
  ((t == PhotosAlbumCreate or t == PhotosShare) and meets(neg, operationNeed(t, true))) implies
    (negotiatedHas(neg, PhotosViewSelectedV1) and negotiatedHas(neg, PhotosLibraryV1) and negotiatedHas(neg, PhotosViewV1))
pure def lawEveryOperationNamesANeed(t: OperationType, versionTwo: bool): bool =
  namesSome(operationNeed(t, versionTwo).required) or namesSome(operationNeed(t, versionTwo).oneOf)
pure def lawAClockOnlyDeviceReceivesOnlyClockHandoffs(t: OperationType, versionTwo: bool, neg: Negotiation): bool =
  (clockOnly(neg) and meets(neg, operationNeed(t, versionTwo))) implies t == ClockHandoff
pure def lawANamedEditNeedsTheNamedTarget(t: OperationType, versionTwo: bool, neg: Negotiation): bool =
  ((t == NotesNamed or t == CalendarNamedEdit or t == ReminderNamed) and meets(neg, operationNeed(t, versionTwo))) implies negotiatedHas(neg, NamedTargetV1)
pure def lawNewerReminderTimingIsNeverDowngraded(t: OperationType, neg: Negotiation): bool =
  ((family(t) == ReminderFamily or t == ReminderNamed) and meets(neg, operationNeed(t, true))) implies negotiatedHas(neg, RemindersLocalRecordV2)
```

### A turn targets the photo open on the owner's screen only from the Photos view, never on a sensitive screen, and names its library ID only under the library capability

When the owner says "this photo" while the turn's [observation](../conversation/turnContext.md)
shows the Photos view, an album or share targets the open item: as
`{selected: true}` when the request negotiated `photos.view-selected.v1`,
so no ID leaves the phone, and otherwise by the observed selected object's
library ID, but only when that ID is a library ID and the request
negotiated `photos.library.v1` and `photos.view.v1`. The target carries no
turn-scoped state, so a task that continues on a later turn proposes the
same item again from that turn's observation.

```quint
type PhotoTarget = NoPhotoTarget | OpenPhoto | ShownLibraryId
pure def shownPhotoTarget(photosView: bool, sensitive: bool, shownId: bool, neg: Negotiation): PhotoTarget =
  if (not(photosView) or sensitive) NoPhotoTarget
  else if (negotiatedHas(neg, PhotosViewSelectedV1) and negotiatedHas(neg, PhotosLibraryV1) and negotiatedHas(neg, PhotosViewV1)) OpenPhoto
  else if (shownId and negotiatedHas(neg, PhotosLibraryV1) and negotiatedHas(neg, PhotosViewV1)) ShownLibraryId
  else NoPhotoTarget
pure def lawAShownLibraryIdNeedsTheLibraryCapability(photosView: bool, sensitive: bool, shownId: bool, neg: Negotiation): bool =
  shownPhotoTarget(photosView, sensitive, shownId, neg) == ShownLibraryId implies (shownId and negotiatedHas(neg, PhotosLibraryV1))
pure def lawTheOpenPhotoFormIsOfferedOnlyWhenNegotiated(photosView: bool, sensitive: bool, shownId: bool, neg: Negotiation): bool =
  shownPhotoTarget(photosView, sensitive, shownId, neg) == OpenPhoto implies negotiatedHas(neg, PhotosViewSelectedV1)
pure def lawASensitiveScreenNamesNoPhoto(photosView: bool, shownId: bool, neg: Negotiation): bool =
  shownPhotoTarget(photosView, true, shownId, neg) == NoPhotoTarget
```

### A proposal is valid only when its shape, its need and its binding all hold

`shapeValid` is the family schema's verdict: exactly the operation's own
keys, every field within the bounds of its owning spec. A workflow read or
presentation needs a workflow binding, except that a calendar range read may
instead be a standalone agenda read bound to the owner's message, which also
needs the agenda capability. No other operation may carry an agenda binding.
A voice-note recording takes its version from the negotiation: the
recording-only form exactly when the request negotiated `notes.record.v1`.
A photo capture takes its version from the negotiation too: version two
exactly when the request negotiated `camera.capture-library-id.v1`, so its
receipt may name the saved photo's library ID.
The proposal, decide and claim requests each validate against their own
negotiation.

```quint
type ReadBinding = NoBinding | WorkflowBinding | AgendaBinding
type Proposal = { opType: OperationType, versionTwo: bool, binding: ReadBinding, shapeValid: bool }
pure def bindingAdmitted(prop: Proposal, neg: Negotiation): bool =
  if (prop.binding == AgendaBinding) prop.opType == ReadCalendarRange and negotiatedHas(neg, CalendarAgendaReadV1)
  else family(prop.opType) != WorkflowFamily or prop.binding == WorkflowBinding
pure def proposalVersion(prop: Proposal, neg: Negotiation): bool =
  if (prop.opType == NotesRecord) recordingAlone(neg)
  else if (prop.opType == CameraCapturePhoto) negotiatedHas(neg, CameraLibraryIdV1)
  else prop.versionTwo
pure def lawARecordingIsValidUnderEitherForm(prop: Proposal, neg: Negotiation): bool =
  (prop.opType == NotesRecord and prop.shapeValid and prop.binding == NoBinding and
    (negotiatedHas(neg, NotesRecordV1) or (negotiatedHas(neg, NotesOrganizeV1) and negotiatedHas(neg, NotesLocalRecordV1)))) implies validate(prop, neg)
pure def validate(prop: Proposal, neg: Negotiation): bool = prop.shapeValid and meets(neg, operationNeed(prop.opType, proposalVersion(prop, neg))) and bindingAdmitted(prop, neg)
pure val propValues: Set[Proposal] = Set(
  { opType: ReadCalendarRange, versionTwo: false, binding: AgendaBinding, shapeValid: true },
  { opType: ReadSelectedNotes, versionTwo: false, binding: NoBinding, shapeValid: true },
  { opType: ReadSelectedNotes, versionTwo: false, binding: WorkflowBinding, shapeValid: true },
  { opType: NotesQuery, versionTwo: false, binding: AgendaBinding, shapeValid: true },
  { opType: NotesQuery, versionTwo: false, binding: NoBinding, shapeValid: true },
  { opType: NotesQuery, versionTwo: false, binding: NoBinding, shapeValid: false },
  { opType: ClockHandoff, versionTwo: true, binding: NoBinding, shapeValid: true },
  { opType: FilesOpen, versionTwo: false, binding: NoBinding, shapeValid: true },
  { opType: SmsReplySelected, versionTwo: false, binding: WorkflowBinding, shapeValid: true },
  { opType: SmsSend, versionTwo: false, binding: NoBinding, shapeValid: true },
  { opType: NotesRecord, versionTwo: false, binding: NoBinding, shapeValid: true })
pure def lawAWorkflowOperationIsBound(prop: Proposal, neg: Negotiation): bool =
  (validate(prop, neg) and family(prop.opType) == WorkflowFamily) implies (prop.binding == WorkflowBinding or (prop.opType == ReadCalendarRange and prop.binding == AgendaBinding))
pure def lawAStandaloneAgendaReadNegotiatedTheAgenda(prop: Proposal, neg: Negotiation): bool =
  (validate(prop, neg) and prop.binding == AgendaBinding) implies (prop.opType == ReadCalendarRange and negotiatedHas(neg, CalendarAgendaReadV1))
```

### Only a reversible local operation bound to the owner's current message may run without a review

Filtering or opening files, notes and photos, starting or stopping a voice
note in the open Notes view, creating a note, opening a view or a web page,
taking a photo, selecting library photos and placing a reply draft in the
open conversation may skip the separate review, and only when the host bound
the proposal to the owner's own current message and no workflow bound it.
Every other operation is reviewed on the device first: nothing that sends,
calls, writes a contact, shares, deletes or hands off to the Clock ever runs
directly. Whether the owner allows it is [execution](./execution.md)'s rule.

```quint
pure def directEligible(t: OperationType): bool =
  t == FilesFilter or t == FilesOpen or t == NotesFilter or t == NotesListFilter or t == NotesRecord or t == PhotosFilter or t == PhotosOpen
  or t == CreateNote or t == OpenView or t == BrowserNavigate or t == CameraCapturePhoto or t == PhotoLibrarySelect or t == SmsReplySelected
pure def mayRunDirectly(prop: Proposal, boundToCurrentMessage: bool): bool =
  directEligible(prop.opType) and prop.binding == NoBinding and boundToCurrentMessage
pure def sendsSharesOrDeletes(t: OperationType): bool =
  (family(t) == TelephonyFamily and t != SmsReplySelected and t != MessagesReadSelected and t != VoicemailReadSelected and t != SmsLatestSender)
  or family(t) == ClockFamily or t == FilesShare or t == FilesTrash or t == PhotosShare or t == PhotoLibraryReview
  or t == NotesDelete or t == CalendarDelete or t == ReminderCancel
pure def lawNothingThatSendsSharesOrDeletesRunsDirectly(prop: Proposal, boundToCurrentMessage: bool): bool =
  mayRunDirectly(prop, boundToCurrentMessage) implies not(sendsSharesOrDeletes(prop.opType))
```

## Story: Learn exactly what the device did

> As a device owner, I want the agent to accept from my device only a
> receipt its own evidence supports, so that a send, a call or an edit is
> never reported as done, or as not done, without proof.

### A receipt is admitted only when its evidence agrees with what it reports

A receipt reports applied, failed or unknown, with an optional native
operation, failure code and typed result, which must show what the receipt
reports. Phone and Clock results are evidence: one is missing only from an
unknown receipt. Other reads and edits carry a result exactly when applied;
files, notes organizing, workflow presentations and the base operations
never carry one. An applied receipt names its native operation. An SMS or
MMS send, or a contact SMS, names the journal key of its claim, so a lost
response reconciles against one native row and never sends twice. A
failure the device reports as never dispatched, with no result, is admitted
for any operation.
A latest-sender result is the answer of the newest incoming SMS: the last
four digits, or the whole dialable address and its thread when the
operation asked for it, never the other form; an empty Inbox or a sender
that is no dialable number is still an applied read, and a read the phone
could not run reports failed.

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
  { reported: ReportsFailed, operationId: "", code: NotDispatched, result: NoResult }, { reported: ReportsFailed, operationId: "", code: OtherCode, result: NoResult },
  { reported: ReportsUnknown, operationId: "n1", code: NoCode, result: NoResult },
  { reported: ReportsUnknown, operationId: "n1", code: NoCode, result: ValidResult({ shows: ReportsApplied, nothingSubmitted: false }) },
  { reported: ReportsApplied, operationId: "n1", code: NoCode, result: InvalidResult })
pure val claimKeyValues = Set("n1", "n2")
pure def lawEvidenceNeverContradictsTheReceipt(t: OperationType, r: DeviceReceipt, claimKey: str): bool =
  (receiptAdmitted(t, r, claimKey) and r.result != NoResult) implies (agrees(r.result, r.reported) and r.result != InvalidResult)
pure def lawPhoneEvidenceIsMissingOnlyFromAnUnknownReceipt(t: OperationType, r: DeviceReceipt, claimKey: str): bool =
  (receiptAdmitted(t, r, claimKey) and evidenceOf(t) == OutcomeEvidence and r.result == NoResult and not(notDispatchedFailure(r))) implies r.reported == ReportsUnknown
pure def lawASimSendNamesItsClaim(t: OperationType, r: DeviceReceipt, claimKey: str): bool =
  (receiptAdmitted(t, r, claimKey) and sharesSimJournal(t) and not(notDispatchedFailure(r))) implies r.operationId == claimKey
```

### A latest-sender read is answered in fixed words from its approved result, and the model is offered the whole address only when the device negotiated it

The reply to an applied latest-sender read is written from its result,
never by the model: the whole address, or the number's last four digits,
or that the Inbox holds no incoming SMS, or that the newest sender has no
readable number; a read the phone could not run says it could not be read.
The model's guidance for proposing the read follows the negotiation: with
`sms.latest-sender.v2` it may ask for the whole address and then propose
an `sms_compose` draft to that exact number, which the owner sends;
otherwise it learns that only the suffix comes back, and that no message
body, history, MMS or cloud inbox is read.

```quint
type SenderRead = SenderAddress | SenderEnding | InboxEmpty | SenderNotDialable | SenderUnreadable
type SenderAnswer = SaysAddress | SaysEnding | SaysNoMessages | SaysNoNumber | SaysReadFailed
type SenderGuidance = AddressThenDraft | SuffixOnly
pure def senderAnswer(read: SenderRead): SenderAnswer = match read {
  | SenderAddress => SaysAddress | SenderEnding => SaysEnding | InboxEmpty => SaysNoMessages
  | SenderNotDialable => SaysNoNumber | SenderUnreadable => SaysReadFailed }
pure def senderGuidance(n: Negotiation): SenderGuidance = if (negotiatedHas(n, SmsLatestSenderV2)) AddressThenDraft else SuffixOnly
pure def lawOnlyAnAddressReadSaysTheAddress(read: SenderRead): bool = (senderAnswer(read) == SaysAddress) iff (read == SenderAddress)
pure def lawTheDraftFollowUpNeedsTheNewerRead(n: Negotiation): bool = senderGuidance(n) == AddressThenDraft implies meets(n, smsLatestSenderNeed(true))
```

### A captured photo's library ID reaches the agent only when the request negotiated it

A capture receipt names the saved photo's media ID and may name its library
ID, an image ID of the photo library. The library ID is part of the result
only for a capture validated as version two; otherwise a receipt that names
one is an invalid result, so the device leaves it out and the photo is
still saved. A selected-item album or share result counts exactly one
target.

```quint
pure def libraryIdAdmitted(versionTwo: bool, namesLibraryId: bool): bool = not(namesLibraryId) or versionTwo
pure def photoTargets(selected: bool, ids: int): int = if (selected) 1 else ids
pure def lawALibraryIdNeedsTheNegotiatedCapture(neg: Negotiation): bool =
  libraryIdAdmitted(proposalVersion({ opType: CameraCapturePhoto, versionTwo: false, binding: NoBinding, shapeValid: true }, neg), true)
    implies negotiatedHas(neg, CameraLibraryIdV1)
pure def lawACaptureWithoutTheIdIsAlwaysAdmitted(versionTwo: bool): bool = libraryIdAdmitted(versionTwo, false)
pure def lawTheOpenPhotoIsOneTarget(ids: int): bool = photoTargets(true, ids) == 1
```

### Only an applied receipt settles applied, and only a trusted refusal settles that nothing ran

An admitted receipt settles the request: applied when it reports applied;
nothing ran when the device never dispatched, or when the failed result of
an SMS or MMS send, a contact SMS or a reply draft shows nothing was
submitted (`nothingSubmitted`: the owner cancelled or was denied the send,
dismissed the contact SMS, or had no conversation open for the draft);
otherwise the request stays uncertain, because the device may have acted. A
failed dial, call, contact write or Clock handoff is reconciled, never
trusted as a refusal. The
[device request](./index.md) records these as `ReportedApplied`,
`ReportedNothingRan` and `ReportedUnknown`.

```quint
type Settlement = SettlesApplied | SettlesNothingRan | StaysUncertain
type ReceiptAdmission = ReceiptRefused | ReceiptAdmitted({ settles: Settlement })
pure def refusalIsTrusted(t: OperationType): bool = sharesSimJournal(t) or t == SmsReplySelected
pure def trustedRefusal(t: OperationType, r: DeviceReceipt): bool =
  refusalIsTrusted(t) and r.result == ValidResult({ shows: ReportsFailed, nothingSubmitted: true })
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
    (notDispatchedFailure(r) or ((t == SmsSend or t == MmsSend or t == SmsCompose or t == SmsReplySelected) and r.reported == ReportsFailed))
pure def lawAFailedDialOrHandoffIsReconciled(t: OperationType, r: DeviceReceipt, claimKey: str): bool =
  ((t == PhoneDial or t == PhoneCall or t == ClockHandoff) and receiptAdmitted(t, r, claimKey) and not(notDispatchedFailure(r)) and r.reported != ReportsApplied)
    implies receiptOutcome(t, r, claimKey) == ReceiptAdmitted({ settles: StaysUncertain })
pure def lawAnUnknownReceiptStaysUncertain(t: OperationType, r: DeviceReceipt, claimKey: str): bool =
  (r.reported == ReportsUnknown and receiptAdmitted(t, r, claimKey)) implies receiptOutcome(t, r, claimKey) == ReceiptAdmitted({ settles: StaysUncertain })
```
