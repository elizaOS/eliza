# Native phone call registry

A consumer that declares telephony registers the phone plugin from
`plugins/plugin-native-phone/android`, whose Android `InCallService`
reports the device's calls ([bridge composition](./bridge.md)). This spec
owns which calls the service tracks, when their ongoing-call notification
may be published, when a caller's contact name may be shown, and what the
`phone.dial.v1` handoff and `contacts.lookup.v1` lookup of the shared
device-action contracts may report. Dialing stays the person's action in
Android's own dialer; the agent's
[telephony review](../../agent/deviceActions/telephonyReview.md) decides
what reaches the handoff.

## Story: See the ongoing-call notification only for a call the phone still has

> As the person, I want the ongoing-call notice to match the calls Android
> reports now, and never to reappear for a call that already ended.

### A queued call update publishes only while its call is still registered

Android invokes the service on its main thread. Adding a call registers
it with its own callback and publishes its notice. A native update queues
one callback per call; when the callback drains, it may change the notice
only if the same call and its callback are still registered, so an update
posted before the call was removed or the service destroyed changes
nothing, and such a retired callback is always drained in the end, whatever
updates the remaining calls keep queuing. Removing a call drops its callback and notice; destroying the
service drops every call. A call id is never registered twice, and a
removed call never comes back.

```quint
type CallService = { live: bool, issued: Set[int], calls: Set[int], callbacks: Set[int], connected: Set[int], notifications: Set[int], queued: Set[int] }
pure val initial: CallService = { live: true, issued: Set(), calls: Set(), callbacks: Set(), connected: Set(), notifications: Set(), queued: Set() }
pure def canAddCall(s: CallService, callId: int): bool = s.live and callId > 0 and not(s.issued.contains(callId))
pure def addCall(s: CallService, callId: int): CallService =
  { ...s, issued: s.issued.union(Set(callId)), calls: s.calls.union(Set(callId)), callbacks: s.callbacks.union(Set(callId)),
    connected: s.connected.union(Set(callId)), notifications: s.notifications.union(Set(callId)) }
pure def canUpdateCall(s: CallService, callId: int, isConnected: bool): bool = s.live and s.calls.contains(callId) and not(s.queued.contains(callId))
pure def updateCall(s: CallService, callId: int, isConnected: bool): CallService =
  { ...s, connected: if (isConnected) s.connected.union(Set(callId)) else s.connected.exclude(Set(callId)), queued: s.queued.union(Set(callId)) }
pure def canRemoveCall(s: CallService, callId: int): bool = s.calls.contains(callId)
pure def removeCall(s: CallService, callId: int): CallService =
  { ...s, calls: s.calls.exclude(Set(callId)), callbacks: s.callbacks.exclude(Set(callId)), notifications: s.notifications.exclude(Set(callId)) }
pure def canDestroyCallService(s: CallService): bool = s.live
pure def destroyCallService(s: CallService): CallService = { ...s, live: false, calls: Set(), callbacks: Set(), notifications: Set() }
pure def canDrainCallback(s: CallService, callId: int): bool = s.queued.contains(callId)
pure def drainCallback(s: CallService, callId: int): CallService =
  { ...s, queued: s.queued.exclude(Set(callId)), notifications:
    if (s.calls.contains(callId) and s.callbacks.contains(callId))
      (if (s.connected.contains(callId)) s.notifications.union(Set(callId)) else s.notifications.exclude(Set(callId)))
    else s.notifications }
pure def canDrainRetiredCallback(s: CallService, callId: int): bool = s.queued.contains(callId) and not(s.calls.contains(callId))
pure def drainRetiredCallback(s: CallService, callId: int): CallService = { ...s, queued: s.queued.exclude(Set(callId)) }
pure val callIdValues = Set(1, 2)
pure val fair_drainCallback = "weak"
pure val fair_drainRetiredCallback = "weak"
pure def alwaysCallbacksMatchRegistry(s: CallService): bool = s.callbacks.subseteq(s.calls) and s.calls.subseteq(s.callbacks)
pure def alwaysNoticeHasCurrentCall(s: CallService): bool = s.notifications.subseteq(s.calls)
pure def alwaysDestroyedServiceHasNoCalls(s: CallService): bool = not(s.live) implies s.calls.size() == 0 and s.notifications.size() == 0
pure def alwaysRegistryWithinIssued(s: CallService): bool = s.calls.subseteq(s.issued) and s.connected.subseteq(s.issued) and s.queued.subseteq(s.issued)
pure def stepRemovedCallStaysRemoved(before: CallService, after: CallService): bool =
  before.issued.forall(c => before.calls.contains(c) or not(after.calls.contains(c)))
pure def leadsToRetiredCallbackSettles(s: CallService, later: CallService): bool =
  s.queued.forall(c => s.calls.contains(c) or not(later.queued.contains(c)))
pure def sometimesTwoCallsOneRemoved(s: CallService): bool = s.issued.size() == 2 and s.calls.size() == 1 and s.notifications.size() == 1
pure def sometimesDisconnectedCallStaysRegistered(s: CallService): bool = s.calls.exists(c => not(s.connected.contains(c)) and not(s.notifications.contains(c)))
```

### A caller's contact name is shown only while the service, the call and the contacts grant are all still current

Looking up the caller reads Contacts off the main thread and posts the
result back. When it arrives, the name is cached and published only if
the service is live, the call is still registered and the contacts
permission is still granted. A later refresh from the cache checks the
grant again. Removing the call or destroying the service drops the cached
name.

```quint
type CallerLookup = { serviceLive: bool, callPresent: bool, grantHeld: bool }
pure def lookupAdmitted(lookup: CallerLookup): bool = lookup.serviceLive and lookup.callPresent and lookup.grantHeld
pure def cachedNamePublished(cached: bool, atRefresh: CallerLookup): bool = cached and lookupAdmitted(atRefresh)
pure val lookupValues = Set(
  { serviceLive: true, callPresent: true, grantHeld: true },
  { serviceLive: true, callPresent: true, grantHeld: false },
  { serviceLive: true, callPresent: false, grantHeld: true },
  { serviceLive: false, callPresent: false, grantHeld: true }
)
pure def lawRetiredCallerNeverShown(lookup: CallerLookup): bool =
  not(lookup.serviceLive and lookup.callPresent) implies not(lookupAdmitted(lookup))
pure def lawWithdrawnGrantHidesCachedName(cached: bool, lookup: CallerLookup): bool =
  not(lookup.grantHeld) implies not(cachedNamePublished(cached, lookup))
```

## Story: Hand a reviewed number to the system dialer

> As the person, I want the assistant to open my phone's dial screen with
> the number I approved, so that I place the call myself and nothing
> claims a call happened that I did not make.

### A dial handoff opens the system dial screen with the approved number and never reports a call

The handoff and the contact lookup are advertised only where the image
surface is available ([image capabilities](../image/capabilities.md)).
A number is two to twenty digits with an optional leading plus. After
the owner approves the exact number on the unlocked phone, with the host
in front, the device opens the system dial screen with it filled in; the
person places the call or not, and the system dialer keeps emergency
numbers. The result is handed off, unavailable, cancelled or failed, with
the receiving handler and whether the number came from a contact; it
never says a call was placed, connected or completed. A contact lookup
runs on the phone in the owner's own profile while the review is in
front, with a query of 1 to 128 characters and no control characters,
and returns at most ten rows, which stay on the device: the agent
receives only the handoff result.

```quint
import capabilities.* from "../image/capabilities"
type DialStatus = DialHandedOff | DialUnavailable | DialCancelled | DialFailed
type DialResult = { dialStatus: DialStatus, handlerKnown: bool, fromContact: bool }
pure def dialNumberAdmitted(digits: int, onlyDigits: bool): bool = onlyDigits and digits >= 2 and digits <= 20
pure def dialHandoff(numberAdmitted: bool, ownerApproved: bool, unlockedInFront: bool, dialerResolved: bool, started: bool): DialStatus =
  if (not(ownerApproved)) DialCancelled
  else if (not(numberAdmitted and unlockedInFront)) DialFailed
  else if (not(dialerResolved)) DialUnavailable
  else if (started) DialHandedOff else DialFailed
pure def dialAdvertised(systemInstall: bool, featureDeclared: bool, featureVersion: int): bool =
  imageSurfaceAvailable(systemInstall, featureDeclared, featureVersion)
pure def contactLookupAdmitted(queryLength: int, controls: bool, reviewInFront: bool, ownProfile: bool): bool =
  queryLength >= 1 and queryLength <= 128 and not(controls) and reviewInFront and ownProfile
pure def lookupRows(found: int): int = if (found > 10) 10 else if (found < 0) 0 else found
pure val digitsValues = Set(1, 2, 20, 21)
pure val queryLengthValues = Set(0, 1, 128, 129)
pure val foundValues = Set(-1, 0, 3, 10, 11)
pure def lawHandoffNeedsApprovedNumberInFront(numberAdmitted: bool, ownerApproved: bool, unlockedInFront: bool, dialerResolved: bool, started: bool): bool =
  dialHandoff(numberAdmitted, ownerApproved, unlockedInFront, dialerResolved, started) == DialHandedOff implies
    numberAdmitted and ownerApproved and unlockedInFront and dialerResolved and started
pure def lawSideloadedHostAdvertisesNoDial(featureDeclared: bool, featureVersion: int): bool =
  not(dialAdvertised(false, featureDeclared, featureVersion))
pure def lawLookupReturnsAtMostTenRows(found: int): bool = lookupRows(found) >= 0 and lookupRows(found) <= 10
pure def lawLookupNeedsTheReviewInFront(queryLength: int, controls: bool, ownProfile: bool): bool =
  not(contactLookupAdmitted(queryLength, controls, false, ownProfile))
```
