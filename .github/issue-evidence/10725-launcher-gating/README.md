# 10725 — Launcher cloud-gating rendered evidence (#11342)

Rendered proof for the #10725 headline AC: **the launcher shows cloud views
only when Eliza Cloud is active**. The gate lives in
`packages/ui/src/components/pages/launcher-curation.ts`
(`LAUNCHER_CLOUD_IDS` + `cloudActive`, unit-tested by
`launcher-curation.test.ts`, PR #10768); these artifacts show the REAL
launcher rendering the gate in both states.

All artifacts are produced by
`packages/app/test/ui-smoke/launcher-cloud-gating.spec.ts`, which also
hard-asserts the tile presence/absence (`launcher-tile-cloud-apps`), so the
screenshots are backed by a green regression test in the default e2e lane.

Repro (from repo root):

```bash
bun run --cwd packages/app test:e2e -- --project=chromium test/ui-smoke/launcher-cloud-gating.spec.ts
```

Harness notes: the `cloud-apps` view registration is platform-gated to
non-web shells (`packages/app/src/cloud-apps-view.ts`), so the spec injects
the same registry entry through the stub backend's `GET /api/views` — the
network half of the exact catalog merge the native registration flows
through. The cloud state is driven by the real `/api/cloud/status` poll
(stubbed connected/disconnected), i.e. the same signal a completed login
produces. The gate under test (`curateLauncherPages`) runs unmodified.

## Artifacts

| File | What it proves |
| --- | --- |
| `desktop-cloud-inactive-launcher.png` | 1280×800 launcher, cloud disconnected — `cloud-apps` ("Apps") tile ABSENT even though the view is in the catalog |
| `desktop-cloud-active-launcher.png` | 1280×800 launcher, cloud connected — "Apps" tile PRESENT (row 3, between Stream and Calendar) |
| `mobile-cloud-inactive-launcher.png` | 390×844 launcher, cloud disconnected — tile ABSENT |
| `mobile-cloud-active-launcher.png` | 390×844 launcher, cloud connected — tile PRESENT (row 4) |
| `cloud-setup-walkthrough.webm` | Video: launcher without tile → Settings → Cloud → Overview → Connect Cloud → "Cloud connected" → launcher WITH tile |
| `walkthrough-1-launcher-disconnected.png` | Walkthrough still: starting state, no tile |
| `walkthrough-2-settings-cloud-section.png` | Walkthrough still: Settings hub, Cloud group → Overview |
| `walkthrough-3-settings-cloud-connected.png` | Walkthrough still: Eliza Cloud section connected ("Cloud connected" button + success notice) |
| `walkthrough-4-launcher-connected.png` | Walkthrough still: launcher after connect, tile present |
