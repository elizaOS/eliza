# Launcher staging

The consumer's home app, the launcher package its
[product descriptor](./product.md) names, is staged into the image as an
additive product overlay from a reviewed launcher descriptor, or from an
explicit development descriptor for a development image. A production
image also gets a provisioning overlay derived from the admitted
launcher's manifest: the default home, the assistant role holder when the
product takes that role, and the default Autofill offer. Staging and
provisioning are staging output, not an image boot or release
qualification; [release signing](./signing.md) and the product
composition own those, and only a boot of the built image shows that
Android applied the defaults.

## Story: Make the launcher the device's home and assistant on first boot without preassigning other roles

> As a consumer, I want a fresh device to open my launcher as home and,
> when my product takes it, as the assistant, so that the person starts in
> my product without the image deciding anything else for them.

### First-boot defaults come from the admitted launcher's manifest and never preassign the dialer or SMS app

The admitted APK must declare exactly one exported activity for the
home intent; it becomes the default home through a preferred-activity
entry read on first boot. A product that takes the assistant role names
exactly one exported assist activity, and the launcher's package becomes
the default assistant role holder. A product that does not take it gets
no assistant default, and its APK may declare only disabled assist
activities. A declared Autofill service must be exported and protected
by the Autofill binding permission, at most one, and it becomes the
default Autofill offer. The stock launcher stays installed as a recovery
path. The product's own overlays never set the default dialer, SMS app,
home or assistant resources: those roles are the person's, assigned on
the device through Android's role holders, and the defaults above come
only from the provisioning overlay. The overlay files are written once
into a new destination.

```quint
type LauncherManifest = {
  homeActivities: int, homeExported: bool, assistActivities: int, enabledAssistActivities: int, assistExported: bool,
  autofillServices: int, autofillProtected: bool, autofillExported: bool
}
type FirstBootDefaults = { defaultHome: bool, assistantRole: bool, autofillOffer: bool, dialerPreassigned: bool, smsPreassigned: bool, stockLauncherKept: bool }
type RoleResource = DefaultDialerResource | DefaultSmsResource | DefaultHomeResource | DefaultAssistantResource | OtherResource
pure def provisioningAdmitted(m: LauncherManifest, takesAssistant: bool): bool =
  m.homeActivities == 1 and m.homeExported and
  (if (takesAssistant) m.assistActivities == 1 and m.assistExported else m.enabledAssistActivities == 0) and
  m.autofillServices >= 0 and m.autofillServices <= 1 and (m.autofillServices == 0 or (m.autofillProtected and m.autofillExported))
pure def firstBootDefaults(m: LauncherManifest, takesAssistant: bool): FirstBootDefaults =
  { defaultHome: provisioningAdmitted(m, takesAssistant), assistantRole: takesAssistant and provisioningAdmitted(m, takesAssistant),
    autofillOffer: m.autofillServices == 1 and provisioningAdmitted(m, takesAssistant),
    dialerPreassigned: false, smsPreassigned: false, stockLauncherKept: true }
pure def productOverlayAdmitted(resources: Set[RoleResource]): bool = resources.forall(r => r == OtherResource)
pure val plainManifest: LauncherManifest = {
  homeActivities: 1, homeExported: true, assistActivities: 1, enabledAssistActivities: 1, assistExported: true,
  autofillServices: 1, autofillProtected: true, autofillExported: true
}
pure val mValues = Set(plainManifest, { ...plainManifest, homeActivities: 2 }, { ...plainManifest, homeActivities: 0 },
  { ...plainManifest, homeExported: false }, { ...plainManifest, enabledAssistActivities: 0 },
  { ...plainManifest, autofillProtected: false }, { ...plainManifest, autofillServices: 0 })
pure val resourcesValues = Set(Set(), Set(OtherResource), Set(OtherResource, DefaultDialerResource), Set(DefaultSmsResource), Set(DefaultHomeResource), Set(DefaultAssistantResource))
pure def lawFirstBootNeverPreassignsDialerOrSms(m: LauncherManifest, takesAssistant: bool): bool =
  not(firstBootDefaults(m, takesAssistant).dialerPreassigned) and not(firstBootDefaults(m, takesAssistant).smsPreassigned) and
  firstBootDefaults(m, takesAssistant).stockLauncherKept
pure def lawAssistantRoleOnlyWhenTaken(m: LauncherManifest): bool =
  not(firstBootDefaults(m, false).assistantRole)
pure def lawProductWithoutAssistantRefusesEnabledAssist(m: LauncherManifest): bool =
  m.enabledAssistActivities > 0 implies not(provisioningAdmitted(m, false))
pure def lawDefaultsOnlyFromAnAdmittedManifest(m: LauncherManifest, takesAssistant: bool): bool =
  (firstBootDefaults(m, takesAssistant).defaultHome or firstBootDefaults(m, takesAssistant).assistantRole or
    firstBootDefaults(m, takesAssistant).autofillOffer) implies provisioningAdmitted(m, takesAssistant)
pure def lawOneHomeActivity(m: LauncherManifest, takesAssistant: bool): bool =
  provisioningAdmitted(m, takesAssistant) implies m.homeActivities == 1
pure def lawProductOverlayNeverSetsRoles(resources: Set[RoleResource]): bool =
  productOverlayAdmitted(resources) implies not(resources.contains(DefaultDialerResource) or resources.contains(DefaultSmsResource) or
    resources.contains(DefaultHomeResource) or resources.contains(DefaultAssistantResource))
```

## Story: Stage the consumer launcher as the home app without privileges it was not reviewed for

> As a consumer, I want my launcher staged into the image exactly as I
> reviewed it, so that a different APK, signer or permission set never
> reaches the device and a failed staging never leaves half an overlay.

### A launcher is staged only when its APK digest, signer and manifest match its descriptor

The descriptor pins the APK's SHA-256 and its signing certificate's
SHA-256, and names the permissions the APK must declare. A development
descriptor is explicit and is never taken for a reviewed one. A
permission granted on first boot or allow-listed as privileged must be
declared by the APK, and no permission is both.

```quint
type LauncherFacts = {
  apkDigestMatches: bool, signerMatches: bool, manifestMatches: bool,
  privilegedPermissions: Set[str], defaultPermissions: Set[str], declaredPermissions: Set[str]
}
pure val reviewedPrivilegedPermissions = Set("android.permission.READ_PRIVILEGED_PHONE_STATE")
pure def launcherAdmitted(l: LauncherFacts): bool =
  l.apkDigestMatches and l.signerMatches and l.manifestMatches and
  l.privilegedPermissions.subseteq(reviewedPrivilegedPermissions) and
  l.privilegedPermissions.subseteq(l.declaredPermissions) and l.defaultPermissions.subseteq(l.declaredPermissions) and
  l.privilegedPermissions.intersect(l.defaultPermissions).size() == 0
pure val plainLauncher: LauncherFacts = {
  apkDigestMatches: true, signerMatches: true, manifestMatches: true,
  privilegedPermissions: Set(), defaultPermissions: Set("android.permission.CAMERA"),
  declaredPermissions: Set("android.permission.CAMERA", "android.permission.READ_PRIVILEGED_PHONE_STATE", "android.permission.CALL_PHONE")
}
pure val lValues = Set(plainLauncher, { ...plainLauncher, apkDigestMatches: false }, { ...plainLauncher, signerMatches: false },
  { ...plainLauncher, privilegedPermissions: Set("android.permission.READ_PRIVILEGED_PHONE_STATE") },
  { ...plainLauncher, privilegedPermissions: Set("android.permission.CALL_PHONE") },
  { ...plainLauncher, privilegedPermissions: Set("android.permission.CAMERA") },
  { ...plainLauncher, defaultPermissions: Set("android.permission.RECORD_AUDIO") })
```

### A development descriptor is derived from the APK only in explicit development mode

Without a reviewed descriptor, staging can derive one from the APK only
when development mode is explicit: the digest and signer are read from a
private copy of the APK, and staging rechecks the bytes it stages against
that pin. A debuggable APK is staged only in development mode. A
production image never takes a derived descriptor, and the staging
evidence records whether it was a development staging.

```quint
type DescriptorSource = ReviewedDescriptor | DerivedDescriptor
pure def descriptorAdmitted(source: DescriptorSource, developmentMode: bool, debuggable: bool, productionImage: bool): bool =
  not(developmentMode and productionImage) and
  (source == ReviewedDescriptor or developmentMode) and (not(debuggable) or developmentMode)
pure def lawProductionNeverTakesDerivedDescriptor(developmentMode: bool, debuggable: bool): bool =
  not(descriptorAdmitted(DerivedDescriptor, developmentMode, debuggable, true))
pure def lawDebuggableLauncherNeedsDevelopment(source: DescriptorSource, productionImage: bool): bool =
  not(descriptorAdmitted(source, false, true, productionImage))
```

### The launcher is nonprivileged unless reviewed privileged permissions are named, and its grants stay revocable

Without privileged permissions the launcher is an ordinary app with no
allow-list. Only permissions from the closed reviewed set make it a
privileged app, whose allow-list holds exactly those permissions. Runtime
permissions granted on first boot are granted as not fixed, so the user
can revoke them.

```quint
type Placement = OrdinaryApp | PrivilegedApp
type LauncherStaging = { placement: Placement, allowList: Set[str], grantsFixed: bool }
pure def launcherStaging(l: LauncherFacts): LauncherStaging = {
  placement: if (l.privilegedPermissions.size() == 0) OrdinaryApp else PrivilegedApp,
  allowList: l.privilegedPermissions,
  grantsFixed: false
}
pure def lawPrivilegeOnlyFromReviewedPermissions(l: LauncherFacts): bool =
  (launcherAdmitted(l) and launcherStaging(l).placement == PrivilegedApp) implies
    launcherStaging(l).allowList.subseteq(reviewedPrivilegedPermissions) and l.privilegedPermissions.size() > 0
pure def lawFirstBootGrantsAreRevocable(l: LauncherFacts): bool = not(launcherStaging(l).grantsFixed)
```

### A companion package shares the launcher's signer and receives no grants

A companion, such as an update supervisor, is a second presigned package
of the same consumer pinned by its digest. Its signer pin is the
launcher's certificate, so it cannot carry another signer. It is staged
in the launcher's partition, never as the home app, never privileged, and
with no grants.

```quint
type Companion = { signer: str, digestMatches: bool }
type CompanionStaging = { companionPlacement: Placement, companionGrants: int, home: bool }
pure def companionAdmitted(launcherSigner: str, c: Companion): bool = launcherSigner != "" and c.signer == launcherSigner and c.digestMatches
pure val companionStaging: CompanionStaging = { companionPlacement: OrdinaryApp, companionGrants: 0, home: false }
pure val cValues = Set({ signer: "s1", digestMatches: true }, { signer: "s2", digestMatches: true }, { signer: "s1", digestMatches: false })
pure val launcherSignerValues = Set("", "s1")
```

### A staging call publishes into a destination it owns at most once

One call stages one destination. An existing destination belongs to
someone else and is refused untouched. Admission stands for the signer,
APK and native byte, descriptor and source-patch checks above. The
private staging directory is published once, after rendering; a caught
failure before publication discards it, and the call may then be retried.
A published destination is immutable.

```quint
type StagePhase = NoCall | Pending | Admitted | Rendered | Published | Refused
type LauncherInstall = {
  phase: StagePhase, privileged: bool, soong: bool, valid: bool, existing: bool,
  nativePrivileged: bool, patchRecorded: bool, bytesPreserved: bool, companionsPlain: bool,
  ownersPreserved: bool, qualified: bool, output: bool, writes: int
}
pure val initial: LauncherInstall = {
  phase: NoCall, privileged: false, soong: false, valid: false, existing: false,
  nativePrivileged: false, patchRecorded: false, bytesPreserved: true, companionsPlain: true,
  ownersPreserved: true, qualified: false, output: false, writes: 0
}
pure def canRequest(s: LauncherInstall): bool = s.phase == NoCall
pure def request(s: LauncherInstall, privileged: bool, soong: bool, valid: bool, existing: bool): LauncherInstall =
  { ...initial, phase: Pending, privileged: privileged, soong: soong, valid: valid, existing: existing, output: existing }
pure def canAdmit(s: LauncherInstall): bool = s.phase == Pending and s.valid and not(s.existing)
pure def admit(s: LauncherInstall): LauncherInstall = { ...s, phase: Admitted }
pure def canReject(s: LauncherInstall): bool = s.phase == Pending and (not(s.valid) or s.existing)
pure def reject(s: LauncherInstall): LauncherInstall = { ...s, phase: Refused }
pure def canPublish(s: LauncherInstall): bool = s.phase == Rendered
pure def publish(s: LauncherInstall): LauncherInstall = { ...s, phase: Published, output: true, writes: 1 }
pure def canDiscard(s: LauncherInstall): bool = s.phase == Admitted or s.phase == Rendered
pure def discard(s: LauncherInstall): LauncherInstall = { ...s, phase: Refused }
pure def canRetry(s: LauncherInstall): bool = s.phase == Refused and not(s.existing)
pure def retry(s: LauncherInstall): LauncherInstall =
  { ...initial, phase: Pending, privileged: s.privileged, soong: s.soong, valid: s.valid, existing: false }
pure def alwaysPublishesOnceIntoAnOwnedDestination(s: LauncherInstall): bool =
  s.writes >= 0 and s.writes <= 1 and
  (s.existing implies s.output and s.writes == 0) and
  (s.writes == 1 implies s.phase == Published and s.valid and not(s.existing))
pure def sometimesLauncherPublished(s: LauncherInstall): bool = s.phase == Published
pure def sometimesExistingDestinationRefused(s: LauncherInstall): bool = s.phase == Refused and s.existing
```

### A refused or discarded call leaves the destination as it found it

A call refused before admission, or discarded after admission and before
publication, has written nothing: an existing destination is untouched,
and a destination that did not exist still does not.

```quint
pure def alwaysRefusalWritesNothing(s: LauncherInstall): bool =
  s.phase == Refused implies s.writes == 0 and s.output == s.existing
pure def sometimesDiscardedCallLeavesNoDestination(s: LauncherInstall): bool = s.phase == Refused and s.valid and not(s.existing) and not(s.output)
```

### A call writes nothing before it publishes

Until publication a call leaves the destination as it found it. A call
that has been admitted was valid and found no existing destination, and
the payload stays untouched and claims no qualification until it is
rendered.

```quint
pure def alwaysNothingWrittenBeforePublication(s: LauncherInstall): bool =
  ((s.phase == Pending or s.phase == Admitted or s.phase == Rendered) implies s.writes == 0 and s.output == s.existing) and
  ((s.phase == Admitted or s.phase == Rendered) implies s.valid and not(s.existing)) and
  ((s.phase == Pending or s.phase == Admitted) implies
    s.bytesPreserved and s.companionsPlain and s.ownersPreserved and not(s.qualified))
```

### Native libraries are installed with their bytes, modes and placement preserved

Native payloads are converted to modules that keep the libraries' bytes
and modes and the launcher's privileged or ordinary placement. On a
Soong-only product the reviewed Soong patch is recorded. Companions stay
plain, other owners' files are untouched, and staging claims no device
qualification.

```quint
pure def alwaysRenderingPreservesThePayload(s: LauncherInstall): bool =
  (s.phase == Rendered or s.phase == Published) implies
    s.nativePrivileged == s.privileged and s.patchRecorded == s.soong and s.bytesPreserved and
    s.companionsPlain and s.ownersPreserved and not(s.qualified)
pure def canRender(s: LauncherInstall): bool = s.phase == Admitted
pure def render(s: LauncherInstall): LauncherInstall = { ...s, phase: Rendered, nativePrivileged: s.privileged, patchRecorded: s.soong }
pure def sometimesPrivilegedSoongPublished(s: LauncherInstall): bool = s.phase == Published and s.nativePrivileged and s.patchRecorded
```

### A pending call settles as published or refused

Admission, rendering, publication and refusal are the call's own steps
and are assumed fair; signer and provider success are not assumed.
Without that fairness a pending call could wait for ever.

```quint
pure val fair_admit = "weak"
pure val fair_render = "weak"
pure val fair_publish = "weak"
pure val fair_reject = "weak"
pure def leadsToSettled(s: LauncherInstall, later: LauncherInstall): bool =
  s.phase == Pending implies (later.phase == Published or later.phase == Refused)
```
