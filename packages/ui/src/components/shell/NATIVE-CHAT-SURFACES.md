# Native chat surfaces + native composer — implementation plan

Staged plan to render the chat's surfaces **natively per platform** (iOS/Android
now; macOS via Electrobun later; Windows/Linux DOM until native lands) behind a
single **polymorphic** abstraction — with the maximized-view **input** becoming a
real native text field, which is the one surface with no native path today.

Grounding facts (verified):
- The composer input is a DOM `<Textarea>` in **every** mode/platform, including
  maximized (`ChatOverlay.tsx` composer row ~`6095-6181`). Maximized is pure
  CSS/motion state: `fullBleed = maximized && expanded && sheetOpen && !pilled`.
- The overlay keeps **no private draft**: `draft`/`setDraft`/`pendingImages` come
  from `useChatComposerOrLocal()` → `ChatComposerContext`
  (`state/ChatComposerContext.hooks.ts`). The headless keydown/paste/IME/slash
  brains live in `chat/composer-core.ts`. Both are **reused wholesale** — native
  only renders + owns first-responder/IME and forwards *intents*.
- Two native surfaces already prove the pattern and layer on **opposite sides**
  of the webview: `GlassBridge` (material, **below** the webview, no events) and
  `NativeTranscript` (content, **above** the webview, emits `transcriptAction`;
  already reserves the bottom band for the DOM composer, `COMPOSER_BAND_PX=132`).
- The rect-anchor primitive already exists: `useNativeGlassAnchor`
  (`glass/GlassSurface.tsx`) — attach on mount, `ResizeObserver` + `resize` →
  one `requestAnimationFrame`-coalesced `updateRect`/frame, detach on cleanup.

## The abstraction (TS/React only — natives stay 3 focused plugins)

New `glass/native-surface.ts`:

```ts
export type NativePlatform = "ios" | "android" | "macos" | "windows" | "linux" | null;
export interface NativeSurfaceRect { x: number; y: number; width: number; height: number }
export interface NativeSurfaceHandle<Props, Event> {
  updateRect(rect: NativeSurfaceRect): Promise<void>;   // rAF-coalesced by the hook
  setProps(patch: Partial<Props>): Promise<void>;       // no-op channel for material surfaces
  detach(): Promise<void>;
}
export interface NativeSurfaceDriver<Props, Event> {
  readonly name: "glass" | "transcript" | "composer";
  platform(): NativePlatform;              // reads the Capacitor/Electrobun global
  isAvailable(): Promise<boolean>;         // memoized per driver
  attach(id, rect, props, onEvent): Promise<NativeSurfaceHandle<Props, Event> | null>; // null off-native → DOM
}
```

One shared hook `useNativePlatformSurface(driver, { ref, enabled, props, onEvent })`
generalizes `useNativeGlassAnchor` verbatim (probe → attach → ResizeObserver +
resize → rAF `updateRect` → `setProps` on change → detach). `enabled=false`
short-circuits to no-op (stays DOM). Each surface maps on:

| surface | Props | Event | z | attach/update/detach |
| --- | --- | --- | --- | --- |
| glass | `{cornerRadius,interactive,tint?,colorScheme?}` | `never` | below | attachGlass / updateRect / detachGlass |
| transcript | `{frame}` | `NativeTranscriptAction` | above | show / show(move) / hide; setTranscript; listen `transcriptAction` |
| **composer** (new) | `{draft,placeholder,disabled,slashItems?}` | submit/change/focus/blur/paste/slashQuery/escape | above (rect = text line only) | new plugin |

**Do NOT** unify the transport into the driver (each privately picks Capacitor
`registerPlugin` vs Electrobun `invokeDesktopBridgeRequest`); give the material
surface an event channel; merge the 3 plugins; keep app-global
`setBackdrop`/`setGrouping` off the per-surface handle; or model rect sync as a
stream (coalescing is the hook's job).

## NativeComposer

Swap **only** the `<Textarea>` (~`6095-6181`) for a `<NativeComposerInput>`: it
renders the identical DOM textarea as base/fallback and, when `enabled`, anchors
a native field over the textarea's rect (text line only) and sets the DOM
textarea `visibility:hidden` (keeps layout so buttons/height don't shift). The
`+` menu, attachment chips, mic/send stay DOM (they show through the transparent
webview band and stay interactive, like the transcript's reserved band).

Native owns the text buffer + first responder; JS keeps mirroring `draft` for
send/persist/slash/telemetry. Handler mapping: `onChange`→**debounced** `change`
(~16-33ms, not per key) → `setDraft`+`viewChatBinding.onQuery`+`expand()`;
`onKeyDown`→native emits `submit`/`escape`/`slashMove` intents, JS runs the same
`useComposerKeydown`; `onPaste`→`paste` event→`useComposerPaste`; focus/blur→
same blocks (`preFocusCollapsedRef`/`suppressExpandOnFocusRef` stay authoritative
so the tap-ladder/keyboard-dismiss logic is unchanged); `setProps({draft})` used
**only** for prefill/dictation/clear (never echoed per key — would fight the
native cursor).

- iOS: `NativeComposerPlugin.swift` beside `NativeTranscript/` — SwiftUI
  `TextEditor`/`UITextView` in a `UIHostingController` mounted **above** the
  webview (same owner-VC walk + `containerFrame` offset as
  `NativeTranscriptPlugin.swift:143-181`); events via one `composerEvent`
  channel. Reuse the existing Capacitor keyboard-inset signal — do NOT stand up a
  second keyboard pipeline (the `ElizaKeyboard` extension is an unrelated
  dictation keyboard).
- Android: `NativeComposerPlugin.java` beside `transcript/` — growing `EditText`,
  `TextWatcher`/`OnEditorActionListener`/`OnKeyListener`/`OnFocusChangeListener`;
  add a composer golden mirroring `TranscriptContractTest.java`.

**Gate (maximized-only):** engage when `fullBleed` AND `useNativeGlass()==="native"`
AND `composerDriver.isAvailable()` AND not in a slash session. Maximized is the
one at-rest, stable, full-bleed state where a native mount won't thrash focus /
keyboard; pill/half morph and swap focus per-frame — stay DOM there.

**Slash (the one z-order snag):** DOM paints below the native field, so a DOM
slash popover would render under it. Phase 1: when `draft.startsWith("/")` set
`enabled=false` for that session (DOM textarea + DOM slash menu take over, one
focus handoff — invisible in practice). Phase 2 (optional): native popover from
`slashItems`, emits `slashPick(index)`.

## Desktop (Electrobun)

Driver `platform()` returns `macos|windows|linux`; transport =
`invokeDesktopBridgeRequest`/`subscribeDesktopBridgeEvent` (`electrobun-rpc.ts`).
macOS overlays a child `NSTextView` (optionally on the existing opt-in
`NSVisualEffectView`) at the RPC-reported rect, above the webview, `composerEvent`
back — same attach/update/setProps/detach shape. Windows/Linux: `attach()`
returns `null` → DOM fallback, zero extra code. **Also note:** desktop chat
currently runs the older HomePill+AssistantOverlay+ChatSurface, **not**
ChatOverlay, and the bottom-bar window is a fixed 140px OS window — desktop
parity needs (a) swapping `ChatOverlayShell`/`ShellFoundationMount`
(`App.tsx:509,1884`) to render `<ChatOverlay>` and (b) growing the OS window on
maximize via `desktopSetWindowBounds` (`electrobun/src/rpc-handlers.ts:781`).
Those are a separate desktop track; the abstraction lets native-composer land
there later without reshaping anything.

## Performance

rAF-coalesced rect sync (≤1 `updateRect`/frame even during the morph; gate keeps
it off during the morph anyway). No round-trip per keystroke — native renders
text locally at 60fps, JS gets a debounced `change` only. Send is instant (Enter
→ native `submit` intent → JS `submit()` with already-mirrored draft). Pass a
**stable** `props` object (rebuilt only when placeholder/disabled/slashItems
change) and a `useCallback` `onEvent` so `setProps` diffs fire rarely.

## Staged rollout — status

- **Stage 0 — DONE.** `native-surface.ts` (`NativeSurfaceDriver`/`Handle`) +
  `useNativePlatformSurface` (generalizes `useNativeGlassAnchor`: probe → attach →
  rAF-coalesced `ResizeObserver`+resize sync → `setProps` diff → detach), 5 unit
  tests. Its first real consumer is the composer (below), so it is not a dead
  abstraction. Adopting `useNativeGlassAnchor` + the transcript demo onto it is a
  follow-up cleanup (glass reads `cornerRadius` from the DOM per frame — the
  geometry already carries it, so the adoption is mechanical, deferred only to
  avoid churning the device-verified glass in the same pass).
- **Stage 1 — DONE + PROVEN (behind the flag).** iOS `NativeComposerPlugin.swift`
  (UITextView above the webview) — compiles + registers. Android
  `NativeComposerPlugin.java` (EditText) — **proven end-to-end on the emulator**,
  full flow: maximize → native field mounts (DOM textarea hidden) → tap → focus,
  keyboard up, sheet STAYS maximized → typing mirrors to the JS draft via the
  `change` intent, still maximized → Return → `submit` intent → message sent,
  draft cleared, still active. Native owns the buffer, JS owns intents; setProps
  echo-guarded. Slash yields to DOM. Gated
  `localStorage["eliza:native-composer"]="1"`, **OFF by default** — DOM composer
  stays the default so no regression ships.
- **REMAINING before default-on:**
  1. **iOS runtime verification.** The Swift plugin compiles + registers but the
     iOS sim WebView can't be drag-maximized via idb (a tooling limit), so its
     runtime (mount rect, iOS keyboard/first-responder) is unverified on-device —
     do it on a real device (or the harness AppKit spike) before iOS default-on.
     The TS + intent contract is shared and Android proves the whole flow.
  2. **Mid-animation race.** Tapping the field DURING the ~300ms maximize
     animation (before it settles) can collapse — settle-gate the mount so it
     only attaches once maximized is committed (also removes the dev-StrictMode
     attach/detach doubling).
  3. Placeholder styling parity; multi-line (Return currently sends).
- **Stage 2 — polish:** native slash popover (Phase 2), attachment badge.
- **Stage 3 — desktop macOS** via Electrobun RPC driver (NSTextView); the
  abstraction already returns the DOM fallback on Windows/Linux. Desktop chat also
  needs the ChatOverlay swap + OS-window-grow (separate track, see §3).

**Anti-goals:** one mega-plugin; a shared native base class as a prerequisite;
native composer at pill/half; echoing draft per keystroke or JS↔native keystroke
round-trips; re-implementing composer logic natively; a second keyboard pipeline;
blocking mobile on desktop; Windows/Linux native before macOS.
