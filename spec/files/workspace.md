# Agent workspace files

The agent reads, writes and lists its own working files in one workspace
directory on the device, under the agent's state directory. These are the
agent's files, not the owner's shared storage, which [reviewed
operations](./reviewedOperations.md) change only as the owner reviewed.

## Story: Keep the agent's working files inside its workspace

> As the owner, I want the agent's own file reads and writes to stay inside
> its workspace, so that no path it is given can reach my other files.

### A workspace path is relative, has no parent segment or NUL, and names the root only where a folder is asked for

A path is admitted only when it is not absolute (no leading slash and no
drive letter), holds no `..` segment and no NUL character, and is not empty
or `.` unless the call lists a folder. Separators are unified and empty and
`.` segments dropped before it is used.

```quint
type WorkspacePath = { absolute: bool, parentSegment: bool, nul: bool, namesRoot: bool }
pure def pathAdmitted(p: WorkspacePath, folderCall: bool): bool =
  not(p.absolute) and not(p.parentSegment) and not(p.nul) and (folderCall or not(p.namesRoot))
pure val pValues = Set({ absolute: false, parentSegment: false, nul: false, namesRoot: false }, { absolute: true, parentSegment: false, nul: false, namesRoot: false },
  { absolute: false, parentSegment: true, nul: false, namesRoot: false }, { absolute: false, parentSegment: false, nul: true, namesRoot: false },
  { absolute: false, parentSegment: false, nul: false, namesRoot: true })
pure def lawAdmittedPathNeverClimbs(p: WorkspacePath, folderCall: bool): bool =
  pathAdmitted(p, folderCall) implies not(p.absolute) and not(p.parentSegment)
pure def lawOnlyAFolderCallNamesTheRoot(p: WorkspacePath): bool =
  p.namesRoot implies not(pathAdmitted(p, false))
```

### A call touches a file only when its real location is inside the workspace, and a write never follows a link

A read or a listing resolves links and is refused when the real location is
outside the workspace. A write creates each missing parent as an ordinary
folder, refuses a parent that is a link or not a folder, and opens the file
itself without following a link, so a path replaced by a link cannot
redirect it.

```quint
type Resolved = { realInside: bool, parentIsLink: bool, parentIsFile: bool, leafIsLink: bool }
type WorkspaceCall = WorkspaceRead | WorkspaceList | WorkspaceWrite
pure def touches(call: WorkspaceCall, r: Resolved): bool =
  r.realInside and (call != WorkspaceWrite or (not(r.parentIsLink) and not(r.parentIsFile) and not(r.leafIsLink)))
pure val rValues = Set({ realInside: true, parentIsLink: false, parentIsFile: false, leafIsLink: false }, { realInside: false, parentIsLink: false, parentIsFile: false, leafIsLink: false },
  { realInside: true, parentIsLink: true, parentIsFile: false, leafIsLink: false }, { realInside: true, parentIsLink: false, parentIsFile: true, leafIsLink: false },
  { realInside: true, parentIsLink: false, parentIsFile: false, leafIsLink: true })
pure def lawNothingOutsideIsTouched(call: WorkspaceCall, r: Resolved): bool = touches(call, r) implies r.realInside
pure def lawAWriteNeverFollowsALink(r: Resolved): bool =
  touches(WorkspaceWrite, r) implies not(r.parentIsLink) and not(r.leafIsLink)
```
