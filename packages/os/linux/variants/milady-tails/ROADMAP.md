# ROADMAP — from here to a real, fully-complete milady-tails

This is the honest road. `PLAN.md` is the phase map; the `docs/specs/`
are the turn-by-turn directions; **this doc is the realistic schedule,
the critical path, and what "done" actually means.**

No optimism inflation. Where something is risky or unknown, it says so.

---

## Where we are right now (2026-05-14)

**Done and proven:**
- The **containerized build pipeline** works. A full Tails-based ISO
  builds end-to-end in a container — ~1.9 GB, boots, isohybrid. No
  Vagrant, no host setup, any-OS, fast incremental rebuilds.
- **6 genuine Tails Trixie-compat bugs** found and fixed along the way.
- **Every implementation phase (2–9) is fully spec'd** at the file level.
- The **Milady Electrobun Linux app builds** (the build sequence is
  fragile but verified and documented).
- Brand assets rendered; build infra clean-code reviewed; the Phase 6
  agent-tree refactor fully mapped.

**Not done:**
- The ISO has been built but **not yet verified booting to the greeter**
  in QEMU (in progress).
- **Zero Milady-specific implementation** — no rebrand, no app baked in,
  no agent wired. Phases 2–9 are specs, not code.

So: the *build machine* is essentially complete. The *product* —
milady-tails itself — is at the starting line of Phase 2, with every
phase mapped.

---

## The two milestones

### Milestone A — "Demo-able" (a Milady-branded OS that boots)

**Phases 1 + 2.** A USB-bootable ISO that says Milady everywhere — boot
menu, Plymouth splash, greeter, wallpaper, `os-release`. Boots in QEMU
and on real hardware. **No Milady app yet** — this is "here's our OS, it
boots, it's branded."

- Effort: Phase 1 finish (~hours, mostly build iteration) + Phase 2
  (~1–2 days — config-only, validated with `just binary` ~10 min/cycle).
- Risk: low. Phase 2 is additive branding; the build pipeline is proven.
- **This is the realistic near-term demo.**

### Milestone B — "v1.0 fully complete" (the real product)

**Phases 1–11.** Milady is the desktop. You boot the USB, land in the
Milady app, chat with Eliza, she builds apps, runs the local LLM, opens
windows — in all 4 storage×privacy combos, with encrypted persistence,
validated on real hardware, released.

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
| 2 | Rebrand to Milady | 1–2 days | high — config only |
| 3 | Privacy-mode toggle | 3–5 days | medium — firewall ordering is subtle |
| 4 | Bake the Milady app | 3–6 days | **low** — ~2.9 GB tree, ISO-size + chrome-sandbox unknowns |
| 5 | Auto-launch | 1–2 days | high — mostly config |
| 6 | Wire the agent | **1–2 weeks** | **low-medium** — real refactor, see audit |
| 7 | Persistence | 3–5 days | high — Tails-native, tiny footprint |
| 8 | Mode-parity harness + run | ~1 week | medium — tedious, reuses usbeliza harnesses |
| 9 | Customization actions | 1 week | medium — substrate exists |
| 10 | Bare-metal validation | 3–5 days | medium — hardware quirks |
| 11 | Release | 2–3 days | high |

**Honest total to Milestone B: ~6–9 weeks of focused work**, with Phases
4 and 6 being where it could blow out. Milestone A: **~2–3 days** once
Phase 1's build is confirmed booting.

---

## What "fully complete" actually means (the v1.0 definition of done)

milady-tails v1.0 is done when **all of this is true on real hardware**:

1. The ISO `dd`'s to a USB stick and boots on 2–3 real machines (Intel,
   AMD, NVIDIA).
2. Boot menu offers "Milady" and "Milady — Privacy Mode"; everything is
   Milady-branded; Tails is credited (greeter footer, About, CREDITS).
3. After the greeter, the Milady app launches as the desktop and the v36
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

1. **ISO size (Phase 4).** The Milady app tree is ~2.9 GB uncompressed.
   On top of Tails the ISO could hit 3–4 GB. Mitigation work (slim build
   profile, aggressive squashfs) may be needed and isn't scoped yet.
2. **`chrome-sandbox` under AppArmor + squashfs (Phase 4).** The likely
   "boots but Milady won't render" failure. `--no-sandbox` is the
   fallback but weakens the renderer on a security-focused OS.
3. **Phase 6 is a real refactor, not verification.** PLAN.md's old "1
   week, mostly verification" estimate was wrong. The portability audit
   found 6 categories: ~11 sway files, a ~25-file env rename,
   `~/.eliza` path hardcoding, the persistence-script swap. It's
   tractable and mostly mechanical — but it's the longest pole.
4. **Milady build fragility.** The desktop build needs an exact
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

1. **Confirm Phase 1** — verify the built ISO boots to the Tails greeter
   in QEMU. (In progress.)
2. **Commit** the build infra + all these docs to the repo.
3. **Reconcile the vendored `tails/` tree** — decide its long-term git
   strategy (committed files vs submodule); apply the `gdisk`/`mtools`
   fix there (done); make `just build` the canonical entrypoint.
4. **Phase 2** — rebrand. Brand assets are ready; the spec is exact.
   This gets us to Milestone A — a demo-able branded ISO.
5. Then the Phase 3 / 4 / 7 parallelizable cluster, then 5 → 6, then 8,
   9, 10, 11.
