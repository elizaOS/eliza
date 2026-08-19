# Deletion candidates — no deletion performed

Snapshot date: 2026-08-19 UTC. Root filesystem: 905 GiB total, 850 GiB used, 9.3 GiB available (99% used).

## Strong candidates after owner approval

| Path | Apparent size | Recoverability |
| --- | ---: | --- |
| `/home/nubs/Documents/Codex/2026-08-14/eliza-voice-consolidated` | 3.7 GiB | Reviewable tracked work is on `nubs/trash/voice-consolidated-2026-08-18-do-not-merge`. Its 1.261 GB untracked bulk payload is byte-identical to the copy retained in `eliza-voice-implementation-2` and is covered by the SHA-256 manifest. |
| `/home/nubs/Documents/Codex/2026-08-14/eliza-voice-implementation` | 665 MiB | Reviewable source is on `nubs/trash/voice-provisional-barge-in-2026-08-19-do-not-merge`; the worktree is clean. |
| `/home/nubs/Documents/Codex/2026-08-17/eliza-embedding-streaming` | 1.3 GiB | Source is on `nubs/trash/embedding-streaming-2026-08-18-do-not-merge`; the worktree is clean. |
| Coding QA workspace | 1.2 MiB | Useful content is in `coding-qa-and-trajectory-evidence.tar.zst`. |

Deleting the first duplicate bulk checkout preserves one complete local copy in `eliza-voice-implementation-2` while freeing roughly 3.7 GiB.

## Regenerable cache candidates

| Path group | Apparent size |
| --- | ---: |
| `local-agent-state-final/xdg-cache` | 246 MiB |
| `local-agent-state/xdg-cache` | 80 MiB |
| Both runtime `home/.bun` directories | 50 MiB |

These are regenerable runtime/Bun caches. Verify the local coding runtime is stopped before removal.

## Retain for now

| Path | Reason |
| --- | --- |
| `/home/nubs/Documents/Codex/2026-08-14/eliza-voice-implementation-2` | Retains the only complete local copy of the 570 bulk files absent at the same paths on the audited `origin/develop` snapshot. Its reviewable source is remotely backed up. |
| Both runtime `.pgdata` directories (217 MiB total) | May contain local task/memory state and were intentionally excluded from the public archive because database contents can include sensitive application state. |
| `/home/nubs/Documents/ChatGPT/voice` | Project artifact repository with no remote; two untracked files remain local. |

## Required deletion method

Resolve and display every exact target immediately before deletion. Do not use broad roots, globs, `git clean`, `git reset`, or recursive deletion against a workspace parent. Prefer moving material to trash when practical.
