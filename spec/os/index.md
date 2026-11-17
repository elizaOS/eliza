# Android device

The agent service, device sign-in and credential custody, native bridges,
device audio, browser, and the image, APK and update build library. Its
specifications are being written.

## Story: Sign in with a saved password in the private browser

> As the person, I want to use Android's password picker on the exact
> website I am visiting, so I can sign in without giving the assistant
> my password or my signed-in browser session.

### Protected sign-in opens in a new temporary browser profile

The host offers a public HTTPS sign-in destination in its local interface.
The browser opens a private visit only when Android has a renderer outside
the app, isolated storage and a WebView that can attest the frame origin.
The host opens a fresh temporary profile and retires it on close.
The assistant can describe the public destination. The visit reports the
HTTPS origin and basic presentation and load state to the local interface.
Page content, title, address path, query, download data and authenticated
browser state stay outside the host bridge and outside assistant tools. The host protects the window during the
private visit. All browser-surface capture requests are refused while the
protected visit exists, and opening it invalidates any capture in progress.

```quint
type SignInAudience = LocalInterface | Assistant
type SignInObservation = PublicDestination | SurfaceMetadata | PageArtifact | Credential | AuthenticatedSession
pure def mayObserveSignIn(audience: SignInAudience, observation: SignInObservation): bool =
  observation == PublicDestination or (audience == LocalInterface and observation == SurfaceMetadata)
pure def lawAssistantSeesOnlyPublicDestination(observation: SignInObservation): bool =
  mayObserveSignIn(Assistant, observation) == (observation == PublicDestination)
type SignInVisit = {
  open: bool, shown: bool, resumed: bool, committed: bool, bound: bool,
  chosen: bool, filled: bool, capture: bool
}
pure val initial: SignInVisit = {
  open: false, shown: false, resumed: true, committed: false,
  bound: false, chosen: false, filled: false, capture: false
}
pure def canOpenSignIn(s: SignInVisit, isolatedProcess: bool, freshStorage: bool, nativeFrameOrigin: bool): bool =
  not(s.open) and isolatedProcess and freshStorage and nativeFrameOrigin
pure def openSignIn(s: SignInVisit, isolatedProcess: bool, freshStorage: bool, nativeFrameOrigin: bool): SignInVisit =
  { ...initial, open: true, resumed: s.resumed }
pure def canCloseSignIn(s: SignInVisit): bool = s.open
pure def closeSignIn(s: SignInVisit): SignInVisit = { ...initial, resumed: s.resumed }
pure def canStartCapture(s: SignInVisit): bool = not(s.open or s.capture)
pure def startCapture(s: SignInVisit): SignInVisit = { ...s, capture: true }
pure def canReleaseCapture(s: SignInVisit): bool = s.capture and not(s.open)
pure def releaseCapture(s: SignInVisit): SignInVisit = { ...s, capture: false }
pure def alwaysVisitBlocksCapture(s: SignInVisit): bool = s.open implies not(s.capture)
pure def stepOpeningRevokesCapture(before: SignInVisit, via: str, after: SignInVisit): bool =
  via == "openSignIn" implies after.open and not(after.capture)
```

### Only the person can fill an exact field in the current website

The selected, visible, resumed surface needs a committed HTTPS document.
Its engine-reported frame origin must match that document's precise origin,
including its port. The browser uses the native Autofill binding. The
password provider opens a fresh native unlock and the person chooses an
entry. The device fills only the bound field, and there is no application
bridge operation to fetch or fill a credential. Navigating, hiding, or
closing the visit invalidates the pending choice. The provider may cancel
or expire it. The activity pause while
Android shows its own picker keeps the pending choice, but delivering it
waits for the still-current foreground document.

```quint
pure def canShowSignIn(s: SignInVisit): bool = s.open and not(s.shown)
pure def showSignIn(s: SignInVisit): SignInVisit = { ...s, shown: true }
pure def canHideSignIn(s: SignInVisit): bool = s.shown
pure def hideSignIn(s: SignInVisit): SignInVisit =
  { ...s, shown: false, bound: false, chosen: false, filled: false }
pure def canCommitSignIn(s: SignInVisit, committedHttps: bool): bool = s.open and committedHttps
pure def commitSignIn(s: SignInVisit, committedHttps: bool): SignInVisit =
  { ...s, committed: true, bound: false, chosen: false, filled: false }
pure def canNavigateSignIn(s: SignInVisit): bool = s.open and s.committed
pure def navigateSignIn(s: SignInVisit): SignInVisit =
  { ...s, committed: false, bound: false, chosen: false, filled: false }
pure def canPauseHost(s: SignInVisit): bool = s.resumed
pure def pauseHost(s: SignInVisit): SignInVisit = { ...s, resumed: false, filled: false }
pure def canResumeHost(s: SignInVisit): bool = not(s.resumed)
pure def resumeHost(s: SignInVisit): SignInVisit = { ...s, resumed: true }
pure def canBindSignInField(s: SignInVisit, exactEngineOrigin: bool): bool =
  s.open and s.shown and s.resumed and s.committed and exactEngineOrigin
pure def bindSignInField(s: SignInVisit, exactEngineOrigin: bool): SignInVisit =
  { ...s, bound: true, chosen: false, filled: false }
pure def canChoosePassword(s: SignInVisit, freshNativeUnlock: bool): bool =
  s.bound and freshNativeUnlock and not(s.chosen)
pure def choosePassword(s: SignInVisit, freshNativeUnlock: bool): SignInVisit =
  { ...s, chosen: true, filled: false }
pure def canCancelPasswordChoice(s: SignInVisit): bool = s.bound
pure def cancelPasswordChoice(s: SignInVisit): SignInVisit =
  { ...s, bound: false, chosen: false, filled: false }
pure def canFillPassword(s: SignInVisit): bool = s.bound and s.chosen and s.resumed
pure def fillPassword(s: SignInVisit): SignInVisit = { ...s, filled: true, chosen: false }
pure def alwaysShownSignInIsOpen(s: SignInVisit): bool = s.shown implies s.open
pure def alwaysBoundFieldIsCurrent(s: SignInVisit): bool = s.bound implies s.shown and s.committed
pure def alwaysChoiceHasField(s: SignInVisit): bool = s.chosen implies s.bound
pure def alwaysFillStaysForeground(s: SignInVisit): bool = s.filled implies s.bound and s.resumed
pure def stepFillConsumesNativeChoice(before: SignInVisit, via: str, after: SignInVisit): bool =
  via == "fillPassword" implies before.chosen and after.filled and not(after.chosen)
pure def sometimesPersonFillsPassword(s: SignInVisit): bool = s.filled
```
