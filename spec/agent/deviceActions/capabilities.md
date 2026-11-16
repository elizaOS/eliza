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
Revocation is permanent and keeps the proposal as it was.

```quint
type Caller = SessionOwner | GatewayOwner | RetiredTurn | OtherCaller
type CapabilityHeader = LegacyHeader | NegotiatedHeader | MalformedHeader
type Enrollment = Unregistered | Live | Revoked
type ProposalStage = NoProposal | ProposalPending | ProposalApproved | ProposalDispatched | ProposalDone
type Negotiation = { enrollment: Enrollment, advertised: bool, proposal: ProposalStage, visible: bool }
pure val initial: Negotiation = { enrollment: Unregistered, advertised: false, proposal: NoProposal, visible: false }
pure def validCaller(caller: Caller, header: CapabilityHeader): bool = (caller == SessionOwner or caller == GatewayOwner) and header != MalformedHeader
pure def canAdvertise(n: Negotiation, caller: Caller, header: CapabilityHeader): bool = caller == GatewayOwner and header != MalformedHeader
pure def advertise(n: Negotiation, caller: Caller, header: CapabilityHeader): Negotiation = { ...n, advertised: true }
pure def canRegister(n: Negotiation, caller: Caller, header: CapabilityHeader): bool = validCaller(caller, header) and n.enrollment != Revoked
pure def register(n: Negotiation, caller: Caller, header: CapabilityHeader): Negotiation = { ...n, enrollment: Live }
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
