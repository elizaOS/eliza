# Device capabilities

What an enrolled device can do is a set of capability names from one closed,
versioned vocabulary. The agent offers the whole vocabulary when the device
registers; the device picks the part it can run and names it in the
`X-Eliza-Device-Capabilities` header of every request (comma-separated,
trimmed; a value with a line break is refused before parsing). The agent
proposes, and later lets the device decide or claim, an operation only when
that request negotiated what the operation needs. The device also keeps an
enabled-view profile: the views the agent may open on it.

The [device request](./index.md) owns enrollment and the request itself, and
the [operations](./operations.md) give each operation its need. The bounds of
each review are owned where the data is:
[calendar availability](../../calendar/availability.md),
[note reads](../../notes/read.md) and the [workflow](../../workflow/index.md)
device protocol. Neither the header nor the profile grants review or proves
an effect.

## Story: Offer the agent only what my device advertised

> As a device owner, I want the agent to propose only actions my device said
> it can run, at the version it said, and to open only views I enabled, so
> that nothing reaches my device that it cannot check.

### The capability vocabulary is closed and versioned, with one wire name per capability

Every capability has one wire name, which ends in its version, and no two
capabilities share a name. Nothing outside this table is a capability. The
Browser controls' groups are the [Browser](../../browser/control.md)'s, and
naming Files by their shown positions is [Files](../../files/shownTargets.md)'.

```quint
type Capability =
  CalendarLocalEventV1 | CalendarCreateV1 | CalendarNextReadV1 | CalendarAgendaReadV1 | CalendarAvailabilityReadV1 | CalendarNamedReadV1
  | NamedTargetV1 | NotesLocalRecordV1 | NotesQueryV1 | NotesSearchV1 | NotesListFilterV1 | NotesOrganizeV1
  | RemindersLocalRecordV1 | RemindersLocalRecordV2 | RemindersCreateV1 | PhotosLibraryV1 | PhotosViewV1 | CameraCapturePhotoV1
  | FilesBrowserV1 | MapsSelectedReadV1 | ClockHandoffV1 | ClockHandoffV2 | SmsSendV1 | MmsSendV1 | SmsComposeV1
  | MessagesReadV1 | PhoneDialV1 | PhoneCallV1 | ContactsWriteV1 | VoicemailReadV1 | VoicemailDeleteV1
  | SmsLatestSenderV1 | SmsLatestSenderV2 | NotesRecordV1 | PhotosViewSelectedV1 | CameraLibraryIdV1 | CameraCaptureLensV1
  | SmsComposeV2 | ContactsWriteV2 | ContactsShowV1 | ContactsReadV1 | ContactsLookupV1 | PhoneKeypadV1
  | BrowserSearchV1 | BrowserTabsV1 | BrowserTabsCloseAllV1 | BrowserTabsShowV1 | BrowserFindV1 | BrowserHistoryV1 | BrowserOpenNewTabV1 | FilesShownTargetV1 | TelephonyViewsV1
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
  | SmsLatestSenderV1 => "sms.latest-sender.v1" | SmsLatestSenderV2 => "sms.latest-sender.v2" | NotesRecordV1 => "notes.record.v1"
  | PhotosViewSelectedV1 => "photos.view-selected.v1" | CameraLibraryIdV1 => "camera.capture-library-id.v1" | CameraCaptureLensV1 => "camera.capture-lens.v1"
  | SmsComposeV2 => "sms.compose.v2" | ContactsWriteV2 => "contacts.write.v2" | ContactsShowV1 => "contacts.show.v1"
  | ContactsReadV1 => "contacts.read.v1" | ContactsLookupV1 => "contacts.lookup.v1" | PhoneKeypadV1 => "phone.keypad.v1"
  | BrowserSearchV1 => "browser.search.v1" | BrowserTabsV1 => "browser.tabs.v1" | BrowserTabsCloseAllV1 => "browser.tabs.close-all.v1"
  | BrowserTabsShowV1 => "browser.tabs.show.v1"
  | BrowserFindV1 => "browser.find.v1" | BrowserHistoryV1 => "browser.history.v1" | BrowserOpenNewTabV1 => "browser.open-new-tab.v1"
  | FilesShownTargetV1 => "files.shown-target.v1" | TelephonyViewsV1 => "views.telephony.v1"
}
pure val allCapabilities: Set[Capability] = Set(
  CalendarLocalEventV1, CalendarCreateV1, CalendarNextReadV1, CalendarAgendaReadV1, CalendarAvailabilityReadV1, CalendarNamedReadV1,
  NamedTargetV1, NotesLocalRecordV1, NotesQueryV1, NotesSearchV1, NotesListFilterV1, NotesOrganizeV1, RemindersLocalRecordV1,
  RemindersLocalRecordV2, RemindersCreateV1, PhotosLibraryV1, PhotosViewV1, CameraCapturePhotoV1, FilesBrowserV1,
  MapsSelectedReadV1, ClockHandoffV1, ClockHandoffV2, SmsSendV1, MmsSendV1, SmsComposeV1, MessagesReadV1, PhoneDialV1,
  PhoneCallV1, ContactsWriteV1, VoicemailReadV1, VoicemailDeleteV1, SmsLatestSenderV1, SmsLatestSenderV2, NotesRecordV1,
  PhotosViewSelectedV1, CameraLibraryIdV1, CameraCaptureLensV1, SmsComposeV2, ContactsWriteV2, ContactsShowV1, ContactsReadV1, ContactsLookupV1,
  PhoneKeypadV1, BrowserSearchV1, BrowserTabsV1, BrowserTabsCloseAllV1, BrowserTabsShowV1, BrowserFindV1, BrowserHistoryV1,
  BrowserOpenNewTabV1, FilesShownTargetV1, TelephonyViewsV1)
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

### A workflow step negotiates what its device declared at registration

A workflow step has no request and no header. It negotiates exactly the
capabilities the enrolled device declared when it registered; the header's
rules do not apply, so a device that declared both reminder record versions
still meets a reminder need.

```quint
pure def declaredNegotiation(names: List[str]): Negotiation = Negotiated({ capabilities: namedCapabilities(names) })
pure def lawADeclaredCapabilityIsNegotiated(names: List[str], c: Capability): bool =
  negotiatedHas(declaredNegotiation(names), c) iff names.includes(capabilityName(c))
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
A latest-sender read that asks for the sender's whole address and thread
needs `sms.latest-sender.v2`; one that names only the last four digits runs
under either version. A Messages text that names its recipient as a target,
a number or a contact, needs `sms.compose.v2` beside `sms.compose.v1`, and a
Messages draft tied to the latest sender's thread also needs
`sms.latest-sender.v2`; one that names a contact only by its `query` runs
under `sms.compose.v1`. A contact change that adds or removes single numbers
or email addresses needs `contacts.write.v2` beside `contacts.write.v1`, and
a dial to a contact needs `contacts.lookup.v1` beside `phone.dial.v1`, since
only that phone looks the name up for the owner to pick a number.

```quint
pure def clockHandoffNeed(withRepeatDays: bool): Need =
  if (withRepeatDays) needOne(ClockHandoffV2) else { required: Set(), oneOf: Set(ClockHandoffV1, ClockHandoffV2) }
pure def reminderRecordNeed(timingV2: bool): Need =
  if (timingV2) needOne(RemindersLocalRecordV2) else { required: Set(), oneOf: Set(RemindersLocalRecordV1, RemindersLocalRecordV2) }
pure def smsLatestSenderNeed(withAddress: bool): Need =
  if (withAddress) needOne(SmsLatestSenderV2) else { required: Set(), oneOf: Set(SmsLatestSenderV1, SmsLatestSenderV2) }
pure def smsComposeNeed(targetForm: bool, senderThread: bool): Need =
  if (senderThread) { required: Set(SmsComposeV1, SmsComposeV2, SmsLatestSenderV2), oneOf: Set() }
  else if (targetForm) { required: Set(SmsComposeV1, SmsComposeV2), oneOf: Set() }
  else needOne(SmsComposeV1)
pure def contactUpdateNeed(byValue: bool): Need =
  if (byValue) { required: Set(ContactsWriteV1, ContactsWriteV2), oneOf: Set() } else needOne(ContactsWriteV1)
pure def phoneDialNeed(toContact: bool): Need =
  if (toContact) { required: Set(PhoneDialV1, ContactsLookupV1), oneOf: Set() } else needOne(PhoneDialV1)
pure def lawATargetedTextNeedsTheNewerCompose(n: Negotiation, senderThread: bool): bool =
  meets(n, smsComposeNeed(true, senderThread)) implies (negotiatedHas(n, SmsComposeV1) and negotiatedHas(n, SmsComposeV2))
pure def lawADraftInTheSendersThreadNeedsTheWholeSender(n: Negotiation): bool = meets(n, smsComposeNeed(true, true)) implies negotiatedHas(n, SmsLatestSenderV2)
pure def lawAContactChangeByValueNeedsTheNewerWrite(n: Negotiation): bool = meets(n, contactUpdateNeed(true)) implies negotiatedHas(n, ContactsWriteV2)
pure def lawADialToAContactNeedsTheLookup(n: Negotiation): bool = meets(n, phoneDialNeed(true)) implies negotiatedHas(n, ContactsLookupV1)
pure def lawTheOlderFormsRunUnderTheOlderCapability(n: Negotiation): bool =
  (negotiatedHas(n, SmsComposeV1) implies meets(n, smsComposeNeed(false, false))) and (negotiatedHas(n, ContactsWriteV1) implies meets(n, contactUpdateNeed(false)))
    and (negotiatedHas(n, PhoneDialV1) implies meets(n, phoneDialNeed(false)))
pure def lawTheWholeSenderAddressNeedsTheNewerRead(n: Negotiation): bool = meets(n, smsLatestSenderNeed(true)) implies negotiatedHas(n, SmsLatestSenderV2)
pure def lawEitherSenderVersionNamesTheSuffix(n: Negotiation): bool =
  (negotiatedHas(n, SmsLatestSenderV1) or negotiatedHas(n, SmsLatestSenderV2)) implies meets(n, smsLatestSenderNeed(false))
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
  | PhoneView | MessagesView | ContactsView
type ProfileRevision = str
type ViewProfile = NoProfile | Profile({ revision: ProfileRevision, views: Set[DeviceView] })
type RevisionRead = NoRevisionRead | ReadAt({ revision: ProfileRevision })
pure def revisionOf(p: ViewProfile): RevisionRead = match p { | Profile(x) => ReadAt({ revision: x.revision }) | NoProfile => NoRevisionRead }
pure def sameViews(a: Set[DeviceView], b: Set[DeviceView]): bool = a.subseteq(b) and b.subseteq(a)
pure def unchangedViews(p: ViewProfile, views: Set[DeviceView]): bool = match p { | Profile(x) => sameViews(x.views, views) | NoProfile => false }
pure def canSetViewProfile(p: ViewProfile, read: RevisionRead, fresh: ProfileRevision): bool = read == revisionOf(p) and ReadAt({ revision: fresh }) != revisionOf(p)
pure def setViewProfile(p: ViewProfile, views: Set[DeviceView], fresh: ProfileRevision): ViewProfile =
  if (unchangedViews(p, views)) p else Profile({ revision: fresh, views: views })
pure val pValues: Set[ViewProfile] = Set(NoProfile, Profile({ revision: "r1", views: Set() }), Profile({ revision: "r1", views: Set(HomeView, NotesView) }))
pure val readValues: Set[RevisionRead] = Set(NoRevisionRead, ReadAt({ revision: "r1" }), ReadAt({ revision: "r2" }))
pure val viewsValues: Set[Set[DeviceView]] = Set(Set(), Set(HomeView, NotesView), Set(HomeView))
pure val freshValues = Set("r1", "r2")
pure def lawAStaleRevisionIsRefused(p: ViewProfile, read: RevisionRead, fresh: ProfileRevision): bool = read != revisionOf(p) implies not(canSetViewProfile(p, read, fresh))
pure def lawChangedViewsGetAFreshRevision(p: ViewProfile, read: RevisionRead, views: Set[DeviceView], fresh: ProfileRevision): bool =
  (canSetViewProfile(p, read, fresh) and not(unchangedViews(p, views))) implies revisionOf(setViewProfile(p, views, fresh)) == ReadAt({ revision: fresh })
pure def lawSameViewsKeepTheRevision(p: ViewProfile, views: Set[DeviceView], fresh: ProfileRevision): bool =
  unchangedViews(p, views) implies revisionOf(setViewProfile(p, views, fresh)) == revisionOf(p)
```

### Phone, Messages and Contacts are offered and enabled only on a request that negotiated the telephony views

The Phone, Messages and Contacts views are listed among the views the agent
supports, and a profile change may enable them, only on a request that
negotiated `views.telephony.v1`. A change that names one of them without it
is refused and changes nothing. Every other view is offered on every request.

```quint
pure def telephonyView(view: DeviceView): bool = view == PhoneView or view == MessagesView or view == ContactsView
pure val allViews: Set[DeviceView] = Set(HomeView, NotesView, RemindersView, BrowserView, CalendarView, FilesView, PhotosView, CameraView,
  MapsView, InboxView, SettingsView, WorkflowsView, PhoneView, MessagesView, ContactsView)
pure def offeredViews(n: Negotiation): Set[DeviceView] = if (negotiatedHas(n, TelephonyViewsV1)) allViews else allViews.filter(v => not(telephonyView(v)))
pure def viewsOffered(n: Negotiation, views: Set[DeviceView]): bool = views.subseteq(offeredViews(n))
pure def lawATelephonyViewIsOfferedOnlyUnderItsCapability(n: Negotiation, view: DeviceView): bool =
  (telephonyView(view) and offeredViews(n).contains(view)) implies negotiatedHas(n, TelephonyViewsV1)
pure def lawEveryOtherViewIsOffered(n: Negotiation, view: DeviceView): bool = not(telephonyView(view)) implies offeredViews(n).contains(view)
pure def lawATelephonyViewIsEnabledOnlyUnderItsCapability(n: Negotiation, views: Set[DeviceView]): bool =
  (viewsOffered(n, views) and views.exists(v => telephonyView(v))) implies negotiatedHas(n, TelephonyViewsV1)
```

### An open-view proposal runs only on the profile revision it bound and a view the profile enables

A proposal to open a view binds the profile revision current when it was
made, none on a device without a profile. Deciding or claiming it checks the
profile again: a changed revision, a view no longer enabled, or a bound
revision on a device without a profile refuses it. A device without a
profile may open every view except Phone, Messages and Contacts, which only
a profile enables.

```quint
pure def viewEnabled(p: ViewProfile, view: DeviceView): bool = match p { | Profile(x) => x.views.contains(view) | NoProfile => not(telephonyView(view)) }
pure def openViewAdmitted(p: ViewProfile, bound: RevisionRead, view: DeviceView): bool = bound == revisionOf(p) and viewEnabled(p, view)
pure val boundValues: Set[RevisionRead] = Set(NoRevisionRead, ReadAt({ revision: "r1" }), ReadAt({ revision: "r2" }))
pure def lawAProposalOnTheCurrentProfileIsAdmitted(p: ViewProfile, view: DeviceView): bool = viewEnabled(p, view) implies openViewAdmitted(p, revisionOf(p), view)
pure def lawAStaleBindingIsRefused(p: ViewProfile, bound: RevisionRead, view: DeviceView): bool = bound != revisionOf(p) implies not(openViewAdmitted(p, bound, view))
pure def lawADisabledViewIsRefused(p: ViewProfile, bound: RevisionRead, view: DeviceView): bool = not(viewEnabled(p, view)) implies not(openViewAdmitted(p, bound, view))
pure def lawNoProfileOpensATelephonyView(bound: RevisionRead, view: DeviceView): bool = telephonyView(view) implies not(openViewAdmitted(NoProfile, bound, view))
```
