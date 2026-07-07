# Continuous chat sheet — state × gesture transition matrix

The single source of truth for what every gesture does from every resting state
of the pull-up chat sheet (`ContinuousChatOverlay.tsx`). The e2e continuum suite
(`run-chat-sheet-e2e.mjs`, `runContinuumSuite`) asserts the load-bearing rows.

## Resting states

| State | `data-detent` | `data-chat-state` | Thread height | Notes |
| --- | --- | --- | --- | --- |
| **PILL** | `pill` | `CLOSED` | 0 | White capsule at the bottom; composer inert; taps pass through to home. |
| **INPUT** | `collapsed` | `INPUT` | 0 | Bare composer bar; the default resting state. |
| **HALF** | `half` | `OPEN_HALF_OR_OVER` | `0.46 × viewport` | Comfortable reading height; header visible. |
| **FREE** | `half`/`full` label folds by height | `OPEN_UNDER_HALF` or `OPEN_HALF_OR_OVER` | wherever released | A deliberate slow drag rests where the finger left it (only in the gaps between detents — releases within 64px of a detent snap to it). |
| **FULL** | `full` | `OPEN_HALF_OR_OVER` | `panelMaxH` (sheet under the status bar) | Inset overlay (12px side padding, rounded). |
| **MAXIMIZED** | `full` + `data-maximized` | `MAXIMIZED` | `panelMaxH` | Edge-to-edge full-bleed; grabber replaced by the top restore strip. |

Continuous motion values: `threadHeight` (px, finger-tracked), `openProgress`
(0 = pill capsule ↔ 1 = input bar formed; the liquid-glass morph), `fullBleedT`
(0 = inset ↔ 1 = edge-to-edge shape).

## Gesture vocabulary

- **tap** — release with < 12px movement and no flick velocity.
- **flick** — release ≥ 0.5 px/ms (whole-press or last-segment velocity).
- **slow drag** — deliberate drag released below flick velocity → `onSettleFree` (rests where released, with detent magnetism ±64px).
- **nudge** — small slow movement; springs back to the current state.
- **held drag** — the live finger: `threadHeight` tracks 1:1; past FULL it drives the maximize morph up to the full-bleed ceiling, where further travel is **consumed** (never banked — see the follow-the-finger invariant); past the bottom it drives the input→pill morph.

## Transitions

### From PILL
| Gesture | Result |
| --- | --- |
| Tap | HALF when a thread exists (single tap always opens the chat), else INPUT + keyboard. |
| Flick up (short) | HALF when a thread exists, else INPUT. |
| Held drag up, released anywhere | One continuum: first 120px morphs pill→input (`openProgress`), excess flows into the thread height. Release: < 64px of thread → INPUT; ≥ half+64 → FULL; between → HALF or free rest; a long haul (≥ 80% of the screen) → **MAXIMIZED**. |
| Slow drag up < half the pill morph (`openProgress` < 0.5) | springs back to PILL. |
| Flick/drag down | stays PILL (lowest state). |
| Horizontal swipe | pages home ↔ launcher (sheet closed only). |

### From INPUT
| Gesture | Result |
| --- | --- |
| Tap grabber | HALF when a thread exists, else focuses the composer. |
| Flick up | HALF (or FULL if the held height already passed half+64; MAXIMIZED past the 80%-viewport peak). |
| Slow drag up, released < 64px | springs back to INPUT ("not enough to see a full row"). |
| Slow drag up, released higher | HALF / FULL magnetism, free rest in gaps, MAXIMIZED on a long haul (≥ 80% of the screen). |
| Drag down (morph < halfway) | springs back to INPUT. |
| Drag down (morph ≥ halfway) or flick down | PILL — the input bar visibly scales down into the capsule under the finger. |

### From HALF (and FREE rests)
| Gesture | Result |
| --- | --- |
| Tap grabber | keyboard up → dismiss keyboard to prior state; else collapse to INPUT. |
| Flick up | FULL. |
| Flick down | free rest above half steps to HALF first; at/below half → INPUT. |
| Slow drag | magnetism: ≤ 64px at the bottom → INPUT (PILL when the gesture started above half+64 or overshot the bottom ≥ 40px); near half/full → that detent; gaps → FREE rest. |
| Held over-pull past FULL | tracks the finger 1:1: the panel grows from the inset FULL height to the full-bleed ceiling across the REAL pixel gap (`fullPanelMaxH − insetPanelMaxH`), the shape morph (corners/insets/height cap) a pure function of that height; the grabber bar fades OUT with the same morph (`grabberBarOpacity`), fully dissolved by edge-to-edge. Travel past the ceiling is CONSUMED (offset rebased), so a reversal moves the sheet with the very first downward pixel. Release with the morph ≥ half complete — or a long haul from ≤ HALF sweeping ≥ 80% of the screen — commits MAXIMIZED; short of it, springs back to FULL. A pull that entered the over-pull zone but reversed back below the inset FULL height ABANDONS the maximize (its peak is voided) — the release rests where the finger left it, never re-maximizing. |
| Held drag past the bottom ≥ 40px overshoot | PILL (chat → input → pill in one motion). |
| Tap scrim/outside | keyboard up → dismiss keyboard; else collapse to INPUT. |
| Escape | collapse to INPUT. |

### From FULL
Same as HALF, except: flick down steps to HALF (one detent per flick, never
skipping); drag up is pinned (rubber-band) and only the maximize over-pull
continues past it.

### From MAXIMIZED
| Gesture | Result |
| --- | --- |
| Pull down on the top restore strip | drops full-bleed on the first downward frame, then live-tracks: release at ≥ full−64 → FULL (inset); near half → HALF; gaps → FREE; at the bottom (≤ 64) → PILL (the drag started full-height — one big yank puts the chat away). |
| Tap the strip | stays MAXIMIZED. |
| Escape / navigate (Home/Settings) | animates out of full-bleed, collapses to INPUT, then navigates. |
| Upward pull | pinned (stays MAXIMIZED). |

### Non-gesture edges
| Trigger | Result |
| --- | --- |
| Composer focus (typing) | opens to HALF when a thread exists (guarded against boot auto-pop). |
| Send message | at least HALF. |
| Keyboard dismiss (tap grabber/scrim/outside) | returns to the pre-focus state: collapsed-before-focus → INPUT; open-before-focus → stays open at its detent. |
| Onboarding (`firstRunOpen`) | pinned MAXIMIZED and undismissable; falling edge settles to HALF. |
| Viewport rotation / pointer-cancel mid-drag | settles back to the current detent (never strands mid-morph). |

## 1:1 finger tracking (the sheet edge follows the cursor exactly)

While held, the panel's **top edge stays under the finger** with a constant
offset (the grabber bar floats a fixed ~13px above it) — no dead zones, no
accumulating lag — all the way UP to the screen top (maximize) and DOWN to the
pill. Two structural fixes make this hold at the extremes:

- **Reaching the top.** The pill→full→edge-to-edge morph budget in pixels
  exceeds the physical screen height, so a `raw`-height threshold for maximize is
  literally unreachable in one slow drag (it stalled ~200px short). Instead the
  maximize morph is driven by the panel's **measured** top edge: once an upward
  drag pins the panel at the inset-full ceiling (its top stops rising while the
  finger keeps pulling), each further pixel of finger travel collapses the top
  margin 1:1 (`fullBleedT` 0→1), raising the top pin→0 under the finger.
- **Collapsing without a dead zone.** At the FULL detent the thread's flex-basis
  exceeds what fits (it's flex-shrunk to the capped panel). A downward drag used
  to first drain that invisible slack (~chrome px) before the panel shrank. On
  gesture start the base is snapped to the thread's *real* rendered height (no
  visual change — the panel is already that tall), so a downward drag shrinks the
  sheet 1:1 from the first pixel.

Validated by `runFingerTrackingSuite` (chat-sheet e2e): it slow-drags the grabber
to the top and to the pill on a 420×880 viewport, sampling the panel top vs the
cursor each step, and asserts the divergence stays within a tight band of its own
median (the constant handle offset) — i.e. the edge tracks the finger 1:1 — plus
that the top is actually reached and the chat collapses to the bottom.

## Mid-drag commit (expand/collapse WHILE holding, not only on release)

The maximize and pill landings fire the **moment the finger crosses the
threshold**, not on release — dragging up to the top maximizes without letting
go, dragging down to the bottom collapses into the pill without letting go. The
state flips and the springs carry the sheet into it under the held finger; the
gesture stays alive and is **rebased** at the committed state so it can be
**reversed within the same drag** (with a small `MID_DRAG_RESUME_SLOP`
hysteresis so end-of-gesture jitter can't flap it).

| While holding | Fires when | Reverse (same held drag) |
| --- | --- | --- |
| **→ MAXIMIZED** | over-pull ≥ half the morph gap past FULL, or (started ≤ HALF) the pull sweeps ≥ 80% of the screen | pull back down past the slop → un-maximizes, then tracks the panel shrinking 1:1 (re-arms only below the inset FULL height) |
| **→ PILL** | an open-sheet drag carried ≥ 40px past the bottom, or a big yank that started above HALF running out the bottom; or the input→pill morph crosses halfway | pull back up past the slop → resumes the pill-open drag from zero |

The release then just settles where the mid-drag commit already landed the sheet.
The initiating handle (grabber or pill) is kept mounted and pointer-active for
the whole gesture (`draggingRef`) so the state flip never drops the pointer
capture that is driving it.

## Invariants

- The panel is ONE persistent element pill ↔ input ↔ chat ↔ full-bleed — no remounts; all morphs are transform/opacity/height (compositor-friendly).
- Commits happen mid-drag (see above); the finger never has to let go to trigger the expand/collapse, and any commit is reversible within the same held gesture.
- Only FULL may carry `maximized`; every other landing clears it.
- `openProgress` always settles to 0 (pill) or 1 (anything else) on release — never strands mid-morph.
- The pill ↔ input morph is a HARD scale lerp (`pillMorphScale`: 1 → `PILL_MORPH_MIN_SCALE` = 0.45, bottom-center origin) — collapsing to the pill visibly shrinks the whole chat into the capsule while the glass crossfades out.
- Detent changes fire exactly one haptic; sub-threshold releases fire none.
- The live drag is 1:1 with the pointer everywhere — down through the detents into the pill morph, and up from FULL through the maximize over-pull to the screen edge. Travel past the full-bleed ceiling is CONSUMED, not banked: pulling beyond the top of the canvas and back down moves the sheet with the first reversed pixel (no dead zone, no overshoot debt).
- The chat COLUMN (header/transcript/reply pill/attachments/composer) is pinned to `CHAT_COLUMN_MAX_WIDTH` — `min(48rem, calc(100vw − 24px))`, exactly its resting width — in EVERY state. Through the maximize morph and at full-bleed only the glass (wrapper width, insets, corners, height cap — all driven by `fullBleedT`) grows; the chat itself never spreads or reflows.
- The full-bleed swaps that used to fire discretely at commit (glass top extension under the status bar, header safe-area padding + height cap, composer home-gesture clearance) all EASE with `fullBleedT` — nothing pops the frame `maximized` flips.
- The handle never pulses while the mic is recording — the composer voice glyph carries the capture-hot cue; only the collapsed PILL (no composer visible) pulses for a live capture. A streaming reply still pulses the handle.
- Every collapse to INPUT/PILL blurs the composer (keyboard drops).
