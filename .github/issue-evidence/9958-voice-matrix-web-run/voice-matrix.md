# Voice Live Matrix

Generated: 2026-06-29T21:45:23.454Z
Host: darwin arm64 (Shaws-MacBook-Pro.local)

| Cell | Status | Platform | Class | Probe / Result | Command |
|---|---:|---|---|---|---|
| `web.fake-mic.roundtrip` | pass | web | live-client-audio | command passed (2026-06-29T21:42:36.349Z) | `bun run --cwd packages/app test:e2e test/ui-smoke/voice-realaudio.spec.ts` |
| `web.fake-mic.transcript-roundtrip` | pass | web | transcripts-roundtrip-voice-control-bridge-parity | command passed (2026-06-29T21:45:06.082Z) | `bun run --cwd packages/app test:e2e test/ui-smoke/transcript-realaudio.spec.ts` |
| `web.workbench.respond-no-respond` | pass | web | chime-in-matrix | command passed (2026-06-29T21:45:23.454Z) | `bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-respond-no-respond.spec.ts` |

## Summary

- Pass: 3
- Fail: 0
- Pending: 0
- Skip: 0

Hardware-unavailable cells are explicit `skip` rows. They are not evidence of platform coverage.
