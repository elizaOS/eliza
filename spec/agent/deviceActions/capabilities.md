# Device capability vocabulary and negotiation

A device advertises what it can do as capability names from one closed,
versioned vocabulary, shared with the
[device review contracts](../../contracts/deviceReviews.md). A name ends in
its version, and a newer operation never runs on an older capability (the
[clock and reminder](./clock.md) routing is one example). Each request
carries the capability header the enrolled device negotiated; the
[approval queue](./index.md) owns the proposal itself, and neither the
transport nor the header grants review or proves an effect.

## Story: Offer the agent only what my device advertised

> As a user, the agent can only propose actions my device said it supports,
> using the exact capability version it advertised. Anything outside the
> vocabulary is refused.

### The capability vocabulary is closed and versioned

A capability is admitted only when it is in the vocabulary and the device
advertised it. A request needs every capability it requires; the Photos view
actions, for example, need both the library and the view capability. Every
capability a foreground review of the device review contracts accepts is in
the vocabulary.

```quint
import deviceReviews.* from "../../contracts/deviceReviews"
pure val vocabulary: Set[str] = Set(
  "calendar.availability-read.v1", "calendar.agenda-read.v1", "calendar.next-read.v1", "calendar.named-read.v1",
  "calendar.local-event.v1", "calendar.create.v1", "device.named-target.v1",
  "notes.search.v1", "notes.query.v1", "notes.list-filter.v1", "notes.organize.v1", "notes.local-record.v1",
  "reminders.create.v1", "reminders.local-record.v1", "reminders.local-record.v2",
  "photos.library.v1", "photos.view.v1", "camera.capture-photo.v1", "files.browser.v1",
  "clock.handoff.v1", "clock.handoff.v2", "clock.alarms.v1",
  "sms.compose.v1", "sms.send.v1", "mms.send.v1", "messages.read.v1",
  "phone.dial.v1", "phone.call.v1", "voicemail.read.v1", "voicemail.delete.v1",
  "contacts.lookup.v1", "contacts.write.v1", "maps.selected-read.v1")
pure def admitsCapabilities(advertised: Set[str], required: Set[str]): bool =
  required.size() > 0 and required.subseteq(advertised) and required.subseteq(vocabulary)
pure val advertisedValues: Set[Set[str]] = Set(Set("photos.library.v1"), Set("photos.library.v1", "photos.view.v1"), Set("photos.view.v1", "photos.unknown.v9"))
pure val requiredValues: Set[Set[str]] = Set(Set("photos.library.v1"), Set("photos.library.v1", "photos.view.v1"), Set("photos.unknown.v9"))
pure def lawUnknownCapabilityIsNeverAdmitted(advertised: Set[str], required: Set[str]): bool =
  not(required.subseteq(vocabulary)) implies not(admitsCapabilities(advertised, required))
pure def lawUnadvertisedCapabilityIsNeverAdmitted(advertised: Set[str], required: Set[str]): bool =
  not(required.subseteq(advertised)) implies not(admitsCapabilities(advertised, required))
pure def lawEveryReviewIsServedByTheVocabulary(review: DeviceReviewType, capabilities: Set[str]): bool =
  reviewCapabilityAvailable(review, capabilities) implies reviewCapabilityAvailable(review, capabilities.intersect(vocabulary))
```

### Every change to a local record is reviewed in the foreground

A device action that changes calendar, SMS, phone, contacts, photos, notes,
files, reminders or clock state needs a foreground review on the device,
unless the operation is eligible for a direct request and the user's
preference allows one (the [phone review](./telephonyReview.md) rule). Reads
of a selected record are reviewed as well.

```quint
type DeviceFamily = CalendarFamily | SmsFamily | PhoneFamily | ContactsFamily | PhotosFamily | NotesFamily | FilesFamily | RemindersFamily | ClockFamily | CameraFamily
pure def needsForegroundReview(family: DeviceFamily, changes: bool, selectedRead: bool, directEligible: bool, userAllowsDirect: bool): bool =
  (changes or selectedRead) and not(directEligible and userAllowsDirect and (family == SmsFamily or family == PhoneFamily))
pure def lawChangesAreReviewedOutsideTelephony(family: DeviceFamily, directEligible: bool, userAllowsDirect: bool): bool =
  (family != SmsFamily and family != PhoneFamily) implies needsForegroundReview(family, true, false, directEligible, userAllowsDirect)
```

## Story: Negotiate capabilities per request on an enrolled device

> As a user, only my device's own session or its verified gateway can enroll
> it and see or change its pending device actions, and a request that did not
> negotiate a capability cannot see or change actions that need it.

### Only the verified gateway advertises, and a revoked enrollment never returns

The verified gateway owner advertises the capability set. The session owner or
the gateway registers the device unless its enrollment was revoked; a retired
turn, any other caller and a malformed header are refused everything.
Registering again is idempotent for the same installation.
Revocation is permanent and keeps the proposal as it was.

```quint
type Caller = SessionOwner | GatewayOwner | RetiredTurn | OtherCaller
type CapabilityHeader = LegacyHeader | NegotiatedHeader | MalformedHeader
type Enrollment = Unregistered | Live | Revoked
type ProposalStage = NoProposal | ProposalPending | ProposalApproved | ProposalDispatched | ProposalDone
type Negotiation = { enrollment: Enrollment, advertised: bool, proposal: ProposalStage, visible: bool, workflowProtocol: int, profileRevision: int, nextProfileRevision: int, profileViews: Set[str] }
pure val initial: Negotiation = { enrollment: Unregistered, advertised: false, proposal: NoProposal, visible: false, workflowProtocol: 0, profileRevision: 0, nextProfileRevision: 1, profileViews: Set() }
pure def validCaller(caller: Caller, header: CapabilityHeader): bool = (caller == SessionOwner or caller == GatewayOwner) and header != MalformedHeader
pure def canAdvertise(n: Negotiation, caller: Caller, header: CapabilityHeader): bool = caller == GatewayOwner and header != MalformedHeader
pure def advertise(n: Negotiation, caller: Caller, header: CapabilityHeader): Negotiation = { ...n, advertised: true }
pure val maxWorkflowProtocol = 5
pure val workflowProtocolValues = Set(0, 3, 5, 6)
pure def canRegister(n: Negotiation, caller: Caller, header: CapabilityHeader, workflowProtocol: int): bool =
  validCaller(caller, header) and n.enrollment != Revoked and workflowProtocol >= 0 and workflowProtocol <= maxWorkflowProtocol
pure def register(n: Negotiation, caller: Caller, header: CapabilityHeader, workflowProtocol: int): Negotiation = { ...n, enrollment: Live, workflowProtocol: workflowProtocol }
pure def canRevokeEnrollment(n: Negotiation, caller: Caller, header: CapabilityHeader): bool = validCaller(caller, header) and n.enrollment == Live
pure def revokeEnrollment(n: Negotiation, caller: Caller, header: CapabilityHeader): Negotiation = { ...n, enrollment: Revoked, visible: false }
pure def stepRevocationIsPermanentAndKeepsTheProposal(before: Negotiation, after: Negotiation): bool =
  before.enrollment == Revoked implies (after.enrollment == Revoked and after.proposal == before.proposal)
pure def alwaysProposalNeedsEnrollment(n: Negotiation): bool = n.proposal != NoProposal implies n.enrollment != Unregistered
```

### Reading and changing a negotiated action needs the negotiated header and a live enrollment

A poll shows the pending action only with the negotiated header; a legacy
header sees nothing. Proposing, approving, claiming and settling each need a
valid caller, a live enrollment, the negotiated header and a capability set
the gateway advertised, and move the proposal one stage forward.

```quint
pure def canPoll(n: Negotiation, caller: Caller, header: CapabilityHeader): bool = validCaller(caller, header) and n.enrollment == Live
pure def poll(n: Negotiation, caller: Caller, header: CapabilityHeader): Negotiation = { ...n, visible: header == NegotiatedHeader and n.proposal != NoProposal }
pure def nextStage(stage: ProposalStage): ProposalStage =
  if (stage == NoProposal) ProposalPending else if (stage == ProposalPending) ProposalApproved
  else if (stage == ProposalApproved) ProposalDispatched else ProposalDone
pure def canAdvanceProposal(n: Negotiation, caller: Caller, header: CapabilityHeader): bool =
  validCaller(caller, header) and n.enrollment == Live and n.advertised and header == NegotiatedHeader and n.proposal != ProposalDone
pure def advanceProposal(n: Negotiation, caller: Caller, header: CapabilityHeader): Negotiation = { ...n, proposal: nextStage(n.proposal) }
pure val negotiationValues: Set[Negotiation] = Set(initial, { ...initial, enrollment: Live, advertised: true, proposal: ProposalPending }, { ...initial, enrollment: Revoked, proposal: ProposalApproved })
pure def lawLegacyHeaderCannotChangeTheProposal(negotiation: Negotiation, caller: Caller): bool = not(canAdvanceProposal(negotiation, caller, LegacyHeader))
pure def lawLegacyHeaderCannotSeeTheProposal(negotiation: Negotiation, caller: Caller): bool =
  canPoll(negotiation, caller, LegacyHeader) implies not(poll(negotiation, caller, LegacyHeader).visible)
pure def alwaysVisibleNeedsLiveEnrollment(n: Negotiation): bool = n.visible implies (n.enrollment == Live and n.proposal != NoProposal)
pure def sometimesNegotiatedActionSettles(n: Negotiation): bool = n.proposal == ProposalDone and n.enrollment == Live
pure def sometimesRevokedWithPendingAction(n: Negotiation): bool = n.enrollment == Revoked and n.proposal == ProposalPending
```

## Story: Register my device for the workflows and views it can run

> As a user, my device registers the workflow protocol it supports and the
> views it shows, and the agent never sends it a workflow step or a view
> it cannot handle.

### Registration records a workflow protocol the agent supports, and a step runs only on a device that registered enough

A registration names the workflow device protocol the device supports, from
none up to the highest the agent knows; a newer one is refused and leaves the
enrollment as it was, so the device can register again with an older one. A
workflow step that needs a protocol runs only on a device that registered at
least that protocol.

```quint
pure def workflowStepRuns(registered: int, stepProtocol: int): bool = registered >= stepProtocol
pure val registeredValues = Set(0, 2, 3, 5)
pure val stepProtocolValues = Set(1, 3, 5)
pure def lawOlderProtocolCannotRunANewerStep(registered: int, stepProtocol: int): bool = registered < stepProtocol implies not(workflowStepRuns(registered, stepProtocol))
pure def stepRegistrationRecordsASupportedProtocol(before: Negotiation, via: str, after: Negotiation): bool =
  via == "register" implies (after.workflowProtocol >= 0 and after.workflowProtocol <= maxWorkflowProtocol)
pure def alwaysRegisteredProtocolIsSupported(n: Negotiation): bool = n.workflowProtocol >= 0 and n.workflowProtocol <= maxWorkflowProtocol
pure def sometimesNewestProtocolRegistered(n: Negotiation): bool = n.enrollment == Live and n.workflowProtocol == maxWorkflowProtocol
```

### The enabled-view profile changes only against the revision the device read

A live enrollment reads its enabled-view profile with the views the agent
supports, and the device's identity as enrolled. It changes the profile by
naming the revision it read, none for a device that never set one, and a
subset of the supported views. A different revision is refused and changes
nothing. A change to other views gets a new revision; the same views keep
the profile as it is. An open-view proposal is admitted only for a view in
the profile, at the revision the proposal bound; a device without a profile
takes only proposals that bound none.

```quint
pure val deviceViews: Set[str] = Set("home", "notes", "reminders", "browser", "calendar", "files", "photos", "camera", "maps", "inbox", "settings", "workflows")
pure val expectedRevisionValues = Set(0, 1, 2)
pure val viewsValues: Set[Set[str]] = Set(Set(), Set("home", "notes"), Set("home"), Set("home", "unknown"))
pure def sameViews(a: Set[str], b: Set[str]): bool = a.subseteq(b) and b.subseteq(a)
pure def canSetViewProfile(n: Negotiation, caller: Caller, header: CapabilityHeader, expectedRevision: int, views: Set[str]): bool =
  validCaller(caller, header) and n.enrollment == Live and expectedRevision == n.profileRevision and views.subseteq(deviceViews)
pure def setViewProfile(n: Negotiation, caller: Caller, header: CapabilityHeader, expectedRevision: int, views: Set[str]): Negotiation =
  if (n.profileRevision > 0 and sameViews(views, n.profileViews)) n
  else { ...n, profileRevision: n.nextProfileRevision, nextProfileRevision: n.nextProfileRevision + 1, profileViews: views }
pure def contextReadable(n: Negotiation, caller: Caller, header: CapabilityHeader): bool = validCaller(caller, header) and n.enrollment == Live
pure def openViewAdmitted(profileRevision: int, views: Set[str], boundRevision: int, view: str): bool =
  if (profileRevision == 0) boundRevision == 0 else boundRevision == profileRevision and views.contains(view)
pure val boundRevisionValues = Set(0, 1, 2)
pure val profileRevisionValues = Set(0, 1, 2)
pure val viewValues = Set("home", "notes", "unknown")
pure def alwaysProfileHasAnIssuedRevision(n: Negotiation): bool =
  n.profileRevision >= 0 and n.profileRevision < n.nextProfileRevision and n.profileViews.subseteq(deviceViews) and (n.profileRevision == 0 implies n.profileViews.size() == 0)
pure def stepChangedViewsGetANewRevision(before: Negotiation, via: str, after: Negotiation): bool =
  (via == "setViewProfile" and not(sameViews(before.profileViews, after.profileViews))) implies after.profileRevision > before.profileRevision
pure def lawStaleProfileRefusesTheView(profileRevision: int, views: Set[str], boundRevision: int, view: str): bool =
  boundRevision != profileRevision implies not(openViewAdmitted(profileRevision, views, boundRevision, view))
pure def lawRevokedEnrollmentHasNoContext(negotiation: Negotiation, caller: Caller, header: CapabilityHeader): bool =
  negotiation.enrollment != Live implies not(contextReadable(negotiation, caller, header))
pure def sometimesProfileRevised(n: Negotiation): bool = n.profileRevision >= 2 and n.profileViews.size() > 0
```
