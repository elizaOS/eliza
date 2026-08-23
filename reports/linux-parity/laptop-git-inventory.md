# Linux laptop Git work inventory

Captured: 2026-08-23 UTC

This is a read-only, no-fetch inventory of Git work visible from the current
Linux account. It was created to find local work that may be uncommitted,
unpushed, or otherwise not represented by a production branch. The scan did
not alter, clean, commit, fetch, push, or open a pull request in any repository.

## Snapshot

| Measure | Count |
| --- | ---: |
| Git markers discovered | 425 |
| Valid canonical repositories | 421 |
| Repositories needing attention | 178 |
| Repositories with dirty tracked or untracked work | 102 |
| Branches without an upstream | 136 |
| Branches ahead of their cached upstream | 14 |
| Branches behind their cached upstream | 25 |
| Repository inspection failures | 0 |

`Needs attention` is the union of dirty work, no configured upstream, and
cached ahead/behind state; the categories overlap and therefore should not be
summed. Multiple worktrees sharing one Git common directory were canonicalized
so the total is not inflated by every `.git` marker.

## Interpretation

- Dirty does not mean abandoned or safe to commit. Each of the 102 repositories
  may contain deliberate user or agent work and must be reviewed in its own
  context.
- No upstream does not necessarily mean unpushed. Detached worktrees, local
  integration branches, archival repositories, and intentionally local
  branches can all appear in that category.
- Ahead and behind counts use the refs already present locally. Because the
  audit intentionally performed no network fetch, those 14/25 counts may be
  stale and cannot prove current Git-host state.
- A draft pull request cannot be created for a local-only branch without first
  pushing it. Push and PR creation remain explicit approval-time actions.

## Coverage limits

The user-owned filesystem was broadly searched from the laptop account, but
two classes of paths were not fully enumerable: an `iqlabs` subtree that timed
out during traversal, and root-owned tails/chroot paths that this account
cannot read. Those are recorded gaps, not silent green results. No credential
search or privilege escalation was attempted.

## Safe follow-up

The next useful pass is a repository-by-repository triage of the 178 attention
items: record path, branch, last commit, exact dirty summary, upstream, and
cached divergence; classify each as active, archival, generated, or unknown;
then ask for approval only where a push, PR, cleanup, or destructive action is
actually warranted. Until then, the inventory is a preservation map—not an
authorization to bulk commit or publish unrelated work.
