# Image provisioning

What an image sets up for the consumer's launcher before its first boot:
the default Home, assistant and Autofill offer, the component overrides that
keep the launcher eligible for the phone and messages roles, the image
features that image-only surfaces check, power-button voice on a listener
image, and the system apps that keep the lock screen, alarms and secure
capture. The writer is `src/image/provisioning.vibe`, exported from
`@elizaos/os`; the sources are develop's `launcher-provisioning.mjs`,
`image-capability.mjs`, `aosp-clock-handlers.mjs` and `secure-camera.mjs`.

The shell reads the admitted APK's manifest ([APK admission](./apk.md)) with
`aapt dump xmltree` into `LauncherManifest`: one row per activity,
activity-alias, service, receiver or provider, its name qualified with the
package, with one `Handles` entry per intent filter (a filter it does not
recognise is `OtherIntent`) and the marks it read. Feature names are the
launcher package plus `.aosp_image` or `.feature.LISTENER`. Every file is
written once into the staged product and never overwritten. All of this is
staging output. Observations of the booted image's actual components, roles
and intent resolution establish whether Android applied it.

## Story: Make my launcher Home on first boot

> As a consumer, I want a fresh device to open my launcher as Home, and as the
> assistant when my product takes that role, so that the person starts in my
> product while the stock launcher stays as a way back.

### First-boot defaults name only components the APK declares once and exports, the assistant only when the product takes it, and only once the product's requirements hold

Home is a preferred-activity entry, the assistant `config_defaultAssistant`,
Autofill `config_defaultAutofillService`. Without the assistant role the APK may
declare only disabled assist activities. A product may require Autofill and
all-files access (`MANAGE_EXTERNAL_STORAGE`). Nothing removes the stock
launcher. Refusals come in the order of `ProvisioningProblem`.

```quint
import apk.* from "./apk"
type ComponentKind = ActivityKind | ServiceKind | ReceiverKind | ProviderKind
type Handles = HomeIntent | AssistIntent | AutofillIntent | InCallIntent | DialIntent | SmsDeliverIntent | WapPushMmsIntent | RespondViaSmstoIntent | SendToSmstoIntent | MmsAuthority | SecureCaptureIntent | OtherIntent
type ComponentMark = InCallUi | CarModeUi | GrantsUri | ShowWhenLocked | TurnScreenOn
type ManifestComponent = { name: str, kind: ComponentKind, exported: bool, enabledByDefault: bool, permission: str, handles: List[Handles], marks: List[ComponentMark] }
type LauncherManifest = { components: List[ManifestComponent], requestedPermissions: List[str], powerVoiceActivity: str }
type AssistantMode = NoAssistant | LauncherAssistant | ListenerAssistant({ power: bool })
type ProductRequires = { autofill: bool, allFilesAccess: bool }
type LockScreenPolicy = LauncherMayUseLockScreen | SystemOwnsLockScreen
type ProvisioningRequest = { assistant: AssistantMode, requires: ProductRequires, telephonyRoles: bool, lockScreen: LockScreenPolicy }
type DefaultComponent = DefaultOf({ name: str }) | NoDefault
type ProvisioningProblem = AutofillUnprotected | EnabledAssistWithoutRole | HomeNotExactlyOne | HomeNotExported | AssistNotExactlyOne | AssistNotExported
  | AutofillNotExactlyOne | AutofillNotExported | AutofillMissing | AllFilesAccessMissing | RoleHandlerUnfit({ handles: Handles }) | LockScreenSurfaceDeclared
type ProvisioningDefaults = ProvisioningAdmitted({ home: str, assistant: DefaultComponent, autofill: DefaultComponent, overrides: List[str] })
  | ProvisioningRefused({ problem: ProvisioningProblem })
pure val autofillPermission = "android.permission.BIND_AUTOFILL_SERVICE"
pure val allFilesAccessPermission = "android.permission.MANAGE_EXTERNAL_STORAGE"
pure val absentComponent: ManifestComponent = { name: "", kind: ProviderKind, exported: false, enabledByDefault: false, permission: "", handles: List(), marks: List() }
pure def takesAssistant(mode: AssistantMode): bool = mode != NoAssistant
pure def activitiesHandling(manifest: LauncherManifest, intent: Handles): List[ManifestComponent] = manifest.components.select(c => c.kind == ActivityKind and c.handles.includes(intent))
pure def autofillServices(manifest: LauncherManifest): List[ManifestComponent] = manifest.components.select(c => c.kind == ServiceKind and c.handles.includes(AutofillIntent))
pure def sole(components: List[ManifestComponent]): ManifestComponent = components.nthOr(0, absentComponent)
pure def defaultFor(components: List[ManifestComponent], wanted: bool): DefaultComponent = if (wanted and components.length() == 1) DefaultOf({ name: sole(components).name }) else NoDefault
pure def provisioningDefaults(manifest: LauncherManifest, request: ProvisioningRequest): ProvisioningDefaults = {
  val home = activitiesHandling(manifest, HomeIntent)
  val assist = activitiesHandling(manifest, AssistIntent)
  val autofill = autofillServices(manifest)
  val takes = takesAssistant(request.assistant)
  val unfit = if (request.telephonyRoles) telephonyHandlers.select(h => not(handlerFits(manifest, h))) else List()
  if (autofill.some(c => c.permission != autofillPermission)) ProvisioningRefused({ problem: AutofillUnprotected })
  else if (not(takes) and assist.some(c => c.enabledByDefault)) ProvisioningRefused({ problem: EnabledAssistWithoutRole })
  else if (home.length() != 1) ProvisioningRefused({ problem: HomeNotExactlyOne })
  else if (not(sole(home).exported)) ProvisioningRefused({ problem: HomeNotExported })
  else if (takes and assist.length() != 1) ProvisioningRefused({ problem: AssistNotExactlyOne })
  else if (takes and not(sole(assist).exported)) ProvisioningRefused({ problem: AssistNotExported })
  else if (autofill.length() > 1) ProvisioningRefused({ problem: AutofillNotExactlyOne })
  else if (autofill.length() == 1 and not(sole(autofill).exported)) ProvisioningRefused({ problem: AutofillNotExported })
  else if (request.requires.autofill and autofill.length() == 0) ProvisioningRefused({ problem: AutofillMissing })
  else if (request.requires.allFilesAccess and not(manifest.requestedPermissions.includes(allFilesAccessPermission))) ProvisioningRefused({ problem: AllFilesAccessMissing })
  else if (unfit.length() > 0) ProvisioningRefused({ problem: RoleHandlerUnfit({ handles: unfit.nthOr(0, noHandler).handles }) })
  else if (request.lockScreen == SystemOwnsLockScreen and lockScreenSurfaces(manifest).length() > 0) ProvisioningRefused({ problem: LockScreenSurfaceDeclared })
  else ProvisioningAdmitted({ home: sole(home).name, assistant: defaultFor(assist, takes), autofill: defaultFor(autofill, true),
    overrides: if (request.telephonyRoles) telephonyHandlers.listMap(h => sole(handlerMatches(manifest, h)).name) else List() })
}
pure def provisioningAdmitted(defaults: ProvisioningDefaults): bool = match defaults { | ProvisioningAdmitted(d) => true | _ => false }
pure val requestValues = {
  val base = { assistant: NoAssistant, requires: { autofill: false, allFilesAccess: false }, telephonyRoles: false, lockScreen: LauncherMayUseLockScreen }
  Set(base, { ...base, assistant: LauncherAssistant }, { ...base, assistant: ListenerAssistant({ power: false }) }, { ...base, assistant: ListenerAssistant({ power: true }) },
    { ...base, telephonyRoles: true }, { ...base, lockScreen: SystemOwnsLockScreen },
    { assistant: LauncherAssistant, requires: { autofill: true, allFilesAccess: true }, telephonyRoles: true, lockScreen: SystemOwnsLockScreen })
}
pure def lawDefaultsAreDeclaredExportedComponents(manifest: LauncherManifest, request: ProvisioningRequest): bool = {
  val defaults = provisioningDefaults(manifest, request)
  match defaults {
    | ProvisioningAdmitted(d) => activitiesHandling(manifest, HomeIntent).length() == 1 and activitiesHandling(manifest, HomeIntent).every(c => c.name == d.home and c.exported)
      and autofillServices(manifest).every(c => c.exported and c.permission == autofillPermission) and (d.assistant == NoDefault iff not(takesAssistant(request.assistant)))
      and (takesAssistant(request.assistant) implies activitiesHandling(manifest, AssistIntent).every(c => c.exported and d.assistant == DefaultOf({ name: c.name })))
      and (request.requires.autofill implies d.autofill != NoDefault) and (request.requires.allFilesAccess implies manifest.requestedPermissions.includes(allFilesAccessPermission))
    | _ => true
  }
}
pure def lawWithoutTheRoleAnEnabledAssistIsRefused(manifest: LauncherManifest, request: ProvisioningRequest): bool =
  (request.assistant == NoAssistant and activitiesHandling(manifest, AssistIntent).some(c => c.enabledByDefault)) implies not(provisioningAdmitted(provisioningDefaults(manifest, request)))
```

## Story: Keep my launcher eligible for the phone and messages roles without assigning them

> As a consumer, I want my image to keep my launcher's phone and messages
> handlers available, so that the person can pick my launcher for calls and
> texts while the image never picks for them.

### Role overrides enable each required handler, found once and disabled in the APK with its exact protection, and assign no role

The override is a sysconfig `<component-override>` that Android applies at
package scan, so it survives APK updates. It only enables components; the
output has no way to name a role holder. The consumer's first-run interface
requests roles through the [system role bridge](../android/system.md);
sysconfig alone assigns none. The in-call service must declare the
in-call UI and no car-mode UI; the MMS provider is private, for the
authority `<package>.mms`, and grants URI permissions. The dial activity
handles `DIAL` with and without `tel`.

```quint
type DefaultRole = HomeRole | AssistantRole | DialerRole | SmsRole
type RoleHandler = { kind: ComponentKind, handles: Handles, exported: bool, permission: str, marks: List[ComponentMark] }
pure val telephonyHandlers: List[RoleHandler] = List(
  { kind: ServiceKind, handles: InCallIntent, exported: true, permission: "android.permission.BIND_INCALL_SERVICE", marks: List(InCallUi) },
  { kind: ActivityKind, handles: DialIntent, exported: true, permission: "", marks: List() },
  { kind: ReceiverKind, handles: SmsDeliverIntent, exported: true, permission: "android.permission.BROADCAST_SMS", marks: List() },
  { kind: ReceiverKind, handles: WapPushMmsIntent, exported: true, permission: "android.permission.BROADCAST_WAP_PUSH", marks: List() },
  { kind: ServiceKind, handles: RespondViaSmstoIntent, exported: true, permission: "android.permission.SEND_RESPOND_VIA_MESSAGE", marks: List() },
  { kind: ActivityKind, handles: SendToSmstoIntent, exported: true, permission: "", marks: List() },
  { kind: ProviderKind, handles: MmsAuthority, exported: false, permission: "", marks: List(GrantsUri) })
pure val noHandler: RoleHandler = { kind: ServiceKind, handles: OtherIntent, exported: false, permission: "", marks: List() }
pure def handlerMatches(manifest: LauncherManifest, handler: RoleHandler): List[ManifestComponent] = manifest.components.select(c => c.handles.includes(handler.handles))
pure def handlerFits(manifest: LauncherManifest, handler: RoleHandler): bool = {
  val matches = handlerMatches(manifest, handler)
  val c = sole(matches)
  matches.length() == 1 and c.kind == handler.kind and not(c.enabledByDefault) and c.exported == handler.exported and c.permission == handler.permission
    and handler.marks.every(m => c.marks.includes(m)) and not(c.marks.includes(CarModeUi))
}
pure val manifestValues = {
  val home = { name: "p.Home", kind: ActivityKind, exported: true, enabledByDefault: true, permission: "", handles: List(HomeIntent), marks: List() }
  val assist = { ...home, name: "p.Assist", enabledByDefault: false, handles: List(AssistIntent) }
  val power = { ...home, name: "p.Power", enabledByDefault: false, permission: "android.permission.STATUS_BAR_SERVICE", handles: List() }
  val autofill = { ...home, name: "p.Fill", kind: ServiceKind, permission: autofillPermission, handles: List(AutofillIntent) }
  val roles = telephonyHandlers.listMap(h => { name: "p.Role", kind: h.kind, exported: h.exported, enabledByDefault: false, permission: h.permission, handles: List(h.handles), marks: h.marks })
  val launcher = List(home, assist, power, autofill)
  val full = { components: launcher.concat(roles), requestedPermissions: List(allFilesAccessPermission), powerVoiceActivity: "p.Power" }
  Set(full, { ...full, components: launcher }, { ...full, components: List(home, { ...assist, enabledByDefault: true }, power, autofill) },
    { ...full, components: List(home, home, assist) }, { ...full, components: List({ ...home, exported: false }, assist) },
    { ...full, components: List(home, assist, { ...autofill, permission: "" }) }, { ...full, components: List(home, assist), requestedPermissions: List() },
    { ...full, components: List({ ...home, marks: List(ShowWhenLocked) }, { ...assist, handles: List(AssistIntent, OtherIntent) }, power) },
    { ...full, components: launcher.concat(roles).concat(List({ ...power, name: "p.Capture", handles: List(SecureCaptureIntent) })) }, { ...full, powerVoiceActivity: "" },
    { ...full, components: launcher.concat(roles.listMap(c => { ...c, enabledByDefault: true })) }, { ...full, components: launcher.concat(roles.listMap(c => { ...c, marks: List(CarModeUi) })) })
}
pure def lawOverridesEnableOnlyDisabledHandlers(manifest: LauncherManifest, request: ProvisioningRequest): bool = {
  val defaults = provisioningDefaults(manifest, request)
  match defaults { | ProvisioningAdmitted(d) => d.overrides.length() == (if (request.telephonyRoles) telephonyHandlers.length() else 0)
    and d.overrides.every(n => manifest.components.some(c => c.name == n and not(c.enabledByDefault))) | _ => true }
}
pure def lawEnabledHandlerIsRefused(manifest: LauncherManifest, request: ProvisioningRequest): bool =
  (request.telephonyRoles and telephonyHandlers.some(h => handlerMatches(manifest, h).some(c => c.enabledByDefault))) implies not(provisioningAdmitted(provisioningDefaults(manifest, request)))
```

### An image declares Home, the assistant when the product takes it, and the dialer and SMS app when it declares telephony roles, each backed by an admitted component

The consumer's first-run interface requests exactly these roles, the dialer
and SMS app only on a device that also has telephony. This requested set
does not establish that Android assigned a role.

```quint
pure def imageRoles(request: ProvisioningRequest): Set[DefaultRole] =
  Set(HomeRole).union(if (takesAssistant(request.assistant)) Set(AssistantRole) else Set()).union(if (request.telephonyRoles) Set(DialerRole, SmsRole) else Set())
pure def lawDeclaredRolesHaveAdmittedHandlers(manifest: LauncherManifest, request: ProvisioningRequest): bool = {
  val defaults = provisioningDefaults(manifest, request)
  match defaults { | ProvisioningAdmitted(d) => (imageRoles(request).contains(AssistantRole) implies d.assistant != NoDefault)
    and (imageRoles(request).contains(DialerRole) implies d.overrides.length() > 0) | _ => true }
}
```

## Story: Keep image-only features honest

> As a consumer, I want a surface that only my image can back to answer only on
> my image, so that a sideloaded copy of my app never claims phone, contacts or
> SMS access it cannot have.

### An image-only surface answers only from a system install that sees the image feature at the current version

Only an image puts `<package>.aosp_image` (version 1) in the product partition;
a sideloaded install refuses even if such a feature were present.

```quint
type HostInstall = SystemInstall | UserInstall
type FeatureReading = FeatureMissing | FeatureAt({ version: int })
pure val imageFeatureVersion = 1
pure def imageSurfaceAvailable(install: HostInstall, feature: FeatureReading): bool =
  install == SystemInstall and match feature { | FeatureAt(f) => f.version >= imageFeatureVersion | _ => false }
pure val featureValues = Set(FeatureMissing, FeatureAt({ version: 0 }), FeatureAt({ version: 1 }), FeatureAt({ version: 2 }))
pure def lawSideloadedOrStaleHostHasNoImageSurface(install: HostInstall, feature: FeatureReading): bool =
  not(imageSurfaceAvailable(UserInstall, feature)) and not(imageSurfaceAvailable(install, FeatureAt({ version: imageFeatureVersion - 1 })))
```

### The capability overlay for a presigned host is written only in production, for a resource that defaults false and only system or product may overlay

A presigned host cannot be rebuilt, so the image sets its boolean with a static
product-partition resource overlay; the host still needs a system install.

```quint
type OverlayPolicy = SystemOrProductPolicy | OtherPolicy
type HostResource = { defaultsFalse: bool, policies: List[OverlayPolicy] }
type OverlayProblem = OverlayInDevelopment | ResourceDefaultsTrue | ResourceNotOverlayable | ResourceOverlayableByOthers
type CapabilityOverlay = CapabilityOverlayWritten | CapabilityOverlayRefused({ problem: OverlayProblem })
pure def capabilityOverlay(mode: StagingMode, resource: HostResource): CapabilityOverlay =
  if (mode != StageProduction) CapabilityOverlayRefused({ problem: OverlayInDevelopment })
  else if (not(resource.defaultsFalse)) CapabilityOverlayRefused({ problem: ResourceDefaultsTrue })
  else if (resource.policies.length() == 0) CapabilityOverlayRefused({ problem: ResourceNotOverlayable })
  else if (resource.policies.some(p => p != SystemOrProductPolicy)) CapabilityOverlayRefused({ problem: ResourceOverlayableByOthers })
  else CapabilityOverlayWritten
pure val resourceValues = Set({ defaultsFalse: true, policies: List(SystemOrProductPolicy) }, { defaultsFalse: false, policies: List(SystemOrProductPolicy) },
  { defaultsFalse: true, policies: List() }, { defaultsFalse: true, policies: List(SystemOrProductPolicy, OtherPolicy) })
pure def lawOverlayOnlyForAProtectedFalseDefault(mode: StagingMode, resource: HostResource): bool = capabilityOverlay(mode, resource) == CapabilityOverlayWritten implies
  (mode == StageProduction and resource.defaultsFalse and resource.policies.length() > 0 and resource.policies.every(p => p == SystemOrProductPolicy))
```

## Story: Start voice from the power button only on a listener image

> As a consumer with a wake listener, I want the power button to start voice
> only on an image staged for it, so that no other app or image can trigger my
> assistant's protected voice entry.

### Listener activation enables exactly the launcher's disabled plain assist activity and, for power voice, its protected power child, given the power bundle without the assist bundle and the long-press overlay

The image writes `<package>.feature.LISTENER` (version 1) and one component
override. The assist activity is exported, with only the plain assist filter and
no permission. The power child is the activity named by the meta-data
`ai.eliza.os.POWER_VOICE_ACTIVITY`: exported, disabled, protected by
`STATUS_BAR_SERVICE`, with no intent filter. `power` and `assist` change the
same SystemUI source, so naming both is refused; the overlay is the listener's
`config_longPressOnPowerBehavior`.

```quint
type SystemuiPatch = ChipPatch | OpsPatch | AssistPatch | PowerPatch
type ListenerStaging = { patches: Set[SystemuiPatch], longPressAssistant: bool }
type ActivationProblem = NotAListenerImage | AssistAndPowerPatches | AssistNotDisabledPlain | PowerChildNotProtected | PowerPatchMissing | LongPressOverlayMissing
type ListenerActivation = ActivationWritten({ assistant: str, power: DefaultComponent }) | ActivationRefused({ problem: ActivationProblem })
type FeatureKind = AospImageFeature | ListenerFeature
pure val powerPermission = "android.permission.STATUS_BAR_SERVICE"
pure def disabledExported(c: ManifestComponent): bool = c.kind == ActivityKind and c.exported and not(c.enabledByDefault)
pure def powerChildAdmitted(manifest: LauncherManifest): bool = {
  val named = manifest.components.select(c => c.name == manifest.powerVoiceActivity)
  manifest.powerVoiceActivity != "" and named.length() == 1 and disabledExported(sole(named)) and sole(named).permission == powerPermission and sole(named).handles.length() == 0
}
pure def listenerPower(mode: AssistantMode): bool = match mode { | ListenerAssistant(l) => l.power | _ => false }
pure def listenerImage(mode: AssistantMode): bool = match mode { | ListenerAssistant(l) => true | _ => false }
pure def listenerActivation(manifest: LauncherManifest, request: ProvisioningRequest, staging: ListenerStaging): ListenerActivation = {
  val assist = activitiesHandling(manifest, AssistIntent)
  val power = listenerPower(request.assistant)
  if (not(listenerImage(request.assistant))) ActivationRefused({ problem: NotAListenerImage })
  else if (staging.patches.contains(AssistPatch) and staging.patches.contains(PowerPatch)) ActivationRefused({ problem: AssistAndPowerPatches })
  else if (not(assist.length() == 1 and disabledExported(sole(assist)) and sole(assist).permission == "" and sole(assist).handles == List(AssistIntent)))
    ActivationRefused({ problem: AssistNotDisabledPlain })
  else if (power and not(powerChildAdmitted(manifest))) ActivationRefused({ problem: PowerChildNotProtected })
  else if (power and not(staging.patches.contains(PowerPatch))) ActivationRefused({ problem: PowerPatchMissing })
  else if (power and not(staging.longPressAssistant)) ActivationRefused({ problem: LongPressOverlayMissing })
  else ActivationWritten({ assistant: sole(assist).name, power: if (power) DefaultOf({ name: manifest.powerVoiceActivity }) else NoDefault })
}
pure def imageFeatures(activation: ListenerActivation): Set[FeatureKind] =
  match activation { | ActivationWritten(a) => Set(AospImageFeature, ListenerFeature) | _ => Set(AospImageFeature) }
pure val stagingValues = Set({ patches: Set(ChipPatch, OpsPatch, PowerPatch), longPressAssistant: true }, { patches: Set(ChipPatch, OpsPatch), longPressAssistant: true },
  { patches: Set(ChipPatch, OpsPatch, PowerPatch, AssistPatch), longPressAssistant: true }, { patches: Set(ChipPatch, OpsPatch, PowerPatch), longPressAssistant: false })
pure def lawActivationEnablesOnlyDisabledExportedActivities(manifest: LauncherManifest, request: ProvisioningRequest, staging: ListenerStaging): bool = {
  val activation = listenerActivation(manifest, request, staging)
  match activation { | ActivationWritten(a) => listenerImage(request.assistant) and imageFeatures(activation).contains(ListenerFeature)
    and manifest.components.some(c => c.name == a.assistant and disabledExported(c) and c.handles == List(AssistIntent))
    and (a.power != NoDefault implies (a.power == DefaultOf({ name: manifest.powerVoiceActivity }) and powerChildAdmitted(manifest)))
    and not(staging.patches.contains(AssistPatch) and staging.patches.contains(PowerPatch)) and (a.power != NoDefault iff listenerPower(request.assistant))
    and (a.power != NoDefault implies (staging.patches.contains(PowerPatch) and staging.longPressAssistant))
    | _ => not(imageFeatures(activation).contains(ListenerFeature)) }
}
```

## Story: Leave the lock screen, alarms and secure capture to the system

> As a consumer, I want every image to keep the system Clock and secure camera,
> so that alarms ring and capture over the lock screen stays the system's, never
> my launcher's.

### Where the system owns the lock screen, an admitted launcher declares no activity shown when locked, turning the screen on, or handling secure capture

```quint
pure def lockScreenSurfaces(manifest: LauncherManifest): List[ManifestComponent] = manifest.components.select(c => c.kind == ActivityKind
  and (c.marks.includes(ShowWhenLocked) or c.marks.includes(TurnScreenOn) or c.handles.includes(SecureCaptureIntent)))
pure def lawSystemLockScreenAdmitsNoLauncherSurface(manifest: LauncherManifest, request: ProvisioningRequest): bool =
  (request.lockScreen == SystemOwnsLockScreen and provisioningAdmitted(provisioningDefaults(manifest, request))) implies lockScreenSurfaces(manifest).length() == 0
```

### The product requires DeskClock exactly once

Adding the requirement to a makefile that has it leaves it unchanged; a
makefile that names it twice is refused. The booted image must resolve all
`clockAlarmActions` to DeskClock. Staging alone establishes no such
resolution; observed resolution does not prove an alarm rings.

```quint
type ClockRequirement = ClockAdded | ClockKept | ClockNamedTwice
pure val clockPackage = "com.android.deskclock"
pure def clockRequirement(clockLines: int): ClockRequirement = if (clockLines <= 0) ClockAdded else if (clockLines == 1) ClockKept else ClockNamedTwice
pure def clockLinesAfter(clockLines: int): int = if (clockLines <= 0) 1 else clockLines
pure val clockLinesValues = Set(0, 1, 2)
pure def lawAdmittedClockIsRequiredOnce(clockLines: int): bool =
  clockRequirement(clockLines) != ClockNamedTwice implies (clockLinesAfter(clockLines) == 1 and clockRequirement(clockLinesAfter(clockLines)) == ClockKept)
```

### The secure camera overlay is staged only from verified Camera2 source and points the power gesture at Camera2

The overlay adds `Camera2` and enables the double-press power gesture for it.
The shell verifies the Camera2 modules at their reviewed commits and bytes and
passes the contract digest; staging is not device evidence.

```quint
type CameraSource = CameraSourceVerified({ contract: Digest }) | CameraSourceUnverified
type CameraStaging = CameraStaged({ gesturePackage: str, contract: Digest }) | CameraRefused
pure val secureCameraPackage = "com.android.camera2"
pure def secureCameraStaging(source: CameraSource): CameraStaging = match source {
  | CameraSourceVerified(v) => if (isDigest(v.contract)) CameraStaged({ gesturePackage: secureCameraPackage, contract: v.contract }) else CameraRefused
  | _ => CameraRefused
}
pure val sourceValues = Set(CameraSourceVerified({ contract: Sha256({ hex: "a1" }) }), CameraSourceVerified({ contract: NotADigest }), CameraSourceUnverified)
pure def lawCameraStagedOnlyFromAReviewedContract(source: CameraSource): bool = {
  val staged = secureCameraStaging(source)
  match staged { | CameraStaged(s) => isDigest(s.contract) and s.gesturePackage == secureCameraPackage and source == CameraSourceVerified({ contract: s.contract }) | _ => true }
}
```
