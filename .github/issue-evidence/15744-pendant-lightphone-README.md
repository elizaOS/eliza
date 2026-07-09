# Issue #15744 Pendant/Light Phone Evidence Harness

Issue: https://github.com/elizaOS/eliza/issues/15744

## Acceptance goal

This harness proves the cross-device OS thesis, **one agent, every device**, on
reference hardware. It does not productize the pendant or Light Phone. The
primary prototype path is deliberately narrow and reviewable:

1. Speak through the physical pendant.
2. Capture the resulting transcript and insights.
3. Confirm the same agent and session expose that result on LP3 and desktop.

Run that end-to-end path first. Then exercise permission denial, Bluetooth
off/unavailable, disconnect/reconnect, ASR failure, and process/refresh recovery.
Physical artifacts remain the acceptance proof; supplemental emulation only
protects failure-state behavior between hardware runs.

This folder contains the committed templates for the LP3 qualification evidence
harness. Runtime captures are written to timestamped directories named:

- `.github/issue-evidence/15744-pendant-lightphone-<timestamp>/`
- `.github/issue-evidence/15744-pendant-lightphone-desktop-<timestamp>/`

LP3 session state is written under the host temp directory
(`os.tmpdir()/elizaos-issue-15744-pendant-sessions`) so active capture metadata
does not live in the committed evidence tree.

Commands:

```bash
bun run --cwd packages/app evidence:pendant:lp3 -- start --serial <adb-serial> --apk <path/to/app.apk>
bun run --cwd packages/app evidence:pendant:lp3 -- stop --serial <adb-serial>
bun run --cwd packages/app evidence:pendant:lp3 -- capture --serial <adb-serial> --apk <path/to/app.apk> --duration 90
bun run --cwd packages/app evidence:pendant:desktop -- capture --url <sol-dev-url> --output .github/issue-evidence/15744-pendant-lightphone-desktop-$(date -u +%Y%m%dT%H%M%SZ) --duration 0
bun run --cwd packages/ui test:pendant:supplemental
bun run --cwd packages/app evidence:pendant:report -- --output .github/issue-evidence/15744-pendant-lightphone-report.json
bun run --cwd packages/app evidence:pendant:validate -- --report .github/issue-evidence/15744-pendant-lightphone-report.json
```

Safety constraints enforced by the LP3 harness:

- `--serial` and `--apk` are mandatory for `start` and `capture`.
- Default install is `adb install -r`; data deletion requires explicit
  `--clean-install`, writes a warning artifact, and uninstalls only
  `ai.elizaos.app`.
- The harness does not call `fastboot`, EDL, `su`, `reboot`, `wipe`, `pm clear`,
  `pm grant`, or permission-dialog automation.
- Bluetooth/Nearby permission state is inspected through `dumpsys package` and
  `cmd appops get` only.
- `LIGHTOS_SHOW_EXTERNAL_TOOLS=1` is set with `adb shell setprop` and read back.
- `screenrecord` remote files are unique and removed only after a successful
  pull attempt into the artifact directory. The one-shot `capture` duration is
  limited to Android screenrecord's 180-second maximum. Host adb capture processes are
  detached, identified by session metadata, and only signaled when their command
  identity still matches the active session.

The desktop runner captures browser evidence only. Its
`manual-web-bluetooth-checkpoint.json` must remain `unverified` until a human
records physical Web Bluetooth chooser/pairing evidence with the real hardware.
`--output` is mandatory and must be a
`15744-pendant-lightphone-desktop-*` directory under `.github/issue-evidence`.
Use `--headed --duration <seconds>` to keep the browser open for manual Web
Bluetooth interaction before final screenshots and artifact discovery. If the
Playwright-managed Chromium build is unavailable, pass an explicit trusted
Chromium binary with `--executable <path>`.
Supplemental emulation tests are useful regression coverage, but they are not
physical proof.
