# Workspace coding tools

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

The shell executes the submitted argv and the canonical directory under the host's isolation and process policy. It validates the scope of the owner approval and provides a redacted structured result.

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
