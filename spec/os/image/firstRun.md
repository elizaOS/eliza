# First run

The first-run provisioner is the privileged app in the image that makes the
product's apps the device's defaults on a fresh device
(`packages/os/aosp/first-run`). Its decisions are the framework-free
`FirstRunPolicy`; its host reads the device, calls Android's `RoleManager`
and keeps this machine's state in device-protected storage, written and read
back before any role is assigned.

The image's descriptor is the app's resource overlay, written by product
composition: `first_run_enabled`, and `first_run_roles` with one
`<role>=<package>` item per role, where the role is `home`, `assistant`,
`dialer` or `sms`. First run assigns a role only to the package its item
names, never removes a holder, and reads or changes no other package. A
descriptor that names another role, names one twice or leaves out `home` is
not active. Which components keep a package eligible for a role belongs to
[image provisioning](./provisioning.md).

Setup is never held open. The host attempts first run when Android
delivers `BOOT_COMPLETED` after unlock, even if device setup was already
completed. It stops listening once the machine is done or retired.

## Story: Have my device's default apps set on first boot without overriding my choices

> As a device owner, I want a fresh device to start with the product's
> Home, assistant, phone and messages apps already set as its defaults, so
> that I never set them by hand, and a default I choose myself stays as I
> chose it.

### First run requires Home, the assistant the image declares, and the dialer and SMS app only where the image declares them and the device has telephony

Product composition stages the overlay with exactly the image's default
roles of [image provisioning](./provisioning.md); telephony is Android's
`FEATURE_TELEPHONY`.

```quint
import provisioning as P from "./provisioning"
type Descriptor = { active: bool, roles: Set[P::DefaultRole] }
pure def stagedDescriptor(request: P::ProvisioningRequest, firstRunEnabled: bool): Descriptor = { active: firstRunEnabled, roles: P::imageRoles(request) }
pure def requiredRoles(declared: Set[P::DefaultRole], telephony: bool): Set[P::DefaultRole] =
  Set(P::HomeRole).union(declared.filter(r => r == P::AssistantRole or (telephony and (r == P::DialerRole or r == P::SmsRole))))
pure def lawRequiredRolesAreTheImageRolesNarrowedByTelephony(request: P::ProvisioningRequest, telephony: bool): bool = {
  val image = P::imageRoles(request)
  val required = requiredRoles(stagedDescriptor(request, true).roles, telephony)
  required.subseteq(image) and required.contains(P::HomeRole) and (required.contains(P::AssistantRole) iff P::takesAssistant(request.assistant))
    and (required.contains(P::DialerRole) iff (request.telephonyRoles and telephony)) and (required.contains(P::SmsRole) iff required.contains(P::DialerRole))
}
```

### An attempt assigns only a role it read as empty or as a stock default, and retires at an owner's choice

A reading sorts each required role by its holders. It is `unavailable`
when Android does not offer the role to this user, the holders cannot be
read, or the descriptor's package for it is not an enabled app of the image.
It is the `product`'s when that package is the only holder. It is the
`owner`'s when a holder is an app the image did not ship. Every other role
has no holder or only apps of the image: it is empty or a stock default, and
only such a role is assigned. A role that first run once read back as the
product's and that now reads as anyone else's was changed by the owner too.
Either choice retires first run for good; an unavailable role only puts the
attempt off, and nothing is assigned until every required role is available.

```quint
type Phase = Pending | Skipped | Assigning | Retry | Done | Retired
type Reading = { unavailable: Set[P::DefaultRole], product: Set[P::DefaultRole], owner: Set[P::DefaultRole] }
type FirstRun = { phase: Phase, required: Set[P::DefaultRole], confirmed: Set[P::DefaultRole], assigning: Set[P::DefaultRole] }
pure val initial: FirstRun = { phase: Pending, required: Set(), confirmed: Set(), assigning: Set() }
pure def wellRead(required: Set[P::DefaultRole], reading: Reading): bool =
  reading.unavailable.union(reading.product).union(reading.owner).subseteq(required) and reading.unavailable.intersect(reading.product).size() == 0
    and reading.unavailable.intersect(reading.owner).size() == 0 and reading.product.intersect(reading.owner).size() == 0
pure def ownerChose(confirmed: Set[P::DefaultRole], reading: Reading): bool =
  reading.owner.size() > 0 or not(confirmed.exclude(reading.unavailable).subseteq(reading.product))
pure def attempted(required: Set[P::DefaultRole], confirmed: Set[P::DefaultRole], reading: Reading): FirstRun = {
  val known = confirmed.union(reading.product)
  if (ownerChose(confirmed, reading)) { phase: Retired, required: required, confirmed: known, assigning: Set() }
  else if (reading.unavailable.size() > 0) { phase: Retry, required: required, confirmed: known, assigning: Set() }
  else if (required.subseteq(reading.product)) { phase: Done, required: required, confirmed: known, assigning: Set() }
  else { phase: Assigning, required: required, confirmed: known, assigning: required.exclude(reading.product) }
}
pure val nothingRead: Reading = { unavailable: Set(), product: Set(), owner: Set() }
pure val readingValues = Set(nothingRead, { ...nothingRead, product: Set(P::HomeRole) },
  { ...nothingRead, product: Set(P::HomeRole, P::AssistantRole, P::DialerRole, P::SmsRole) }, { ...nothingRead, unavailable: Set(P::SmsRole) },
  { ...nothingRead, owner: Set(P::DialerRole) }, { ...nothingRead, product: Set(P::HomeRole), unavailable: Set(P::DialerRole, P::SmsRole) })
pure def lawOnlyARoleReadEmptyOrStockIsAssigned(required: Set[P::DefaultRole], confirmed: Set[P::DefaultRole], reading: Reading): bool = {
  val assigning = attempted(required, confirmed, reading).assigning
  assigning.subseteq(required) and assigning.forall(r => not(reading.unavailable.contains(r)) and not(reading.product.contains(r)) and not(reading.owner.contains(r)) and not(confirmed.contains(r)))
}
pure def alwaysAssignsOnlyRequiredRolesItNeverConfirmed(s: FirstRun): bool =
  s.assigning.subseteq(s.required) and s.assigning.intersect(s.confirmed).size() == 0 and (s.phase == Assigning iff s.assigning.size() > 0)
```

### An attempt begins only where the image enables first run, and is skipped unless the user is the unmanaged main system user

A descriptor that is not active allows nothing. The user is eligible as
user 0 of a device whose system user is its main user, with no device owner,
and not a profile; anyone else is skipped without a role being read, and is
judged again at the next attempt. An attempt that finds every required role
already the product's is done at once. An attempt interrupted while
assigning begins again from a fresh reading.

```quint
type Device = { systemUser: bool, mainUser: bool, managed: bool, profile: bool, telephony: bool }
pure def eligible(device: Device): bool = device.systemUser and device.mainUser and not(device.managed) and not(device.profile)
pure def canBegin(s: FirstRun, descriptor: Descriptor, device: Device, reading: Reading): bool =
  descriptor.active and s.phase != Done and s.phase != Retired and (eligible(device) implies wellRead(requiredRoles(descriptor.roles, device.telephony), reading))
pure def begin(s: FirstRun, descriptor: Descriptor, device: Device, reading: Reading): FirstRun = {
  val required = requiredRoles(descriptor.roles, device.telephony)
  if (eligible(device)) attempted(required, s.confirmed.intersect(required), reading) else { ...s, phase: Skipped, assigning: Set() }
}
pure val descriptorValues = Set({ active: true, roles: Set(P::HomeRole) }, { active: true, roles: Set(P::HomeRole, P::AssistantRole, P::DialerRole, P::SmsRole) },
  { active: false, roles: Set(P::HomeRole) })
pure val eligiblePhone: Device = { systemUser: true, mainUser: true, managed: false, profile: false, telephony: true }
pure val deviceValues = Set(eligiblePhone, { ...eligiblePhone, telephony: false }, { ...eligiblePhone, managed: true }, { ...eligiblePhone, systemUser: false, mainUser: false })
pure def stepAssignsOnlyAtTheStartOfAnAttempt(before: FirstRun, via: str, after: FirstRun): bool = after.assigning.size() > 0 implies via == "begin"
pure def sometimesSkipped(s: FirstRun): bool = s.phase == Skipped
pure def sometimesAssigningPhoneAndMessages(s: FirstRun): bool = s.phase == Assigning and s.assigning.contains(P::DialerRole) and s.assigning.contains(P::SmsRole)
```

### First run is done only when every required role reads back as the product's, and otherwise retries at the next completed boot

After its assignments the host reads every required role again. A role
whose assignment Android refused, or that did not read back, leaves the
attempt to be retried; nothing is assigned twice within one attempt.

```quint
pure def canReadBack(s: FirstRun, reading: Reading): bool = s.phase == Assigning and wellRead(s.required, reading)
pure def readBack(s: FirstRun, reading: Reading): FirstRun = {
  val read = attempted(s.required, s.confirmed, reading)
  if (read.phase == Assigning) { ...read, phase: Retry, assigning: Set() } else read
}
pure def alwaysDoneHoldsHomeAndEveryRequiredRole(s: FirstRun): bool =
  ((s.phase == Assigning or s.phase == Done) implies s.required.contains(P::HomeRole)) and (s.phase == Done implies s.required.subseteq(s.confirmed))
pure def sometimesDoneWithPhoneAndMessages(s: FirstRun): bool = s.phase == Done and s.confirmed.contains(P::DialerRole) and s.confirmed.contains(P::SmsRole)
pure def sometimesRetryKeepsWhatReadBack(s: FirstRun): bool = s.phase == Retry and s.confirmed.contains(P::HomeRole) and not(s.required.subseteq(s.confirmed))
```

### Done and retired are final

Once every role has read back, or the owner has chosen, later boots read
and assign no roles.

```quint
pure def stepDoneAndRetiredAreFinal(before: FirstRun, after: FirstRun): bool = (before.phase == Done or before.phase == Retired) implies after.phase == before.phase
pure def sometimesRetired(s: FirstRun): bool = s.phase == Retired
```
