# CTS/VTS + benchmark commit duplication audit (2026-05-18)

## Background

Five CTS/VTS-and-benchmark workstream commits landed on `develop` twice: once
through `ws/pd-package` (where they had been committed by mistake) and again via
`ws/cts-vts-bench-extracted` (the correct cherry-pick path). Both merges are on
`develop`, so each subject appears twice in `git log develop --oneline`.

This note records the SHA pairs and confirms that the duplication is a no-op:
the second copy was auto-deduplicated by git's merge resolver (identical patch,
already-applied content), so no revert is needed.

## SHA pairs (verified identical via `git patch-id --stable`)

| Subject                                                   | SHA A (via ws/pd-package) | SHA B (via ws/cts-vts-bench-extracted) | patch-id                                   |
| --------------------------------------------------------- | ------------------------- | -------------------------------------- | ------------------------------------------ |
| Add Cuttlefish riscv64 bring-up recipe                    | `1cec229`                 | `3b2fcea`                              | `fa97e77cbd2de2b34b483dae1a321b7b1db14509` |
| Add CTS/VTS smoke plan and fail-closed wrapper scripts    | `9e97ec2`                 | `1945040`                              | `f0cd50bcf51d8193b5fce267eef57ffe8a1e12b5` |
| Add benchmark stdout parsers with unit tests              | `b72bdbf`                 | `0cce977`                              | `810475cfc6bc667cbfbd9ea450304be915379044` |
| Upgrade mobile_smoke TFLite generator to conv+relu+fc net | `e154598`                 | `f8b573f`                              | `54b87b61450c1c9e8dfe2f04c7db46beb66de22a` |
| Add benchmark claim ladder L0-L4                          | `ce2cfaf`                 | `6534468`                              | `6a32683658dcb478d07671ca99f29f24383411df` |

For every pair the `git patch-id --stable` hashes are byte-identical, meaning
the two commits introduce exactly the same diff. Because the first copy was
already applied to the tree by the time the second copy's merge ran, the merge
resolver folded the second copy in as a zero-effect change. The working tree on
`develop` carries each file exactly once.

## Aside: third CTS/VTS commit (`85de8d2`)

`git log` also shows a third commit with the subject "Add CTS/VTS smoke plan
and fail-closed wrapper scripts" at SHA `85de8d2`, which arrived on `develop`
via the earlier `ws/security-boot-work` merge. This is *not* a duplicate of the
pair above — it is a larger, earlier draft (191/88/76 lines vs. 149/64/56 lines)
that was superseded when the pair's smaller, canonical version was merged in
later. The surviving file content on `develop` matches the 149-line variant
from `9e97ec2`/`1945040`, so `85de8d2`'s extra lines are not present in the
tree. No action is needed; it is recorded here only so future archeology does
not mistake it for a third copy of the same change.

## Outcome

No revert was performed on `ws/dedupe-cts-vts`. The duplication is structural
(two merge paths) but content-neutral (identical patches, auto-deduplicated by
the merge resolver). This note is the only artifact of the dedup branch.
