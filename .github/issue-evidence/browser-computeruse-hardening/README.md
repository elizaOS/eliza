# Evidence — browser + computeruse Windows hardening

Branch: `feat/browser-computeruse-hardening`
Machine: Windows 11 Pro (local backend), nutjs native driver.

## Summary

Reviewed `@elizaos/plugin-browser` (browseruse) and `@elizaos/plugin-computeruse`,
their closed issues (#8911, #8912, #8887, #7394, #6766, #6767), and open PRs
(none touch these plugins). Hardened both for the Windows backend, expanded test
coverage, and verified real desktop control on this machine.

## Real-driver verification (this Windows machine)

`bun plugins/plugin-computeruse/winverify.mts` drove `ComputerUseService`
end-to-end through the **nutjs** driver:

```
[winverify] platform=win32
[winverify] selectedDriver=nutjs
[winverify] nutAvailable=true
[computeruse] Service started on win32 (1728x1052) approval=full_control
[1/6] screenshot success=true bytes=1722224  -> computeruse-screenshot-windows.png
[2/6] mouse_move success=true
[3/6] type success=true
[4/6] key_press(Escape) success=true
[5/6] list_windows success=true windows=2
[6/6] scroll success=true
RESULT: ALL OK
```

`computeruse-screenshot-windows.png` is a real 1728×1052 capture from this run.

## Bugs fixed (Windows)

1. **`getScreenSize()` reported a hard-coded 1920×1080 fallback** — the
   `[System.Windows.Forms.Screen]::PrimaryScreen.Bounds` PowerShell call was
   missing `Add-Type -AssemblyName System.Windows.Forms`, so it errored
   (`TypeNotFound`) and silently fell back. Fixed + value-validated; the service
   now reports the real primary screen (1728×1052 here).
2. **Screenshot GDI+ crash on degenerate regions** — `New-Object
   System.Drawing.Bitmap(w,h)` throws an opaque error for zero/negative/float
   sizes. Added `normalizeCaptureRegion()` (rounds to int, rejects non-positive
   / non-finite dimensions; preserves negative x/y for left/top monitors).
3. **Web browser `state` crashed on `about:blank`** — `dom.window.localStorage`
   throws `SecurityError` on opaque origins. `state` now degrades to empty maps;
   the explicit `storage` subaction returns a clear error instead.
4. **Security test asserted Unix path semantics on Windows** — `validateFilePath`
   is correct on Windows (real `C:/Windows`, `C:/Users/x/.ssh` paths ARE
   blocked); the test ran POSIX-only assertions a Windows host can't satisfy
   (`path.win32.resolve` rewrites `/etc/shadow`). Gated to platform + added 5
   Windows-specific security assertions.

## Test coverage added

- `plugin-computeruse/src/__tests__/windows-powershell-safety.test.ts` — static
  guard: every platform source using `[System.Windows.Forms.*]` must
  `Add-Type` the assembly (catches bug #1's class).
- `plugin-computeruse/src/__tests__/capture-region.test.ts` — region validation.
- `plugin-computeruse/src/__tests__/security-hardening.test.ts` — Windows
  system-dir / device-name / UNC / drive-root coverage.
- `plugin-browser/src/workspace/__tests__/browser-workspace-tab-lifecycle.test.ts`
  — tab list/new/switch/close + opaque-origin storage behavior.

## Suites (local Windows)

- `plugin-browser`: 83 passed (17 files).
- `plugin-computeruse`: 381 passed, 5 skipped (40 files) — Unix-only assertions skip on Windows.
- typecheck + build: clean for both plugins.

## Scenario verification (real agent runtime, deterministic LLM proxy)

`bun run --cwd packages/scenario-runner` over the two relevant scenarios on this
Windows machine (provider=deterministic-llm-proxy):

```
| id                                            | status |
| deterministic-browser-actions                 | passed |
| deterministic-computeruse-progress-approvals  | passed |
Totals: 2 passed, 0 failed, 0 skipped of 2
```

The browser scenario drove the BROWSER action end-to-end through the runtime —
`open / navigate / get / wait / type / click / screenshot / tab / close` via
`target=auto (workspace mode=web)` — i.e. the web-app backend path. The
computeruse scenario covered per-step progress streaming + the approval queue.

