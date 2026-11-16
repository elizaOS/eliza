# Native phone call registry

A consumer that declares telephony registers the phone plugin from
`plugins/plugin-native-phone/android`, whose Android `InCallService`
reports the device's calls ([bridge composition](./bridge.md)). This spec
owns which calls the service tracks, when their ongoing-call notification
may be published, and when a caller's contact name may be shown. Dialing stays the person's action in Android's own dialer; the
agent's [telephony review](../../agent/deviceActions/telephonyReview.md)
owns any handoff to it.

## Story: See the ongoing-call notification only for a call the phone still has

> As the person, I want the ongoing-call notice to match the calls Android
> reports now, and never to reappear for a call that already ended.

### A queued call update publishes only while its call is still registered

Android invokes the service on its main thread. Adding a call registers
it with its own callback and publishes its notice. A native update queues
one callback per call; when the callback drains, it may change the notice
only if the same call and its callback are still registered, so an update
posted before the call was removed or the service destroyed changes
nothing. Removing a call drops its callback and notice; destroying the
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
pure val callIdValues = Set(1, 2)
pure val fair_drainCallback = "weak"
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
