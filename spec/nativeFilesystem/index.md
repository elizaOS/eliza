# Native filesystem

The Files plugin owns the user-facing action, and [OS storage](../os/android/files/storage.md) owns Android provider custody. Native filesystem is the platform-backed device storage port for canonical file operations, with binary and Unicode round trips.

## Story: Work with device files inside the directory I granted

> As the owner, I want a device file operation scoped to the authorized root and truthful about missing files or a failed write.

### A native request stays within the selected root and its operation grant

The shell walks the selected root using the platform's confined interface, checks each traversal including links, and binds the resulting handle to the operation. It decodes missing and failure results independently. Binary payloads and encoded text stay in the adapter.

```quint
type FilesystemOperation = DeviceList | DeviceRead | DeviceWrite | DeviceMakeDirectory | DeviceDelete | DeviceMove
type DeviceRootFence = { openedRoot: bool, withinRoot: bool, noFollowTraversal: bool, readable: bool, writable: bool }
type FileEffect = FileApplied | FileMissing | FileUnavailable | FileDenied | FileUncertain
pure def mayUseDeviceFilesystem(fence: DeviceRootFence, op: FilesystemOperation): bool =
  fence.openedRoot and fence.withinRoot and fence.noFollowTraversal and
  (if (op == DeviceList or op == DeviceRead) fence.readable else fence.writable)
pure def deviceFileOutcome(fence: DeviceRootFence, op: FilesystemOperation, observed: FileEffect): FileEffect =
  if (mayUseDeviceFilesystem(fence, op)) observed else FileDenied
pure def lawEscapedPathCannotChangeDevice(fence: DeviceRootFence, op: FilesystemOperation, observed: FileEffect): bool =
  not(fence.withinRoot) implies deviceFileOutcome(fence, op, observed) == FileDenied
pure val fenceValues = Set(
  { openedRoot: true, withinRoot: true, noFollowTraversal: true, readable: true, writable: true },
  { openedRoot: true, withinRoot: true, noFollowTraversal: true, readable: true, writable: false },
  { openedRoot: true, withinRoot: false, noFollowTraversal: false, readable: true, writable: true })
```
