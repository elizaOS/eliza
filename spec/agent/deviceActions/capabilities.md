# Device capabilities

What an enrolled device can do is a set of capability names from one closed,
versioned vocabulary. The agent offers the whole vocabulary when the device
registers; the device picks the part it can run and names it in the
`X-Eliza-Device-Capabilities` header of every request (comma-separated,
trimmed; a value with a line break is refused before parsing). The agent
proposes, and later lets the device decide or claim, an operation only when
that request negotiated what the operation needs. The device also keeps an
enabled-view profile: the views the agent may open on it.

The device request (`deviceActions/index.md`) owns enrollment and the request itself, and
the operations (`deviceActions/operations.md`) give each operation its need. The bounds of
each review are owned where the data is:
`spec/calendar/availability.md`,
`spec/notes/read.md` and the `spec/workflow`
device protocol. Neither the header nor the profile grants review or proves
an effect.

## Story: Offer the agent only what my device advertised

> As a device owner, I want the agent to propose only actions my device said
> it can run, at the version it said, and to open only views I enabled, so
> that nothing reaches my device that it cannot check.

### The capability vocabulary is closed and versioned, with one wire name per capability

Every capability has one wire name, which ends in its version, and no two
capabilities share a name. Nothing outside this table is a capability.

```quint
type Capability =
  CalendarLocalEventV1 | CalendarCreateV1 | CalendarNextReadV1 | CalendarAgendaReadV1 | CalendarAvailabilityReadV1 | CalendarNamedReadV1
  | NamedTargetV1 | NotesLocalRecordV1 | NotesQueryV1 | NotesSearchV1 | NotesListFilterV1 | NotesOrganizeV1
  | RemindersLocalRecordV1 | RemindersLocalRecordV2 | RemindersCreateV1 | PhotosLibraryV1 | PhotosViewV1 | CameraCapturePhotoV1
  | FilesBrowserV1 | MapsSelectedReadV1 | ClockHandoffV1 | ClockHandoffV2 | SmsSendV1 | MmsSendV1 | SmsComposeV1
  | MessagesReadV1 | PhoneDialV1 | PhoneCallV1 | ContactsWriteV1 | VoicemailReadV1 | VoicemailDeleteV1
pure def capabilityName(c: Capability): str = match c {
  | CalendarLocalEventV1 => "calendar.local-event.v1" | CalendarCreateV1 => "calendar.create.v1" | CalendarNextReadV1 => "calendar.next-read.v1"
  | CalendarAgendaReadV1 => "calendar.agenda-read.v1" | CalendarAvailabilityReadV1 => "calendar.availability-read.v1"
  | CalendarNamedReadV1 => "calendar.named-read.v1" | NamedTargetV1 => "device.named-target.v1" | NotesLocalRecordV1 => "notes.local-record.v1"
  | NotesQueryV1 => "notes.query.v1" | NotesSearchV1 => "notes.search.v1" | NotesListFilterV1 => "notes.list-filter.v1"
  | NotesOrganizeV1 => "notes.organize.v1" | RemindersLocalRecordV1 => "reminders.local-record.v1" | RemindersLocalRecordV2 => "reminders.local-record.v2"
  | RemindersCreateV1 => "reminders.create.v1" | PhotosLibraryV1 => "photos.library.v1" | PhotosViewV1 => "photos.view.v1"
  | CameraCapturePhotoV1 => "camera.capture-photo.v1" | FilesBrowserV1 => "files.browser.v1" | MapsSelectedReadV1 => "maps.selected-read.v1"
  | ClockHandoffV1 => "clock.handoff.v1" | ClockHandoffV2 => "clock.handoff.v2" | SmsSendV1 => "sms.send.v1" | MmsSendV1 => "mms.send.v1"
  | SmsComposeV1 => "sms.compose.v1" | MessagesReadV1 => "messages.read.v1" | PhoneDialV1 => "phone.dial.v1" | PhoneCallV1 => "phone.call.v1"
  | ContactsWriteV1 => "contacts.write.v1" | VoicemailReadV1 => "voicemail.read.v1" | VoicemailDeleteV1 => "voicemail.delete.v1"
}
pure val allCapabilities: Set[Capability] = Set(
  CalendarLocalEventV1, CalendarCreateV1, CalendarNextReadV1, CalendarAgendaReadV1, CalendarAvailabilityReadV1, CalendarNamedReadV1,
  NamedTargetV1, NotesLocalRecordV1, NotesQueryV1, NotesSearchV1, NotesListFilterV1, NotesOrganizeV1, RemindersLocalRecordV1,
  RemindersLocalRecordV2, RemindersCreateV1, PhotosLibraryV1, PhotosViewV1, CameraCapturePhotoV1, FilesBrowserV1,
  MapsSelectedReadV1, ClockHandoffV1, ClockHandoffV2, SmsSendV1, MmsSendV1, SmsComposeV1, MessagesReadV1, PhoneDialV1,
  PhoneCallV1, ContactsWriteV1, VoicemailReadV1, VoicemailDeleteV1)
pure def isCapabilityName(name: str): bool = allCapabilities.exists(c => capabilityName(c) == name)
pure def lawTheVocabularyListsEveryCapability(c: Capability): bool = allCapabilities.contains(c)
pure def lawNoTwoCapabilitiesShareAName(a: Capability, b: Capability): bool = capabilityName(a) == capabilityName(b) implies a == b
```

### A request negotiates exactly the capabilities its header names, and only on a live enrollment

The header is read anew on every request. It is refused whole when the
enrollment is not live, when it names anything outside the vocabulary, when
it names a capability twice, or when it names both reminder record versions
(next rule). An absent header negotiates nothing.

```quint
type Negotiation = Refused | Negotiated({ capabilities: Set[Capability] })
pure def distinctNames(names: List[str]): bool = names.foldl(Set(), (seen, n) => seen.union(Set(n))).size() == names.length()
pure def namedCapabilities(names: List[str]): Set[Capability] = allCapabilities.filter(c => names.includes(capabilityName(c)))
pure def headerAdmitted(names: List[str]): bool = names.every(n => isCapabilityName(n)) and distinctNames(names) and oneReminderVersion(names)
pure def negotiate(liveEnrollment: bool, names: List[str]): Negotiation =
  if (liveEnrollment and headerAdmitted(names)) Negotiated({ capabilities: namedCapabilities(names) }) else Refused
pure def isRefused(n: Negotiation): bool = match n { | Refused => true | Negotiated(x) => false }
pure def negotiatedHas(n: Negotiation, c: Capability): bool = match n { | Negotiated(x) => x.capabilities.contains(c) | Refused => false }
pure val namesValues: Set[List[str]] = Set(List(), List("calendar.local-event.v1", "notes.local-record.v1"), List("clock.handoff.v1", "clock.handoff.v1"),
  List("reminders.local-record.v1", "reminders.local-record.v2"), List("reminders.local-record.v2", "clock.handoff.v2"), List("gmail.request-policy.v1"), List(""))
pure def lawNoLiveEnrollmentNegotiatesNothing(names: List[str]): bool = isRefused(negotiate(false, names))
pure def lawAnUnknownNameRefusesTheHeader(names: List[str]): bool = not(names.every(n => isCapabilityName(n))) implies isRefused(negotiate(true, names))
pure def lawARepeatedNameRefusesTheHeader(names: List[str]): bool = not(distinctNames(names)) implies isRefused(negotiate(true, names))
pure def lawOnlyNamedCapabilitiesAreNegotiated(names: List[str], c: Capability): bool = negotiatedHas(negotiate(true, names), c) implies names.includes(capabilityName(c))
pure def lawEveryNamedCapabilityIsNegotiated(names: List[str], c: Capability): bool =
  (not(isRefused(negotiate(true, names))) and names.includes(capabilityName(c))) implies negotiatedHas(negotiate(true, names), c)
```

### A device speaks one reminder record version

A header that names both reminder record versions is refused, so a reminder
read or edit always runs under one version.

```quint
pure def oneReminderVersion(names: List[str]): bool = not(names.includes("reminders.local-record.v1") and names.includes("reminders.local-record.v2"))
pure def lawBothReminderVersionsAreRefused(liveEnrollment: bool, names: List[str]): bool =
  not(oneReminderVersion(names)) implies isRefused(negotiate(liveEnrollment, names))
```

### An operation runs only on a request that negotiated what it needs

An operation needs every capability of `required` and, when `oneOf` is not
empty, at least one of `oneOf`. The operations give each
operation its need, and the proposal, decide and claim requests each check it
against their own header. A need that names nothing is never met.

```quint
type Need = { required: Set[Capability], oneOf: Set[Capability] }
pure def namesSome(s: Set[Capability]): bool = s.exists(c => true)
pure def meets(n: Negotiation, need: Need): bool = match n {
  | Negotiated(x) => (namesSome(need.required) or namesSome(need.oneOf)) and need.required.subseteq(x.capabilities) and (not(namesSome(need.oneOf)) or need.oneOf.exists(c => x.capabilities.contains(c)))
  | Refused => false
}
pure def needOne(c: Capability): Need = { required: Set(c), oneOf: Set() }
pure val needValues: Set[Need] = Set(needOne(NotesQueryV1), { required: Set(NotesQueryV1, NotesLocalRecordV1), oneOf: Set() },
  { required: Set(CalendarLocalEventV1), oneOf: Set(NamedTargetV1, CalendarNamedReadV1) }, { required: Set(), oneOf: Set(ClockHandoffV1, ClockHandoffV2) }, { required: Set(), oneOf: Set() })
pure val nValues: Set[Negotiation] = Set(Refused, Negotiated({ capabilities: Set() }), Negotiated({ capabilities: Set(NotesQueryV1) }),
  Negotiated({ capabilities: Set(NotesQueryV1, NotesLocalRecordV1, CalendarLocalEventV1) }), Negotiated({ capabilities: Set(CalendarNamedReadV1, ClockHandoffV1, RemindersLocalRecordV1) }))
pure def lawARefusedHeaderMeetsNoNeed(need: Need): bool = not(meets(Refused, need))
pure def lawEveryRequiredCapabilityWasNegotiated(n: Negotiation, need: Need, c: Capability): bool = (meets(n, need) and need.required.contains(c)) implies negotiatedHas(n, c)
pure def lawOneOfTheAlternativesWasNegotiated(n: Negotiation, need: Need): bool = (meets(n, need) and namesSome(need.oneOf)) implies need.oneOf.exists(c => negotiatedHas(n, c))
pure def lawAnEmptyNeedIsNeverMet(n: Negotiation): bool = not(meets(n, { required: Set(), oneOf: Set() }))
```

### A newer operation cannot use an older capability version

A Clock handoff that carries its own repeat days (an empty list included)
needs `clock.handoff.v2`; an ordinary handoff runs under either version. A
reminder read or edit whose target or timing is version two needs
`reminders.local-record.v2`; otherwise it runs under either record version.

```quint
pure def clockHandoffNeed(withRepeatDays: bool): Need =
  if (withRepeatDays) needOne(ClockHandoffV2) else { required: Set(), oneOf: Set(ClockHandoffV1, ClockHandoffV2) }
pure def reminderRecordNeed(timingV2: bool): Need =
  if (timingV2) needOne(RemindersLocalRecordV2) else { required: Set(), oneOf: Set(RemindersLocalRecordV1, RemindersLocalRecordV2) }
pure def lawRepeatDaysNeedTheNewerClock(n: Negotiation): bool = meets(n, clockHandoffNeed(true)) implies negotiatedHas(n, ClockHandoffV2)
pure def lawNewerReminderTimingNeedsTheNewerRecord(n: Negotiation): bool = meets(n, reminderRecordNeed(true)) implies negotiatedHas(n, RemindersLocalRecordV2)
pure def lawEitherClockVersionRunsAnOrdinaryHandoff(n: Negotiation): bool =
  (negotiatedHas(n, ClockHandoffV1) or negotiatedHas(n, ClockHandoffV2)) implies meets(n, clockHandoffNeed(false))
```

### The enabled-view profile changes only against the revision the device read

A device reads its profile and the views the agent supports, then names the
revision it read (none, before any profile) with the views it wants. Any
other revision is refused and changes nothing. The same views keep the
profile as it is; other views get a fresh revision.

```quint
type DeviceView = HomeView | NotesView | RemindersView | BrowserView | CalendarView | FilesView | PhotosView | CameraView | MapsView | InboxView | SettingsView | WorkflowsView
type ProfileRevision = str
type ViewProfile = NoProfile | Profile({ revision: ProfileRevision, views: Set[DeviceView] })
type RevisionRead = NoRevisionRead | ReadAt({ revision: ProfileRevision })
pure def revisionOf(p: ViewProfile): RevisionRead = match p { | Profile(x) => ReadAt({ revision: x.revision }) | NoProfile => NoRevisionRead }
pure def sameViews(a: Set[DeviceView], b: Set[DeviceView]): bool = a.subseteq(b) and b.subseteq(a)
pure def unchangedViews(p: ViewProfile, views: Set[DeviceView]): bool = match p { | Profile(x) => sameViews(x.views, views) | NoProfile => false }
pure def canSetViewProfile(p: ViewProfile, read: RevisionRead, fresh: ProfileRevision): bool = read == revisionOf(p) and ReadAt({ revision: fresh }) != revisionOf(p)
pure def setViewProfile(p: ViewProfile, read: RevisionRead, views: Set[DeviceView], fresh: ProfileRevision): ViewProfile =
  if (unchangedViews(p, views)) p else Profile({ revision: fresh, views: views })
pure val pValues: Set[ViewProfile] = Set(NoProfile, Profile({ revision: "r1", views: Set() }), Profile({ revision: "r1", views: Set(HomeView, NotesView) }))
pure val readValues: Set[RevisionRead] = Set(NoRevisionRead, ReadAt({ revision: "r1" }), ReadAt({ revision: "r2" }))
pure val viewsValues: Set[Set[DeviceView]] = Set(Set(), Set(HomeView, NotesView), Set(HomeView))
pure val freshValues = Set("r1", "r2")
pure def lawAStaleRevisionIsRefused(p: ViewProfile, read: RevisionRead, fresh: ProfileRevision): bool = read != revisionOf(p) implies not(canSetViewProfile(p, read, fresh))
pure def lawChangedViewsGetAFreshRevision(p: ViewProfile, read: RevisionRead, views: Set[DeviceView], fresh: ProfileRevision): bool =
  (canSetViewProfile(p, read, fresh) and not(unchangedViews(p, views))) implies revisionOf(setViewProfile(p, read, views, fresh)) == ReadAt({ revision: fresh })
pure def lawSameViewsKeepTheRevision(p: ViewProfile, read: RevisionRead, views: Set[DeviceView], fresh: ProfileRevision): bool =
  unchangedViews(p, views) implies revisionOf(setViewProfile(p, read, views, fresh)) == revisionOf(p)
```

### An open-view proposal runs only on the profile revision it bound and a view the profile enables

A proposal to open a view binds the profile revision current when it was
made, none on a device without a profile. Deciding or claiming it checks the
profile again: a changed revision, a view no longer enabled, or a bound
revision on a device without a profile refuses it.

```quint
pure def viewEnabled(p: ViewProfile, view: DeviceView): bool = match p { | Profile(x) => x.views.contains(view) | NoProfile => true }
pure def openViewAdmitted(p: ViewProfile, bound: RevisionRead, view: DeviceView): bool = bound == revisionOf(p) and viewEnabled(p, view)
pure val boundValues: Set[RevisionRead] = Set(NoRevisionRead, ReadAt({ revision: "r1" }), ReadAt({ revision: "r2" }))
pure def lawAProposalOnTheCurrentProfileIsAdmitted(p: ViewProfile, view: DeviceView): bool = viewEnabled(p, view) implies openViewAdmitted(p, revisionOf(p), view)
pure def lawAStaleBindingIsRefused(p: ViewProfile, bound: RevisionRead, view: DeviceView): bool = bound != revisionOf(p) implies not(openViewAdmitted(p, bound, view))
pure def lawADisabledViewIsRefused(p: ViewProfile, bound: RevisionRead, view: DeviceView): bool = not(viewEnabled(p, view)) implies not(openViewAdmitted(p, bound, view))
```
