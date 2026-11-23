// spec/os/android/media/catalog.md, "Story: Page my photos without repeats"; spec/os/android/media/catalog.md, "Story: Stop reads when my photo access changes"; spec/os/android/media/review.md, "Story: Change a photo only after I approve it"; spec/os/android/media/trash.md, "Story: Delete only the trash I confirmed"; spec/os/android/media/albums.md, "Story: Change an album only as listed"; spec/os/android/media/editCopy.md, "Story: Save an edited copy exactly once"; spec/os/android/files/documentGrants.md, "Story: Keep only the documents I selected"
import type { PluginListenerHandle } from "@capacitor/core";
import type { Brand } from "effect";

export type MediaId = string & Brand.Brand<"MediaId">;
export type MediaRevision = string & Brand.Brand<"MediaRevision">;
export type MediaCursor = string & Brand.Brand<"MediaCursor">;
export type TrashConfirmation = string & Brand.Brand<"TrashConfirmation">;
export type EditSessionId = string & Brand.Brand<"EditSessionId">;
export type EditOperationId = string & Brand.Brand<"EditOperationId">;
export type AlbumId = string & Brand.Brand<"AlbumId">;
export type AlbumRevision = string & Brand.Brand<"AlbumRevision">;
export type SelectionId = string & Brand.Brand<"SelectionId">;

export type MediaKind = "image" | "video";
export type KindAccess = "full" | "selected" | "owned" | "denied";
export type LibraryScopeKind = "full" | "partial" | "selected" | "owned" | "denied";
export type LibraryFilter = "all" | "favorites" | "trash";
export type FlagChange = "favorite" | "unfavorite" | "trash" | "restore";
export type LibraryChange = Exclude<FlagChange, "restore">;
export type RowStatus =
  | "favorited"
  | "unfavorited"
  | "trashed"
  | "restored"
  | "deleted"
  | "unchanged"
  | "stale"
  | "unverified"
  | "unsupported";

export interface LibraryAccess {
  readonly scope: LibraryScopeKind;
  readonly images: KindAccess;
  readonly videos: KindAccess;
}

export interface LibraryScope {
  readonly scope: LibraryScopeKind;
  readonly imageAccess: KindAccess;
  readonly videoAccess: KindAccess;
  readonly images: boolean;
  readonly videos: boolean;
  readonly canSelectMore: boolean;
  readonly canEditOthers: boolean;
  readonly locked: boolean;
  readonly version: string;
}

export interface MediaItem {
  readonly id: MediaId;
  readonly kind: MediaKind;
  readonly width: number;
  readonly height: number;
  readonly date: number;
  readonly size: number;
  readonly revision: MediaRevision;
  readonly duration?: number;
  readonly name?: string;
  readonly mutationRevision?: MediaRevision;
  readonly contentRevision?: string;
  readonly identity?: string;
  readonly favorite?: boolean;
  readonly owned?: boolean;
  readonly trashed?: boolean;
  readonly expiresAt?: number;
  readonly image?: string;
  readonly path?: string;
  readonly takenAt?: number;
  readonly dateTaken?: number;
  readonly bucket?: string;
  readonly folder?: string;
  readonly taken?: number;
}

export interface MediaPage {
  readonly items: readonly MediaItem[];
  readonly next: MediaCursor | null;
  readonly access?: LibraryAccess;
}

export interface LibraryPage extends LibraryScope {
  readonly items: readonly MediaItem[];
  readonly next: MediaCursor | null;
}

export type Validated =
  | { readonly id: MediaId; readonly status: "current" }
  | { readonly id: MediaId; readonly status: "changed"; readonly item: MediaItem }
  | { readonly id: MediaId; readonly status: "missing" };

export interface RowOutcome {
  readonly id: MediaId;
  readonly status: RowStatus;
  readonly item?: MediaItem;
}

export interface BatchReport {
  readonly status: "complete" | "partial";
  readonly outcomes: readonly RowOutcome[];
}

export interface ChangedItem extends MediaItem {
  readonly status: RowStatus;
}

export interface Reviewed {
  readonly id: MediaId;
  readonly revision: MediaRevision;
}

export type HandoffStatus = "opened" | "unavailable" | "failed";

export interface ShareOpened {
  readonly status: HandoffStatus;
  readonly message?: string;
}

export interface SharedMany {
  readonly status: "opened";
  readonly count: number;
}

export interface KeepOutcome {
  readonly status: "saved" | "failed";
  readonly id?: MediaId;
  readonly message?: string;
}

export interface Thumbnail {
  readonly id: MediaId;
  readonly image: string;
}

export interface LibrarySummary {
  readonly favorites: number;
  readonly videos: number;
  readonly camera?: number;
  readonly screenshots?: number;
  readonly trash: number;
  readonly canFavorite: boolean;
}

export interface PreparedTrash {
  readonly confirmation: TrashConfirmation;
  readonly count: number;
}

export interface TrashReceipt {
  readonly status: "deleted" | "partial";
  readonly deletedIds: readonly MediaId[];
  readonly skippedIds: readonly MediaId[];
  readonly failedIds: readonly MediaId[];
}

export type TrashSelection = { readonly items: readonly Reviewed[] } | { readonly all: true };

export interface OwnedAlbum {
  readonly id: AlbumId;
  readonly name: string;
  readonly revision: AlbumRevision;
  readonly count: number;
  readonly memberIds: readonly MediaId[];
}

export interface AlbumList {
  readonly items: readonly OwnedAlbum[];
}

export type AlbumChange =
  | { readonly operation: "create"; readonly name: string }
  | { readonly operation: "rename"; readonly id: AlbumId; readonly revision: AlbumRevision; readonly name: string }
  | { readonly operation: "delete"; readonly id: AlbumId; readonly revision: AlbumRevision }
  | { readonly operation: "add"; readonly id: AlbumId; readonly revision: AlbumRevision; readonly mediaId: MediaId; readonly mediaRevision: MediaRevision }
  | { readonly operation: "remove"; readonly id: AlbumId; readonly revision: AlbumRevision; readonly mediaId: MediaId };

export interface AlbumWritten {
  readonly status: "saved" | "deleted";
  readonly id: AlbumId;
  readonly revision: AlbumRevision;
}

export interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PhotoEdit {
  readonly sessionId: EditSessionId;
  readonly rotation: number;
  readonly filter: string;
  readonly crop?: boolean;
  readonly cropRect?: CropRect;
}

export interface EditPreview {
  readonly sessionId: EditSessionId;
  readonly operationId: EditOperationId;
  readonly image: string;
  readonly width: number;
  readonly height: number;
  readonly reduced: boolean;
  readonly maxEdge: number;
  readonly filter: string;
  readonly canReplace?: boolean;
}

export type EditStatus = "saved" | "failed" | "not-started" | "incomplete" | "stale" | "unchanged" | "unknown";

export interface EditReceipt {
  readonly status: EditStatus;
  readonly operationId: EditOperationId;
  readonly id?: MediaId;
  readonly replaced?: boolean;
  readonly revision?: MediaRevision;
  readonly message?: string;
}

export interface VideoEditSession {
  readonly sessionId: EditSessionId;
  readonly operationId: EditOperationId;
  readonly duration: number;
  readonly width: number;
  readonly height: number;
}

export interface VideoEdit {
  readonly sessionId: EditSessionId;
  readonly start: number;
  readonly end: number;
  readonly rotation: number;
  readonly crop: boolean;
}

export type DocumentStatus = "selected" | "renamed-reselect" | "unavailable" | "unsupported" | "failed";

export interface SelectedDocument {
  readonly status: DocumentStatus;
  readonly action?: "files";
  readonly message?: string;
  readonly selectionId?: SelectionId;
  readonly uri?: string;
  readonly name?: string;
  readonly mimeType?: string | null;
  readonly canRename?: boolean;
  readonly size?: number;
  readonly modified?: number;
}

export interface PdfPage {
  readonly status: "rendered" | "unavailable" | "unsupported" | "failed";
  readonly message: string;
  readonly page?: number;
  readonly pageCount?: number;
  readonly imageUri?: string;
}

export interface DocumentText {
  readonly status: "read" | "unavailable" | "unsupported" | "too-large" | "failed";
  readonly message: string;
  readonly text?: string;
  readonly mimeType?: string | null;
  readonly bytes?: number;
}

export interface DocumentHandoff {
  readonly status: HandoffStatus;
  readonly message: string;
}

export interface ListOptions {
  readonly before?: MediaCursor;
  readonly query?: string;
  readonly kind?: "all" | MediaKind;
  readonly thumbnails?: boolean;
}

export interface OwnedListOptions {
  readonly before?: MediaCursor;
  readonly trashed?: boolean;
  readonly album?: "favorites" | "videos" | "camera" | "screenshots" | `custom:${string}`;
  readonly limit?: number;
  readonly thumbnails?: boolean;
}

export interface LibraryPageOptions extends ListOptions {
  readonly limit?: number;
  readonly favorites?: boolean;
  readonly from?: number;
  readonly to?: number;
}

export interface PermittedPhotosPlugin {
  libraryAccess(): Promise<unknown>;
  watchLibrary(options: { active: boolean }): Promise<unknown>;
  openLibrarySettings(): Promise<void>;
  requestLibraryAccess(): Promise<unknown>;
  listPermitted(options: ListOptions & { filter?: LibraryFilter }): Promise<unknown>;
  readPermitted(options: { id: string; revision?: string; pixels?: boolean; edge?: number }): Promise<unknown>;
  share(options: { id: string; revision?: string }): Promise<unknown>;
  addListener(event: "libraryChanged", listener: () => void): Promise<PluginListenerHandle>;
}

export interface PhotosPlugin extends PermittedPhotosPlugin {
  beginEdit(options: { id: string; revision: string }): Promise<unknown>;
  previewEdit(options: PhotoEdit): Promise<unknown>;
  saveEdit(options: PhotoEdit & { replace?: boolean }): Promise<unknown>;
  editResult(options: { operationId: string }): Promise<unknown>;
  cancelEdit(options: { sessionId: string }): Promise<void>;
  beginVideoEdit(options: { id: string; revision: string }): Promise<unknown>;
  saveVideoEdit(options: VideoEdit): Promise<unknown>;
  cancelVideoEdit(options: { sessionId?: string }): Promise<void>;
  reviewRemovedVideoCopy(options: { operationId: string }): Promise<unknown>;
  list(options: OwnedListOptions): Promise<unknown>;
  thumbnails(options: { ids: readonly string[] }): Promise<unknown>;
  read(options: { id: string; revision?: string; includeTrashed?: boolean }): Promise<unknown>;
  keepCapture(options: { operationId: string; dataBase64: string }): Promise<unknown>;
  shareMany(options: { items: readonly Reviewed[] }): Promise<unknown>;
  setTrashed(options: { id: string; revision: string; trashed: boolean }): Promise<unknown>;
  setFavorite(options: { id: string; revision: string; favorite: boolean }): Promise<unknown>;
  deletePermittedTrash(options: { items: readonly Reviewed[] }): Promise<unknown>;
  changeMany(options: { operation: FlagChange; items: readonly Reviewed[] }): Promise<unknown>;
  summary(): Promise<unknown>;
  prepareDeleteTrash(options: TrashSelection): Promise<unknown>;
  cancelDeleteTrash(options: { confirmation: string }): Promise<void>;
  deletePreparedTrash(options: { confirmation: string }): Promise<unknown>;
  albums(): Promise<unknown>;
  changeAlbum(options: AlbumChange): Promise<unknown>;
}

export interface DeviceLibraryPlugin {
  scope(): Promise<unknown>;
  requestAccess(): Promise<unknown>;
  requestPermissions(): Promise<unknown>;
  watch(options: { active: boolean }): Promise<unknown>;
  page(options: LibraryPageOptions): Promise<unknown>;
  inspect(options: { id: string; pixels?: boolean }): Promise<unknown>;
  validate(options: { items: readonly Reviewed[] }): Promise<unknown>;
  changes(): Promise<unknown>;
  requestChange(options: { operation: LibraryChange; items: readonly Reviewed[] }): Promise<unknown>;
  share(options: { items: readonly Reviewed[] }): Promise<unknown>;
  addListener(event: "libraryChanged", listener: () => void): Promise<PluginListenerHandle>;
  addListener(event: "scopeChanged", listener: (scope: unknown) => void): Promise<PluginListenerHandle>;
}

export interface SelectedDocumentsPlugin {
  restoreSelected(): Promise<unknown>;
  describeSelected(options: { selectionId: string }): Promise<unknown>;
  renameSelected(options: { selectionId: string; name: string }): Promise<unknown>;
  pdfSelected(options: { selectionId: string; page: number }): Promise<unknown>;
  readSelected(options: { selectionId: string }): Promise<unknown>;
  openSelected(options: { selectionId: string }): Promise<unknown>;
  shareSelected(options: { selectionId: string }): Promise<unknown>;
  forgetSelected(options: { selectionId: string }): Promise<void>;
}

export interface PermittedPhotosClient {
  libraryAccess(): Promise<LibraryAccess>;
  watchLibrary(active: boolean): Promise<boolean>;
  openLibrarySettings(): Promise<void>;
  requestLibraryAccess(): Promise<LibraryAccess>;
  listPermitted(options?: ListOptions & { filter?: LibraryFilter }): Promise<MediaPage>;
  readPermitted(options: { id: MediaId; revision?: MediaRevision; pixels?: boolean; edge?: number }): Promise<MediaItem>;
  share(item: { id: MediaId; revision?: MediaRevision }): Promise<ShareOpened>;
  onLibraryChanged(listener: () => void): Promise<PluginListenerHandle>;
}

export interface PhotosClient extends PermittedPhotosClient {
  beginEdit(item: Reviewed): Promise<EditPreview>;
  previewEdit(edit: PhotoEdit): Promise<EditPreview>;
  saveEdit(edit: PhotoEdit & { replace?: boolean }): Promise<EditReceipt>;
  editResult(operationId: EditOperationId): Promise<EditReceipt>;
  cancelEdit(sessionId: EditSessionId): Promise<void>;
  beginVideoEdit(item: Reviewed): Promise<VideoEditSession>;
  saveVideoEdit(edit: VideoEdit): Promise<EditReceipt>;
  cancelVideoEdit(sessionId?: EditSessionId): Promise<void>;
  reviewRemovedVideoCopy(operationId: EditOperationId): Promise<EditReceipt>;
  list(options?: OwnedListOptions): Promise<MediaPage>;
  thumbnails(ids: readonly MediaId[]): Promise<readonly Thumbnail[]>;
  read(options: { id: MediaId; revision?: MediaRevision; includeTrashed?: boolean }): Promise<MediaItem>;
  keepCapture(options: { operationId: string; dataBase64: string }): Promise<KeepOutcome>;
  shareMany(items: readonly Reviewed[]): Promise<SharedMany>;
  setTrashed(item: Reviewed, trashed: boolean): Promise<ChangedItem>;
  setFavorite(item: Reviewed, favorite: boolean): Promise<ChangedItem>;
  deletePermittedTrash(items: readonly Reviewed[]): Promise<BatchReport>;
  changeMany(operation: FlagChange, items: readonly Reviewed[]): Promise<BatchReport>;
  summary(): Promise<LibrarySummary>;
  prepareDeleteTrash(selection: TrashSelection): Promise<PreparedTrash>;
  cancelDeleteTrash(confirmation: TrashConfirmation): Promise<void>;
  deletePreparedTrash(confirmation: TrashConfirmation): Promise<TrashReceipt>;
  albums(): Promise<readonly OwnedAlbum[]>;
  changeAlbum(change: AlbumChange): Promise<AlbumWritten>;
}

export interface DeviceLibraryClient {
  scope(): Promise<LibraryScope>;
  requestAccess(): Promise<LibraryScope>;
  watch(active: boolean): Promise<boolean>;
  page(options?: LibraryPageOptions): Promise<LibraryPage>;
  inspect(id: MediaId, pixels?: boolean): Promise<MediaItem>;
  validate(items: readonly Reviewed[]): Promise<readonly Validated[]>;
  changes(): Promise<{ readonly reset: true }>;
  requestChange(operation: LibraryChange, items: readonly Reviewed[]): Promise<BatchReport>;
  share(items: readonly Reviewed[]): Promise<SharedMany>;
  onLibraryChanged(listener: () => void): Promise<PluginListenerHandle>;
  onScopeChanged(listener: (scope: LibraryScope) => void): Promise<PluginListenerHandle>;
}

export interface SelectedDocumentsClient {
  restore(): Promise<SelectedDocument>;
  describe(selectionId: SelectionId): Promise<SelectedDocument>;
  rename(selectionId: SelectionId, name: string): Promise<SelectedDocument>;
  pdf(selectionId: SelectionId, page: number): Promise<PdfPage>;
  read(selectionId: SelectionId): Promise<DocumentText>;
  open(selectionId: SelectionId): Promise<DocumentHandoff>;
  share(selectionId: SelectionId): Promise<DocumentHandoff>;
  forget(selectionId: SelectionId): Promise<void>;
}
