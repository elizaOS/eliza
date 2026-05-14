# User experience flows

Plain-language walkthrough of what users actually see and do. Mirrors
Tails' Welcome Screen pattern with Milady branding. **Same greeter window
every boot** — the only thing that changes is whether a persistence
partition has been created on the USB.

---

## The boot sequence (always the same)

1. **Boot menu** (~3 seconds) — isolinux/grub. Pick:
   - "**Milady**" (default) — direct internet, fast
   - "**Milady — Privacy Mode**" — Tor routing, slow but anonymous
2. **Plymouth splash** (~10 seconds) — Milady wordmark while the
   kernel + initramfs load.
3. **Milady greeter** — same GTK window every time.

---

## The greeter window

Always shows the same fields:

```
┌───── Welcome to Milady ──────────────────────────┐
│                                                  │
│  Language:       [ English  ▼ ]                  │
│  Keyboard:       [ US       ▼ ]                  │
│  Formats:        [ US       ▼ ]                  │
│                                                  │
│  Admin Password: [_______________] (optional)    │
│                                                  │
│  MAC Spoofing:   [ ● ON  ○ OFF ]                 │
│                                                  │
│  Persistent Storage:                             │
│    ← THIS ROW changes based on USB state         │
│                                                  │
│            [  Start Milady  ]                    │
│                                                  │
│            powered by Tails — about              │
└──────────────────────────────────────────────────┘
```

The **Persistent Storage row** is the only thing that shifts between
scenarios.

---

## Scenario A — Brand-new user (first boot, no encryption partition)

Persistent Storage row shows:
```
  Persistent Storage:    [ Create Persistent Storage ]
```

Steps:
1. User accepts defaults, clicks **Start Milady**.
2. GNOME desktop loads.
3. Milady auto-launches fullscreen.
4. Milady starts the v36 3-question chat onboarding:
   - "Hi. I'm Milady. What should I call you?"
   - "Want to sign into Claude?"
   - "Last question. What do you want me to build first?"
5. User chats with Milady, builds apps, etc. All in RAM.
6. Power off / unplug → **everything gone**. The USB itself is
   unmodified (live ISO is read-only on the stick).

Optionally during the session: user says "save my work to this USB" →
Milady triggers `tails-persistence-setup`:
- Prompts for an encryption passphrase
- Creates LUKS partition on the USB
- Asks which dirs to persist (`~/.eliza/`, Wi-Fi passwords, etc.)
- On reboot, the user is in Scenario B from now on.

**No password entered at boot. Amnesia mode is the default state for
new users.**

---

## Scenario B — Returning user (persistence exists, user wants continuity)

Persistent Storage row shows:
```
  Persistent Storage:    [_______________ passphrase] [ Unlock ]
```

Steps:
1. User types their passphrase, clicks **Unlock** → LUKS partition
   unlocks, gets bind-mounted to `~/.eliza/`, `~/.milady/`, etc.
2. User clicks **Start Milady**.
3. GNOME desktop loads.
4. Milady auto-launches fullscreen — **already configured from last
   time**. Chat history is there. Built apps are there. Downloaded
   models are there. Wi-Fi connects automatically.
5. User continues working where they left off.
6. Power off → encrypted partition seals automatically, USB now
   contains an encrypted blob.

**They typed their passphrase once at boot. Everything else is the
same as on their previous session.**

---

## Scenario C — Returning user, but wants amnesia for THIS boot

Same greeter, same persistence row with the passphrase field. The
user **just doesn't type it**.

Steps:
1. User clicks **Start Milady** without entering the passphrase.
2. GNOME loads.
3. Milady auto-launches. **Fresh state.** Onboarding runs from scratch.
   No chat history visible. No persisted apps.
4. User has an amnesia session for this boot.
5. Power off → encrypted partition was never unlocked, stays sealed.
   **Their data is still on the USB**, just untouched by this session.
6. Next boot they can unlock again if they want.

**This is the "give my laptop to a friend for an hour" pattern — they
get a clean session, the friend can't see your stuff, your stuff
survives.**

---

## Privacy Mode (orthogonal to storage mode)

Privacy Mode is picked at the **boot menu** (one step earlier than the
greeter), so it's independent of amnesia / persistent. All 4 combos
work:

```
                  Normal Mode (default)    Privacy Mode (Tor)
                  ─────────────────────    ──────────────────
   Amnesia        "burner with AI"        "burner + anonymity"
   Persistent     "portable AI laptop"    "portable + anonymity"
```

- **Normal Mode** — direct internet. Fast. Anthropic API, OpenAI,
  HuggingFace downloads all at full speed. Default.
- **Privacy Mode** — Tor routing. Same features, slow speeds. Cloud
  APIs may be blocked (providers often refuse Tor exits). Local LLM
  works identically.

The user can pick a different combination on every boot. No commitment.

---

## What survives reboot in each mode

| | Amnesia + Normal | Amnesia + Privacy | Persistent + Normal | Persistent + Privacy |
|---|---|---|---|---|
| Chat history | ✗ | ✗ | ✓ | ✓ |
| Built apps | ✗ | ✗ | ✓ | ✓ |
| Downloaded models | ✗ (re-download next boot) | ✗ (slow re-download via Tor) | ✓ | ✓ |
| Wifi passwords | ✗ | ✗ | ✓ | ✓ |
| API keys (Anthropic, OpenAI) | ✗ | ✗ | ✓ (in LUKS keyring) | ✓ (in LUKS keyring) |
| Onboarding answers | redo every boot | redo every boot | ask once | ask once |
| Wallpaper / theme / WM choice | reset to defaults | reset to defaults | persists | persists |

**Important**: a returning persistent user who chooses Amnesia for one
boot doesn't LOSE their persistent data — it's encrypted on the USB
and sealed. They just don't see it that session.

---

## What's identical across all four combos (no gaps)

| Feature | Status |
|---|---|
| Local LLM chat (Ollama / node-llama-cpp) | ✓ identical, no network needed |
| BUILD_APP via local stub | ✓ identical |
| BUILD_APP via Claude (signed-in) | ✓ identical (slower via Tor) |
| OPEN_APP (Chromium windowed apps) | ✓ identical |
| Voice (Whisper STT, Kokoro TTS) | ✓ identical, local |
| Wallpaper / SET_WM / theming | ✓ identical |
| GPU acceleration (NVIDIA / AMD / Intel) | ✓ identical |
| MAC spoofing | ✓ identical (Tails-default, can toggle in greeter) |
| Cloud APIs (Anthropic, OpenAI, etc.) | ✓ identical (slower in Privacy Mode) |

**The one v1.0 gap**: Chromium WebView windows may leak in Privacy
Mode (CEF doesn't auto-inherit SOCKS proxy). Milady's agent (Bun fetch)
respects Tor, but if Milady opens a `chromium --app=...` window for an
OAuth flow, that window may bypass Tor. This is a known security gap,
documented in `docs/privacy-mode-v1-gap.md`, fixed in v1.1.

---

## What happens on power-off / unplug

### Amnesia mode

- RAM contents physically lost on power-off.
- `memlockd` aggressively zeros RAM on shutdown (Tails default, kept).
- No swap partition mounted → no spillover of memory to disk.
- **System leaves no forensic trace.** Cold-boot RAM attacks are
  theoretically possible but practically rare.
- USB itself is unchanged — the ISO is read-only on the stick.

### Persistent mode

- LUKS partition seals automatically on power-off.
- RAM contents lost same as amnesia.
- USB physically contains an encrypted blob. Without the passphrase,
  contents are unreadable.
- **If user loses USB** → encrypted data is on the lost device. With
  a strong passphrase, attackers can't read it. **If user forgets
  passphrase** → data is lost permanently. There is no recovery key.

### Installed mode

**Not supported in v1.0.** See `PLAN.md § Deferred` for the rationale —
Tails refuses this by design, we're considering it carefully for v2.0
because the threat model implications matter.

---

## How users decide which mode at first boot

The greeter handles it all. Three flows:

1. **First-time users**: amnesia by default. No setup needed.
2. **"I want my work to stick"**: chat with Milady → say "save my
   work to encrypted USB" → Milady opens persistence wizard.
3. **"I just want privacy this once"**: at boot menu, pick "Milady —
   Privacy Mode". Independent of persistence.

The choice is **per-boot**. Users can mix and match every session.
Same USB, different decisions, different experiences.

---

## What we're NOT doing in v1.0

- Installing to internal disk (deferred — see PLAN.md § Deferred)
- Runtime privacy toggle without reboot (deferred — boot-menu pick
  is enough for v1.0)
- Closing the Chromium WebView proxy gap (deferred to v1.1)
- Cross-distro packaging (.deb / .AppImage / Flatpak — post-v2.0)

The v1.0 release is intentionally small: **a USB stick that boots into
either amnesia or persistent, with an optional Tor mode, and Milady as
the desktop home**. That's the whole product. Everything else is later.
