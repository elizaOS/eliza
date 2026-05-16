# ROADMAP — from here to a real, fully-complete elizaOS Live

This is the honest road. `PLAN.md` is the phase map; the `docs/specs/`
are the turn-by-turn directions; **this doc is the realistic schedule,
the critical path, and what "done" actually means.**

No optimism inflation. Where something is risky or unknown, it says so.

---

## Where we are right now (2026-05-16)

**Done and proven:**
- The **containerized build pipeline** works. A full elizaOS ISO
  builds end-to-end in a container and boots as a CD-ROM ISO. No
  Vagrant, no host setup, any-OS, fast incremental rebuilds.
- **6 genuine Tails Trixie-compat bugs** found and fixed along the way.
- **Every implementation phase (2–9) has a source-level spec/backlog.**
- The **elizaOS desktop app builds** (the build sequence is
  fragile but verified and documented).
- Brand assets rendered; build infra clean-code reviewed; the Phase 6
  agent/runtime integration risks are documented.
- Local overlays now exist for elizaOS branding, Privacy Mode, elizaOS app
  install/autostart, a conservative elizaOS capability broker, and elizaOS
  Persistent Storage.
- The old root-level usbeliza prototype has been removed from this branch;
  the active Linux distro work now lives under this Tails-based variant.

**Not done:**
- The current full ISO build/test pass is still in progress. The latest
  artifact is not demo-approved until the rebuilt ISO passes QEMU greeter,
  desktop, app/service, persistence, and privacy checks.
- elizaOS app launch, CEF/sandbox behavior, privacy/direct networking, and
  Persistent Storage behavior still need proof inside the rebuilt live OS.
- The app/runtime can inherit elizaOS state/privacy/broker env, but there
  are not yet first-class approval-gated app actions for privileged
  package/network mutation.
- Phases 8–9 are still specs/backlog, not release-complete code.

So: the *build machine* is mostly complete. The *product* — elizaOS Live
— has the core overlays in place, but the next heavy gate is still a
fresh rebuild + boot + app + mode/persistence validation.

---

## The two milestones

### Milestone A — "Demo-able" (an elizaOS-branded OS that boots)

**Phases 1 + 2 plus app launch proof.** A USB-bootable ISO that says
elizaOS everywhere — boot menu, Plymouth splash, greeter, wallpaper,
`os-release` — and automatically starts the bundled elizaOS app as a
normal desktop window. Boots in QEMU and on real hardware. The local tree
also contains privacy/persistence/broker overlays, but this milestone only
claims demo readiness after the app stays running in the rebuilt image.

- Effort: Phase 1 finish (~hours, mostly build iteration) + Phase 2
  (~1–2 days — config-only, validated with `just binary` ~10 min/cycle).
- Risk: low. Phase 2 is additive branding; the build pipeline is proven.
- **This is the realistic near-term demo.**

### Milestone B — "v1.0 fully complete" (the real product)

**Phases 1–11.** elizaOS is the desktop. You boot the USB, land in the
elizaOS app, chat with Eliza, she builds apps, runs the local LLM or a
signed cloud/model provider, opens windows — in all 4 storage×privacy
combos, with encrypted persistence, validated on real hardware, released.

- Effort: **multi-week.** The honest breakdown is below.
- Risk: medium-high, concentrated in Phases 4 and 6 (see Risk section).

---

## Critical path (the order things must happen)

```
Phase 1 ──> Phase 2 ──┬──> Phase 3 ─────────────────┐
(build +    (rebrand) │    (privacy toggle)         │
 boot)                │                             ├──> Phase 8 ──> Phase 10 ──> Phase 11
                      ├──> Phase 4 ──> Phase 5 ──> Phase 6 ──> Phase 7 ──> Phase 9 ┘
                      │    (bake app)  (autolaunch) (wire     (persist)  (rice)
                      │                             agent)
                      └─ Phases 3, 4, 7 touch mostly disjoint files —
                         parallelizable once Phase 2 lands.
```

- **Phase 1 → 2** is strictly sequential — need a booting base first.
- **Phase 2 → 3** share the boot-menu files (GRUB/syslinux) — do them
  in sequence, not parallel.
- **Phase 4 → 5 → 6** is a hard chain — autolaunch needs the app present,
  agent-wiring needs autolaunch.
- **Phase 6 → 7** — persistence verification needs a working agent to
  prove `~/.eliza` survives.
- **Phase 8** (mode-parity) needs everything before it; it's the gate.
- **Phases 3, 4, 7** are the parallelizable cluster — disjoint file sets.
- **Phase 9** (rice actions) can slot in any time after Phase 6.

---

## Realistic effort

| Phase | What | Effort | Confidence |
|---|---|---|---|
| 1 | Base ISO builds + boots | hours (build iteration) | high — pipeline proven |
| 2 | Rebrand OS to elizaOS | 1–2 days | high — config only |
| 3 | Privacy-mode toggle | overlay present; validation still needed | medium — firewall ordering is subtle |
| 4 | Bake the elizaOS app | overlay/payload present; validation still needed | **low** — ~2.9 GB tree, ISO-size + chrome-sandbox unknowns |
| 5 | Auto-launch | overlay present; validation still needed | high — mostly config |
| 6 | Wire the agent | OS env/broker partial; shared-agent work still **1–2 weeks** | **low-medium** — real refactor, see audit |
| 7 | Persistence | overlay present; validation still needed | high — Tails-native, tiny footprint |
| 8 | Mode-parity harness + run | ~1 week | medium — tedious QEMU automation, no longer shared with the removed prototype |
| 9 | Customization actions | 1 week | medium — substrate exists |
| 10 | Bare-metal validation | 3–5 days | medium — hardware quirks |
| 11 | Release | 2–3 days | high |

**Honest total to Milestone B: ~6–9 weeks of focused work**, with Phases
4 and 6 being where it could blow out. Milestone A: **~2–3 days** once
Phase 1's build is confirmed booting.

---

## What "fully complete" actually means (the v1.0 definition of done)

elizaOS Live v1.0 is done when **all of this is true on real hardware**:

1. The ISO `dd`'s to a USB stick and boots on 2–3 real machines (Intel,
   AMD, NVIDIA).
2. Boot menu offers "elizaOS" and "elizaOS — Privacy Mode"; everything at
   the OS layer is elizaOS-branded; Tails is credited (greeter footer,
   About, CREDITS).
3. After the greeter, the elizaOS app launches as the desktop and the v36
   3-question onboarding runs in chat.
4. Eliza works: local LLM chat (GPU-accelerated), BUILD_APP (stub +
   Claude), OPEN_APP, SET_WALLPAPER, the customization actions.
5. Persistent mode: create encrypted storage via the greeter; chat
   history, built apps, models, Wi-Fi, API keys survive a reboot.
6. Amnesia mode: nothing persists, system leaves no trace on shutdown.
7. Privacy mode: traffic routes through Tor; Normal mode: direct.
8. **All 4 storage×privacy combos behave identically** except speed and
   trace footprint — proven by the Phase 8 harness, every gap documented.
9. The one known v1.0 gap (Chromium WebView Tor leak) is documented, not
   silent.
10. License audit done; CREDITS/NOTICE complete; release tagged.

Anything short of that isn't v1.0 — it's a milestone on the way.

---

## The risks that could actually blow the timeline

1. **ISO size (Phase 4).** The elizaOS app tree is ~2.9 GB uncompressed.
   On top of Tails the ISO could hit 3–4 GB. Mitigation work (slim build
   profile, aggressive squashfs) may be needed and isn't scoped yet.
2. **`chrome-sandbox` under AppArmor + squashfs (Phase 4).** The likely
   "boots but elizaOS won't render" failure. `--no-sandbox` is the
   fallback but weakens the renderer on a security-focused OS.
3. **App/agent OS integration is real product work, not verification.**
   The app boots from a live image only if Electron/CEF, embedded Bun,
   plugins, persistence paths, and model/provider defaults all agree with
   Tails' live-user environment. The demo has targeted workarounds for
   some of this; the release path needs cleaner package boundaries.
4. **elizaOS app build fragility.** The desktop build needs an exact
   `eliza`-first + `setup-upstreams.mjs` + `MILADY_ELIZA_SOURCE=local`
   sequence. If the milady repo's lockfile/dist-tag state drifts, the
   `just milady-app` recipe breaks. Worth fixing upstream.
5. **Latent Tails Trixie bugs.** Every build run so far surfaced one.
   The chroot-hooks and binary stages are now proven, but Phase 2+'s
   overlay changes could surface more.
6. **Tor blocking cloud APIs (Phase 8).** Anthropic/OpenAI refuse Tor
   exit IPs — in Privacy Mode, cloud features degrade to local-only.
   This is expected and documented, not a bug, but it shapes what
   "parity" means.

---

## Immediate next steps (in order)

1. **Finish the current low-CPU rebuild.** Do not call it done until the
   fresh ISO checksum is known and the artifact is booted.
2. **QEMU visual pass for Phase 2** — confirm elizaOS boot menu, Plymouth,
   greeter, wallpaper, system identity, and Tails credit.
3. **QEMU/runtime pass for Phase 3-7** — confirm direct/privacy networking,
   elizaOS launch/chrome-sandbox, always-on normal-window behavior,
   conservative broker status/root-status, and Persistent Storage.
4. **Run a guarded USB write on a sacrificial removable drive** — prove
   the real-device path without touching the laptop's internal disk.
5. Continue mode-parity, app-close/minimize UX, model onboarding, update
   infrastructure, release signing, and enterprise hardening.

## Product and Distribution Track

The demo ISO is not the whole product. Real distribution needs:

- **Signed releases:** versioned ISO, SHA256, detached signature, release
  notes, SBOM, license bundle, and a reproducible build target.
- **No-full-ISO updates where possible:** signed app/runtime updates can
  land in encrypted persistence; OS/base updates should use a Tails-style
  incremental update path or a full-image fallback.
- **Model delivery:** do not bake large/private models into every ISO by
  default. Onboarding should offer cloud sign-in, local-only mode, or a
  signed Eliza-1 download cached in persistent storage.
- **USB writer UX:** keep the guarded CLI script for developers, then add
  the same removable-disk checks to the desktop app so users can write a
  new elizaOS USB without Etcher.
- **Enterprise channel:** staged rollout rings, revocation, fleet policy,
  recovery image, hardware compatibility notes, and root-capability audit
  logs.

See [`docs/distribution-and-updates.md`](./docs/distribution-and-updates.md)
and [`docs/production-readiness.md`](./docs/production-readiness.md).
