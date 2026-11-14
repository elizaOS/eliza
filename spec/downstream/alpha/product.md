# Alpha product registration and view admission

Alpha binds `defineMobileProductRegistration`, `createMobileViewRegistry`,
`mobileShellViewPath` and `mobileShellViewPaths` from Eliza's React-free
`@elizaos/ui/mobile-shell/core` entry. The pinned owner is
`packages/ui/src/mobile-shell/{product-registration,view-registry,view-ids}.ts`.
Alpha supplies `apps/app/src/product/alpha-product-registration.ts` and
uses `alphaNavigation` to bind current renderer-key availability. Registry
identity, renderer availability and an action's permission are separate
checks. The production renderer supplies no lazy contributions.

## Story: Open and discover the views this installation supports

As an Alpha owner, I can open the same supported view through old local
names, agent targets, and canonical paths. Entries only appear in the
launcher when their renderer is available. Native phone features require
the image's trusted capability and the specific native adapter. A browser
development fixture never establishes native action authority.

### Canonical names, renderer keys and served views resolve separately

Canonicalization recognizes all upstream view names, including canonical
names Alpha does not render. `home`, `workflows`, and `wallet` migrate to
`chat`, `automations`, and `inventory`. A reminders target lands in
Calendar without rewriting the requested canonical ID to Calendar. The
registry first recognizes the canonical ID, then checks the owning view's
availability. Home is `/chat`, Files is `/apps/files`, and Inventory is
`/wallet`. The other canonical paths are `/<canonical>`; incoming links
also accept `/apps/<canonical>`, `/<input>`, `/apps/<input>`, and `/` for Home.
The route adapter matches these paths against its authenticated renderer
origin. It must check target availability separately.

```quint
type CanonicalView = Chat | Inbox | Calendar | Reminders | Notes | Automations | Browser | Camera | Photos | Maps | Files | Contacts | Phone | Messages | Clock | Settings | Inventory | UnknownView
pure def viewName(viewId: CanonicalView): str = match viewId {
  | Chat => "chat" | Inbox => "inbox" | Calendar => "calendar" | Reminders => "reminders"
  | Notes => "notes" | Automations => "automations" | Browser => "browser" | Camera => "camera"
  | Photos => "photos" | Maps => "maps" | Files => "files" | Contacts => "contacts"
  | Phone => "phone" | Messages => "messages" | Clock => "clock" | Settings => "settings"
  | Inventory => "inventory" | UnknownView => ""
}
pure def canonicalView(name: str): CanonicalView =
  if (name == "home" or name == "chat") Chat
  else if (name == "inbox") Inbox else if (name == "calendar") Calendar
  else if (name == "reminders") Reminders else if (name == "notes") Notes
  else if (name == "workflows" or name == "automations") Automations
  else if (name == "browser") Browser else if (name == "camera") Camera
  else if (name == "photos") Photos else if (name == "maps") Maps
  else if (name == "files") Files else if (name == "contacts") Contacts
  else if (name == "phone") Phone else if (name == "messages") Messages
  else if (name == "clock") Clock else if (name == "settings") Settings
  else if (name == "wallet" or name == "inventory") Inventory else UnknownView
pure def viewOwner(viewId: CanonicalView): CanonicalView = if (viewId == Reminders) Calendar else viewId
pure def rendererKey(viewId: CanonicalView): str =
  if (viewId == Chat) "home" else if (viewId == Automations) "workflows"
  else if (viewId == Inventory) "wallet" else viewName(viewId)
pure def canonicalPath(viewId: CanonicalView): str = match viewId {
  | Chat => "/chat"
  | Inbox => "/inbox"
  | Calendar => "/calendar"
  | Reminders => "/reminders"
  | Notes => "/notes"
  | Automations => "/automations"
  | Browser => "/browser"
  | Camera => "/camera"
  | Photos => "/photos"
  | Maps => "/maps"
  | Files => "/apps/files"
  | Contacts => "/contacts"
  | Phone => "/phone"
  | Messages => "/messages"
  | Clock => "/clock"
  | Settings => "/settings"
  | Inventory => "/wallet"
  | UnknownView => ""
}
pure def plainPath(viewId: CanonicalView): str = match viewId {
  | Chat => "/chat"
  | Inbox => "/inbox"
  | Calendar => "/calendar"
  | Reminders => "/reminders"
  | Notes => "/notes"
  | Automations => "/automations"
  | Browser => "/browser"
  | Camera => "/camera"
  | Photos => "/photos"
  | Maps => "/maps"
  | Files => "/files"
  | Contacts => "/contacts"
  | Phone => "/phone"
  | Messages => "/messages"
  | Clock => "/clock"
  | Settings => "/settings"
  | Inventory => "/inventory"
  | UnknownView => ""
}
pure def appsPath(viewId: CanonicalView): str = match viewId {
  | Chat => "/apps/chat"
  | Inbox => "/apps/inbox"
  | Calendar => "/apps/calendar"
  | Reminders => "/apps/reminders"
  | Notes => "/apps/notes"
  | Automations => "/apps/automations"
  | Browser => "/apps/browser"
  | Camera => "/apps/camera"
  | Photos => "/apps/photos"
  | Maps => "/apps/maps"
  | Files => "/apps/files"
  | Contacts => "/apps/contacts"
  | Phone => "/apps/phone"
  | Messages => "/apps/messages"
  | Clock => "/apps/clock"
  | Settings => "/apps/settings"
  | Inventory => "/apps/inventory"
  | UnknownView => ""
}
pure def pathMatches(name: str, route: str): bool = {
  val card = canonicalView(name)
  card != UnknownView and (route == canonicalPath(card) or route == plainPath(card) or route == appsPath(card) or
    (name == "home" and (route == "/home" or route == "/apps/home")) or
    (name == "workflows" and (route == "/workflows" or route == "/apps/workflows")) or
    (name == "wallet" and (route == "/wallet" or route == "/apps/wallet")) or
    (card == Chat and route == "/"))
}
pure def lawCanonicalNamesMatch(viewId: CanonicalView): bool = canonicalView(viewName(viewId)) == viewId
pure def lawKnownCanonicalsAcceptTheirPath(name: str): bool = canonicalView(name) == UnknownView or pathMatches(name, canonicalPath(canonicalView(name)))
pure def lawRemindersKeepsItsName(name: str): bool = name == "reminders" implies canonicalView(name) == Reminders and viewOwner(canonicalView(name)) == Calendar
pure val nameValues = Set("home", "chat", "calendar", "reminders", "files", "automations", "workflows", "wallet", "clock", "wrong")
```

### View discovery follows the registered product order and live image facts

The first seven image inputs capture the trusted bridge's platform,
launcher flavor, system partition, overlay, advertised feature, release
build and mocks status. The renderer sees the native capability rather
than trusting its own values for those inputs. Phone and Messages also
require their reviewed adapters. Contacts depends on fresh native device
capability and can be revoked. Wallet appears only in a development
fixture. Registered capabilities are descriptive and do not grant
permissions or validate effect reviews.

```quint
type ImageFacts = { android: bool, launcher: bool, systemPartition: bool, overlay: bool, systemFeature: bool, release: bool, mocks: bool }
type ViewAdmission = { verified: bool, phone: bool, messages: bool, contacts: bool, fixture: bool }
pure val productOrder: List[CanonicalView] = List(Phone, Messages, Inbox, Calendar, Browser, Camera, Photos, Maps, Notes, Contacts, Files, Inventory, Automations, Settings)
pure val imageValues = Set({ android: true, launcher: true, systemPartition: true, overlay: true, systemFeature: true, release: true, mocks: false }, { android: true, launcher: true, systemPartition: false, overlay: false, systemFeature: false, release: true, mocks: false }, { android: false, launcher: false, systemPartition: false, overlay: false, systemFeature: false, release: false, mocks: true })
pure val admissionValues = Set({ verified: false, phone: false, messages: false, contacts: false, fixture: false }, { verified: true, phone: true, messages: true, contacts: false, fixture: false }, { verified: true, phone: true, messages: true, contacts: true, fixture: false }, { verified: false, phone: false, messages: false, contacts: false, fixture: true })
pure def imageVerified(image: ImageFacts): bool = image.android and image.launcher and image.systemPartition and image.overlay and image.systemFeature and image.release and not(image.mocks)
pure def imageAdapter(viewId: CanonicalView, admission: ViewAdmission): bool =
  admission.verified and (if (viewId == Phone) admission.phone else if (viewId == Messages) admission.messages else if (viewId == Contacts) admission.contacts else false)
pure def ownerAvailable(viewId: CanonicalView, admission: ViewAdmission): bool =
  if (viewId == Phone or viewId == Messages or viewId == Contacts) admission.fixture or imageAdapter(viewId, admission)
  else if (viewId == Inventory) admission.fixture
  else viewId == Chat or (viewId != UnknownView and viewId != Reminders and viewId != Clock)
pure def targetView(name: str, admission: ViewAdmission): CanonicalView = {
  val owner = viewOwner(canonicalView(name))
  if (ownerAvailable(owner, admission)) owner else UnknownView
}
pure def lawFixtureNeverVerifiesImage(image: ImageFacts): bool = image.mocks implies not(imageVerified(image))
pure def lawAnImageAdapterRequiresImage(viewId: CanonicalView, admission: ViewAdmission): bool = imageAdapter(viewId, admission) implies admission.verified
pure def lawWalletRequiresFixture(admission: ViewAdmission): bool = targetView("wallet", admission) == Inventory implies admission.fixture
pure def lawUnknownViewHasNoTarget(admission: ViewAdmission): bool = targetView("wrong", admission) == UnknownView
```

### The registration validates identity, theme, routes and retained installed names before use

`MobileProductRegistration` v1 has a positive safe integer revision and
reverse-domain app identity with nonblank display and character names.
Both appearances provide every required color and each chrome token.
Custom properties cannot collide with upstream tokens or each other.
Icons use a base prefix and canonical glyph names. Ordered IDs exclude
Home and duplicates, have labels, and use unique renderer keys that are
registered legacy IDs. Legacy keys never shadow canonical IDs. Served
IDs have one ordered owner, exclude Home and map to views outside the
ordered list. Storage keys are distinct, including the installed favorite
key, and the prefix and default-policy names retain their syntaxes.
Capability and action names are distinct within their respective lists.
`defineMobileProductRegistration` throws the complete issue list before
publishing, and freezes a valid record. Lexical checks, issue strings,
JavaScript object freezing, and theme variable application need adapter
refinement against the pinned fixtures. The model owns the conjunction of
the decoded checks and appearance selection.

```quint
type RegistrationFacts = { tagValid: bool, version: int, revision: int, identityValid: bool, themeValid: bool, iconsValid: bool, backgroundsValid: bool, viewsValid: bool, storageValid: bool, featuresValid: bool }
type Appearance = Light | Dark | System | MissingAppearance
pure val registrationValues = Set({ tagValid: true, version: 1, revision: 1, identityValid: true, themeValid: true, iconsValid: true, backgroundsValid: true, viewsValid: true, storageValid: true, featuresValid: true }, { tagValid: true, version: 0, revision: 1, identityValid: true, themeValid: true, iconsValid: true, backgroundsValid: true, viewsValid: true, storageValid: true, featuresValid: true }, { tagValid: true, version: 1, revision: 1, identityValid: true, themeValid: true, iconsValid: true, backgroundsValid: true, viewsValid: false, storageValid: true, featuresValid: true })
pure def validRegistration(registration: RegistrationFacts): bool =
  registration.tagValid and registration.version == 1 and registration.revision > 0 and registration.revision <= 9007199254740991 and
  registration.identityValid and registration.themeValid and registration.iconsValid and registration.backgroundsValid and
  registration.viewsValid and registration.storageValid and registration.featuresValid
pure def resolvedAppearance(preference: Appearance, defaultAppearance: Appearance, systemDark: bool): Appearance = {
  val choice = if (preference == MissingAppearance) defaultAppearance else preference
  if (choice == System) { if (systemDark) Dark else Light } else choice
}
pure def lawRegistrationRequiresViewAndStorageValidity(registration: RegistrationFacts): bool =
  validRegistration(registration) implies registration.viewsValid and registration.storageValid
pure def lawExplicitAppearanceWins(preference: Appearance, defaultAppearance: Appearance, systemDark: bool): bool =
  (preference == Light or preference == Dark) implies resolvedAppearance(preference, defaultAppearance, systemDark) == preference
```
