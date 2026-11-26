# Workspace coding tools

`@elizaos/plugin-coding-tools` provides Pi-shaped and umbrella workspace coding tools (`READ`, `WRITE`, `EDIT`, `FILE`, `SHELL`, `WORKTREE`, `WEB_FETCH`, `WEB_SEARCH`), sandbox confinement, file revision tracking, shell execution with confirmation challenges and background sessions, output artifact paging, and git worktree management.

| Area | Specification |
| --- | --- |
| File sessions and optimistic concurrency | [File sessions](./fileSession.md) |
| Shell execution, approvals, background jobs and artifacts | [Shell sessions](./shellSession.md) |
| Git worktree stack and dynamic sandbox roots | [Git worktrees](./worktree.md) |
| HTTPS-only public web fetch and search | [Public web guard](./webGuard.md) |

## Story: Read and edit my authorized project files

> As the owner, I can let an agent read and edit a project tree through scoped tools. A concurrent edit to a previously read file requires a new read before an existing edit can be applied.

### File actions use the canonical workspace and path identity supplied by the host

The boundary canonicalizes the root and target, handles links and platform path rules, and classifies the action before opening the file. A protected target is refused independently of its displayed path.

```quint
type WorkspaceFile = { workspaceKey: str, fileKey: str, revision: str, protectedPath: bool }
type WorkspaceAccess = { authorizedRoot: str, ownerConfirmed: bool, canWrite: bool, canRunCommands: bool }
pure def mayReadFile(access: WorkspaceAccess, file: WorkspaceFile): bool =
  access.authorizedRoot != "" and access.authorizedRoot == file.workspaceKey and file.fileKey != "" and not(file.protectedPath)
pure def mayEditFile(access: WorkspaceAccess, file: WorkspaceFile, expectedRevision: str): bool =
  mayReadFile(access, file) and access.canWrite and expectedRevision != "" and expectedRevision == file.revision
pure def lawStaleEditCannotWrite(access: WorkspaceAccess, file: WorkspaceFile, expectedRevision: str): bool =
  expectedRevision != file.revision implies not(mayEditFile(access, file, expectedRevision))
pure def lawProtectedFileCannotBeRead(access: WorkspaceAccess, file: WorkspaceFile): bool =
  file.protectedPath implies not(mayReadFile(access, file))
```

### A command uses the current authorized workspace and a bound approval when required

The shell executes the submitted command in the canonical directory under the host's isolation and process policy. The command's workspace is the authorized root that contains that directory; with no authorized root the command is refused. A command that needs approval runs only after the owner confirms it, and the approval covers that command digest alone. The result is redacted and structured.

```quint
type WorkspaceCommand = { inWorkspace: str, commandKey: str, needsApproval: bool }
pure def mayRunCommand(access: WorkspaceAccess, request: WorkspaceCommand, approvedKey: str): bool =
  access.canRunCommands and access.authorizedRoot != "" and access.authorizedRoot == request.inWorkspace and
  request.commandKey != "" and (not(request.needsApproval) or (access.ownerConfirmed and request.commandKey == approvedKey))
pure def lawDifferentCommandCannotUseApproval(access: WorkspaceAccess, request: WorkspaceCommand, approvedKey: str): bool =
  (request.needsApproval and request.commandKey != approvedKey) implies not(mayRunCommand(access, request, approvedKey))
pure val accessValues = Set({ authorizedRoot: "/work", ownerConfirmed: true, canWrite: true, canRunCommands: true }, { authorizedRoot: "/other", ownerConfirmed: false, canWrite: false, canRunCommands: false })
pure val fileValues = Set({ workspaceKey: "/work", fileKey: "/work/lib.ts", revision: "v1", protectedPath: false }, { workspaceKey: "/work", fileKey: "/work/.env", revision: "v2", protectedPath: true })
pure val requestValues = Set({ inWorkspace: "/work", commandKey: "reviewed", needsApproval: true }, { inWorkspace: "/other", commandKey: "unchanged", needsApproval: false })
```

## Story: Enforce sandbox confinement and bounded tool outputs

> As the owner, I want every filesystem path checked against the blocklist and workspace allow-roots before any read, search, or write, and every tool output bounded by line and byte limits with an artifact handle when spilled.

### Sandbox path policy blocks sensitive locations, pseudo-descriptors, and escapes outside configured roots

A path is admitted only when it is non-empty, contains no NUL byte, is not a UNC path, does not target or traverse a blocked path or pseudo-descriptor (`/dev/fd`, `/proc/*/fd`), and lies within a configured workspace root. With no workspace root configured, every path is refused. Every file action (read, write, edit, search, list, and the working directory of a command) is then checked against the authorized-root rules of the story above, so a protected file such as `.env`, `.git` or `.ssh` is refused whatever action names it.

```quint
type PathCheck = {
  isEmpty: bool,
  hasNul: bool,
  isUnc: bool,
  isBlocked: bool,
  traversesBlocked: bool,
  hasAllowRoots: bool,
  withinAllowedRoot: bool
}
pure def pathAllowed(p: PathCheck): bool =
  not(p.isEmpty) and not(p.hasNul) and not(p.isUnc) and
  not(p.isBlocked) and not(p.traversesBlocked) and
  p.hasAllowRoots and p.withinAllowedRoot
pure def lawBlockedOrOutsidePathNeverAllowed(p: PathCheck): bool =
  (p.isEmpty or p.hasNul or p.isUnc or p.isBlocked or p.traversesBlocked or not(p.hasAllowRoots) or not(p.withinAllowedRoot))
    implies not(pathAllowed(p))
pure val pValues = Set(
  { isEmpty: false, hasNul: false, isUnc: false, isBlocked: false, traversesBlocked: false, hasAllowRoots: true, withinAllowedRoot: true },
  { isEmpty: false, hasNul: false, isUnc: false, isBlocked: true, traversesBlocked: false, hasAllowRoots: true, withinAllowedRoot: true },
  { isEmpty: false, hasNul: false, isUnc: false, isBlocked: false, traversesBlocked: false, hasAllowRoots: true, withinAllowedRoot: false },
  { isEmpty: false, hasNul: false, isUnc: true, isBlocked: false, traversesBlocked: false, hasAllowRoots: false, withinAllowedRoot: false },
  { isEmpty: false, hasNul: true, isUnc: false, isBlocked: false, traversesBlocked: false, hasAllowRoots: false, withinAllowedRoot: false }
)
```

### Bounded output projection never exceeds line or byte ceilings and spills to an artifact when truncated

Every tool output projected into model context is capped to both its maximum line count and its maximum byte budget. Whenever the raw output exceeds either limit, the projection reports truncation and requests an immutable artifact spill handle.

```quint
type OutputProjection = {
  returnedLines: int,
  returnedBytes: int,
  truncated: bool,
  needsArtifactSpill: bool
}
pure def minInt(a: int, b: int): int = if (a <= b) a else b
pure def projectOutput(totalLines: int, totalBytes: int, maxLines: int, maxBytes: int): OutputProjection = {
  val safeTotalLines = if (totalLines < 0) 0 else totalLines
  val safeTotalBytes = if (totalBytes < 0) 0 else totalBytes
  val safeMaxLines = if (maxLines < 0) 0 else maxLines
  val safeMaxBytes = if (maxBytes < 0) 0 else maxBytes
  val trunc = safeTotalLines > safeMaxLines or safeTotalBytes > safeMaxBytes
  {
    returnedLines: minInt(safeTotalLines, safeMaxLines),
    returnedBytes: minInt(safeTotalBytes, safeMaxBytes),
    truncated: trunc,
    needsArtifactSpill: trunc
  }
}
pure def lawProjectionRespectsBounds(totalLines: int, totalBytes: int, maxLines: int, maxBytes: int): bool = {
  val proj = projectOutput(totalLines, totalBytes, maxLines, maxBytes)
  (maxLines >= 0 and maxBytes >= 0) implies (
    proj.returnedLines >= 0 and proj.returnedLines <= maxLines and
    proj.returnedBytes >= 0 and proj.returnedBytes <= maxBytes
  )
}
pure def lawSpillRequiredWhenTruncated(totalLines: int, totalBytes: int, maxLines: int, maxBytes: int): bool = {
  val proj = projectOutput(totalLines, totalBytes, maxLines, maxBytes)
  (maxLines >= 0 and maxBytes >= 0 and (totalLines > maxLines or totalBytes > maxBytes)) implies (
    proj.truncated and proj.needsArtifactSpill
  )
}
```
