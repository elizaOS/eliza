# September 14, 2026 recovery archive

This branch preserves 520 distinct saved commit heads from 534 worktrees audited during the September 13 storage cleanup. RESTORE_MANIFEST.json maps original paths and branches to exact commits. This is a recovery archive, not an application integration branch.

To recover a version, fetch this branch, then create a new worktree and branch at its manifest head:

    git fetch origin codex/storage-rescue-20260914
    git worktree add -b codex/recovered-work /path/to/new-folder SAVED_COMMIT

Replace the path and commit and use an unused branch name. Do not merge the recovery branch into develop. Each saved history is retained as an ancestor. Uncommitted changes and older unreviewed local histories are not included.
