# Browser surface bridge and host Activity

The browser surface plugin lives in the consumer's host Activity beside
the renderer WebView that commands it. This spec covers what the plugin
does around that renderer: while the renderer process is gone, when the
person presses Back, and when the on-screen keyboard opens or closes
(`keyboardChanged`). [Surface lifecycle](./lifecycle.md) owns the
surfaces and their owner fence.

## Story: Keep the browser safe and responsive around the host renderer

> As the person, I want Back to do what the app shows me first, the page
> to make room for the keyboard, and nothing to happen to a website while
> the app's own screen is restarting.

### No surface command runs while the host renderer is gone

When Android reports the host renderer process gone, the plugin refuses
every surface command until a new renderer realm has reconciled its
owner. Commands already running finish; nothing queued while the
renderer was gone runs later.

```quint
type BackPhase = BackIdle | BackOfferedToUi | BackToPage | BackToActivity | BackHandledByUi
type BridgeActivity = { rendererLive: bool, realm: int, refused: int, ran: int, back: BackPhase, pageCanGoBack: bool,
  keyboardVisible: bool, keyboardHeight: int, keyboardReports: int }
pure val initial: BridgeActivity = { rendererLive: true, realm: 1, refused: 0, ran: 0, back: BackIdle, pageCanGoBack: false,
  keyboardVisible: false, keyboardHeight: 0, keyboardReports: 0 }
pure def canRendererGone(s: BridgeActivity): bool = s.rendererLive
pure def rendererGone(s: BridgeActivity): BridgeActivity = { ...s, rendererLive: false }
pure def canRendererReconciled(s: BridgeActivity, realm: int): bool = not(s.rendererLive) and realm > s.realm
pure def rendererReconciled(s: BridgeActivity, realm: int): BridgeActivity = { ...s, rendererLive: true, realm: realm }
pure def canSurfaceCommand(s: BridgeActivity, realm: int): bool = realm > 0
pure def surfaceCommand(s: BridgeActivity, realm: int): BridgeActivity =
  if (s.rendererLive and realm == s.realm) { ...s, ran: s.ran + 1 } else { ...s, refused: s.refused + 1 }
pure val realmValues = Set(1, 2, 3)
pure def stepNoCommandWhileRendererGone(before: BridgeActivity, after: BridgeActivity): bool =
  after.ran > before.ran implies before.rendererLive and after.rendererLive
pure def sometimesCommandRefusedWhileGone(s: BridgeActivity): bool = not(s.rendererLive) and s.refused > 0
pure def sometimesRendererBack(s: BridgeActivity): bool = s.realm > 1 and s.ran > 0
```

### Back is offered to the app's own screen first

A Back press is offered to the renderer first. Only when the renderer
declines does the page go back in its own history, if it can, and only
when neither can does Android's default Back run. A press while the
renderer is gone goes straight to the page or Android, never to a
renderer that cannot answer.

```quint
pure def canPressBack(s: BridgeActivity, pageCanGoBack: bool): bool = s.back == BackIdle or s.back == BackToPage or s.back == BackToActivity or s.back == BackHandledByUi
pure def pressBack(s: BridgeActivity, pageCanGoBack: bool): BridgeActivity =
  if (s.rendererLive) { ...s, back: BackOfferedToUi, pageCanGoBack: pageCanGoBack }
  else { ...s, back: if (pageCanGoBack) BackToPage else BackToActivity, pageCanGoBack: pageCanGoBack }
pure def canUiAnswersBack(s: BridgeActivity, handled: bool): bool = s.back == BackOfferedToUi
pure def uiAnswersBack(s: BridgeActivity, handled: bool): BridgeActivity =
  { ...s, back: if (handled) BackHandledByUi else if (s.pageCanGoBack) BackToPage else BackToActivity }
pure def stepActivityBackOnlyAfterUiAndPageDecline(before: BridgeActivity, via: str, after: BridgeActivity): bool =
  after.back == BackToActivity and before.back != BackToActivity implies not(after.pageCanGoBack) and
    (via == "uiAnswersBack" or not(before.rendererLive))
pure def stepUiOfferedBeforePage(before: BridgeActivity, via: str, after: BridgeActivity): bool =
  after.back == BackToPage and before.back != BackToPage implies via == "uiAnswersBack" or not(before.rendererLive)
pure def sometimesUiHandlesBack(s: BridgeActivity): bool = s.back == BackHandledByUi
pure def sometimesPageGoesBack(s: BridgeActivity): bool = s.back == BackToPage
```

### Every keyboard change is reported once, with its height in host pixels

When the on-screen keyboard opens, closes or changes height, the plugin
sends one `keyboardChanged` with whether it is visible and its height in
host CSS pixels, zero when hidden. An unchanged keyboard sends nothing.

```quint
pure def canKeyboardChanged(s: BridgeActivity, visible: bool, height: int): bool = height >= 0
pure def keyboardChanged(s: BridgeActivity, visible: bool, height: int): BridgeActivity = {
  val shown = if (visible) height else 0
  if (visible == s.keyboardVisible and shown == s.keyboardHeight) s
  else { ...s, keyboardVisible: visible, keyboardHeight: shown, keyboardReports: s.keyboardReports + 1 }
}
pure val heightValues = Set(0, 280, 320)
pure def alwaysHiddenKeyboardHasNoHeight(s: BridgeActivity): bool = not(s.keyboardVisible) implies s.keyboardHeight == 0
pure def stepReportOnlyOnChange(before: BridgeActivity, after: BridgeActivity): bool =
  after.keyboardReports > before.keyboardReports implies
    after.keyboardReports == before.keyboardReports + 1 and (after.keyboardVisible != before.keyboardVisible or after.keyboardHeight != before.keyboardHeight)
pure def sometimesKeyboardReported(s: BridgeActivity): bool = s.keyboardVisible and s.keyboardHeight > 0
```
