# Git worktree sessions

Manages the per-conversation stack of entered git worktrees and their paired dynamic sandbox allow-roots.

## Story: Enter and exit git worktrees without losing the previous working directory

> As the owner, I want entering a git worktree to push its path as the active working directory and temporary sandbox root, and exiting to pop it in LIFO order and restore the prior directory cleanly.

### Entering and exiting a worktree keeps the directory stack and dynamic sandbox roots in lockstep

A conversation starts at its non-empty base working directory with an empty worktree stack. Entering a distinct non-empty worktree path pushes it onto both the worktree stack and dynamic sandbox roots. Exiting pops the most recent worktree and optionally records git cleanup.

```quint
type WorktreeSession = {
  baseCwd: str,
  stack: List[str],
  cleanedCount: int
}
pure val initial: WorktreeSession = {
  baseCwd: "/repo",
  stack: List(),
  cleanedCount: 0
}
pure def currentCwd(s: WorktreeSession): str =
  if (s.stack.length() == 0) s.baseCwd else s.stack.nthOr(s.stack.length() - 1, s.baseCwd)
pure def canEnterWorktree(s: WorktreeSession, wtPath: str): bool =
  wtPath != "" and wtPath != s.baseCwd and not(s.stack.includes(wtPath))
pure def enterWorktree(s: WorktreeSession, wtPath: str): WorktreeSession = {
  ...s,
  stack: s.stack.append(wtPath)
}
pure def canExitWorktree(s: WorktreeSession): bool =
  s.stack.length() > 0
pure def exitWorktree(s: WorktreeSession, cleanup: bool): WorktreeSession = {
  ...s,
  stack: s.stack.removeAt(s.stack.length() - 1),
  cleanedCount: if (cleanup) s.cleanedCount + 1 else s.cleanedCount
}
pure val wtPathValues = Set("/repo-wt-1", "/repo-wt-2", "/repo", "")
```

### Worktree stack invariants and reachability

The base working directory stays non-empty and never appears on the worktree stack, every stacked path is non-empty, exiting always shrinks the stack by one, and nested entry plus cleanup exit are reachable.

```quint
pure def alwaysWorktreeStackValid(s: WorktreeSession): bool =
  s.baseCwd != "" and
  s.cleanedCount >= 0 and
  not(s.stack.includes(s.baseCwd)) and
  not(s.stack.includes(""))
pure def stepExitShrinksStack(before: WorktreeSession, via: str, after: WorktreeSession): bool =
  via == "exitWorktree" implies after.stack.length() == before.stack.length() - 1
pure def sometimesNestedWorktree(s: WorktreeSession): bool = s.stack.length() >= 2
pure def sometimesCleanedAfterExit(s: WorktreeSession): bool = s.cleanedCount > 0 and s.stack.length() == 0
```
