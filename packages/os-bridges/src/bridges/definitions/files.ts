// spec/os/android/files/storage.md, "Story: Change files only as reviewed"; spec/os/android/files/storage.md, "Story: Get back exactly what I trashed"; spec/os/android/files/handoff.md, "Story: Open or share a file without granting write"; spec/os/android/files/storageWatch.md, "Story: Watch a folder with one live observer"
import type { PluginListenerHandle } from "@capacitor/core";

export type FilesCategory = "downloads" | "images" | "videos" | "audio" | "documents";

export type FilesAccess = "granted" | "denied" | "unsupported";

export type FilesStatus =
  | "ready"
  | "denied"
  | "unavailable"
  | "invalid"
  | "exists"
  | "missing"
  | "failed"
  | "changed"
  | "confirmation-required"
  | "superseded"
  | "unsupported";

export interface FilesResult {
  status: FilesStatus;
  message?: string;
  access?: FilesAccess;
  legacy?: boolean;
}

export interface StorageVolume {
  id: string;
  name: string;
  primary: boolean;
  free: number;
  total: number;
}

export interface StorageEntry {
  path: string;
  name: string;
  directory: boolean;
  mimeType: string;
  size: number;
  modified: number;
  children?: number;
}

export interface CategoryFolder {
  folder: string;
  count: number;
  latest: StorageEntry;
}

export interface TrashEntry {
  id: string;
  name: string;
  origin: string;
  directory: boolean;
  mimeType: string;
  size: number;
  deletedAt: number;
}

export type FileOutcomeStatus = "copied" | "moved" | "unchanged" | "trashed" | "restored" | "changed" | "missing" | "invalid" | "failed";

export interface FileOutcomeRow {
  path: string;
  status: FileOutcomeStatus;
  to?: string;
}

export interface FilesOpened {
  status: "opened";
  count: number;
}

export interface FilesSelected {
  status: "selected";
  action: "files";
  selectionId: string;
  name: string;
  mimeType: string;
  canRename: boolean;
  uri?: string;
}

export type FilesHandoff = FilesOpened | FilesResult;

export type FilesSelection = FilesSelected | FilesResult;

export interface OnVolume {
  volume?: string;
}

export interface ElizaFilesPlugin {
  storageState(): Promise<FilesResult & { volumes?: readonly StorageVolume[] }>;
  storageRequestAccess(input?: { settings?: boolean }): Promise<FilesResult>;
  storageList(input: OnVolume & { path: string }): Promise<FilesResult & { entries?: readonly StorageEntry[]; truncated?: boolean }>;
  storageCategory(input: { category: FilesCategory; countOnly?: boolean }): Promise<
    FilesResult & { entries?: readonly StorageEntry[]; count?: number; bytes?: number; truncated?: boolean; folders?: readonly CategoryFolder[] }
  >;
  storageQuery(input: {
    text?: string;
    mimePrefix?: string;
    documents?: boolean;
    folders?: boolean;
    folder?: string;
    from?: number;
    to?: number;
  }): Promise<FilesResult & { entries?: readonly StorageEntry[] }>;
  storageReviewedIdentities(input: OnVolume & { paths: readonly string[] }): Promise<FilesResult & { reviewed?: readonly string[] }>;
  storageTransfer(input: OnVolume & { paths: readonly string[]; dest: string; copy: boolean; reviewed?: readonly string[] }): Promise<
    FilesResult & { outcomes?: readonly FileOutcomeRow[] }
  >;
  storageRename(input: OnVolume & { path: string; name: string }): Promise<FilesResult & { path?: string }>;
  storageCreateFolder(input: OnVolume & { parent: string; name: string }): Promise<FilesResult & { path?: string }>;
  storageTrash(input: OnVolume & { paths: readonly string[]; reviewed?: readonly string[] }): Promise<FilesResult & { outcomes?: readonly FileOutcomeRow[] }>;
  storageTrashList(input?: OnVolume): Promise<FilesResult & { items?: readonly TrashEntry[] }>;
  storageRestore(input: OnVolume & { ids: readonly string[] }): Promise<FilesResult & { outcomes?: readonly FileOutcomeRow[] }>;
  storageEmptyTrash(input: OnVolume & { ids: readonly string[]; confirmed: boolean }): Promise<FilesResult & { count?: number }>;
  storageShare(input: OnVolume & { paths: readonly string[] }): Promise<FilesHandoff>;
  storageOpen(input: OnVolume & { path: string }): Promise<FilesHandoff>;
  storageSelect(input: OnVolume & { path: string }): Promise<FilesSelection>;
  storageWatch(input: OnVolume & { path?: string; category?: FilesCategory }): Promise<FilesResult>;
  storageUnwatch(): Promise<FilesResult>;
  addListener(eventName: "storageChanged", listener: () => void): Promise<PluginListenerHandle>;
}
