# Linux voice and coding archive — 2026-08-19

This directory is preservation evidence only. Nothing here is a merge candidate.

## Remote source backups

The `nubs/trash/*-do-not-merge` branches on `elizaOS/eliza` preserve the reviewable source changes. They were pushed without upstream tracking and no pull requests were created for them.

`trash-branches.tsv` records the exact remote SHA and pull-request count for all eight archive branches. `local-checkouts.tsv` records the post-archive state of every related local Git checkout found under the task directories.

## Duplicated bulk payload

`duplicated-bulk-files.sha256.tsv` records 850 files totaling 1,261,395,504 bytes. The complete SHA-256 manifest was generated independently from these two local checkouts and the results were byte-for-byte identical:

- `/home/nubs/Documents/Codex/2026-08-14/eliza-voice-implementation-2/work/eliza`
- `/home/nubs/Documents/Codex/2026-08-14/eliza-voice-consolidated`

Of the 850 files, 280 are byte-identical to the same paths at `origin/develop` commit `34f1bc597`; 570 files (799,735,548 bytes) are not present at those paths on that upstream snapshot. The large payload was intentionally not committed to the central Eliza repository because it includes benchmark datasets, PDFs, PCAPs, compiled binaries, CAD assets, and generated bundles.

## Coding QA evidence

`coding-qa-and-trajectory-evidence.tar.zst` contains the small disposable QA workspaces, benchmark reports, handoff outputs, trajectories, telemetry, notes, and workspace fixtures. It excludes runtime caches, Bun installations, home caches, and PostgreSQL state.

- SHA-256: `8dfd996b11bc47a15ad96e24385f8261bab0f753dda90354012f2b2609049d19`
- Members: 565
- Compressed size: approximately 760 KiB

Extract into a disposable directory only:

```bash
tar --zstd -xf coding-qa-and-trajectory-evidence.tar.zst -C /path/to/disposable-directory
```

## Safety

- Exact credential-shape scans returned zero matches before archival.
- No reset, clean, stash, merge, deployment, or production mutation was performed.
- Do not merge any trash branch wholesale. Review and cherry-pick individual commits only after fresh verification.

## Historical pull requests

`related-account-prs.tsv` is a title/branch-name filtered inventory of potentially related pull requests opened by the `NubsCarson` GitHub account since 2026-08-12. It is an accountability aid, not proof that a PR originated from a particular laptop checkout. Some listed PRs were already merged before this archive operation; the trash branches do not revert or supersede them.
