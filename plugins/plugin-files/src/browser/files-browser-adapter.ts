import {
  type FilesAgentOperation,
  type FilesAgentRunner,
  filesFilterOf,
} from "./files-agent-contract.ts";
import {
  baseName,
  breadcrumbs,
  CATEGORIES,
  type CategoryFolder,
  DOWNLOAD_FOLDER,
  type FilesCategory,
  type FilesFilter,
  filterLabel,
  filterMatches,
  formatFree,
  formatSize,
  groupByFolder,
  parentOf,
  SORT_LABELS,
  type SortMode,
  type StorageEntry,
  type StorageVolume,
  sortEntries,
  type TrashEntry,
  trashDaysLeft,
  validateFilesFilter,
} from "./storage-model.ts";

/** Files views over a host's storage port. The host owns storage authority and document grants. */
type ViewState = Record<string, unknown>;
type ViewApi = {
  set(update: ViewState): void;
  toast(text: string, options?: { undo: () => void }): void;
  isActive(): boolean;
  open?(view: string): void;
  ic?: Record<string, string>;
};
type ViewOutput = Record<string, unknown> & {
  isPreview?: boolean;
  pv?: Record<string, unknown>;
};
type FilesView = {
  render(state: ViewState, api: ViewApi): ViewOutput;
  back?(state: ViewState, api: ViewApi): unknown;
  onLeave?(...args: unknown[]): unknown;
  preset?(sub: string): unknown;
};
type Result = {
  status: string;
  message?: string;
  access?: string;
  legacy?: boolean;
};
type Outcome = { path: string; status: string; to?: string };
export type FilesStoragePort<Selection extends FilesSelection> = {
  storageState(): Promise<Result & { volumes?: StorageVolume[] }>;
  storageRequestAccess(): Promise<Result>;
  storageList(input: {
    path: string;
    volume?: string;
  }): Promise<Result & { entries?: StorageEntry[]; truncated?: boolean }>;
  /** `count` and `folders` cover the whole category; `entries` may be its newest part (`truncated`). */
  storageCategory(input: {
    category: FilesCategory;
    countOnly?: boolean;
  }): Promise<
    Result & {
      entries?: StorageEntry[];
      count?: number;
      truncated?: boolean;
      folders?: CategoryFolder[];
    }
  >;
  storageQuery(input: {
    text?: string;
    mimePrefix?: string;
    documents?: boolean;
    folders?: boolean;
    folder?: string;
    from?: number;
    to?: number;
  }): Promise<Result & { entries?: StorageEntry[] }>;
  storageReviewedIdentities?(input: {
    paths: string[];
    volume?: string;
  }): Promise<Result & { reviewed?: string[] }>;
  storageTransfer(input: {
    paths: string[];
    dest: string;
    copy: boolean;
    volume?: string;
    reviewed?: string[];
  }): Promise<Result & { outcomes?: Outcome[] }>;
  storageRename(input: {
    path: string;
    name: string;
    volume?: string;
  }): Promise<Result & { path?: string }>;
  storageCreateFolder(input: {
    parent: string;
    name: string;
    volume?: string;
  }): Promise<Result & { path?: string }>;
  storageTrash(input: {
    paths: string[];
    volume?: string;
    reviewed?: string[];
  }): Promise<Result & { outcomes?: Outcome[] }>;
  storageTrashList(input?: {
    volume?: string;
  }): Promise<Result & { items?: TrashEntry[] }>;
  storageRestore(input: {
    ids: string[];
    volume?: string;
  }): Promise<Result & { outcomes?: Outcome[] }>;
  storageEmptyTrash(input: {
    ids?: string[];
    confirmed: boolean;
    volume?: string;
  }): Promise<Result & { count?: number }>;
  storageShare(input: { paths: string[]; volume?: string }): Promise<Result>;
  storageSelect(input: { path: string; volume?: string }): Promise<Selection>;
  storageWatch(input: {
    path?: string;
    category?: string;
    volume?: string;
  }): Promise<Result>;
  storageUnwatch(): Promise<Result>;
  addListener(
    event: "storageChanged",
    listener: () => void,
  ): Promise<{ remove(): Promise<void> }>;
};
type FilesSelection = {
  status: string;
  selectionId?: string;
  message?: string;
};
type FilesBrowserHost<Selection extends FilesSelection> = {
  storage: FilesStoragePort<Selection>;
  createInlineModal(
    close: () => void,
    returnFocus: () => HTMLElement | null,
  ): { ref: (element: HTMLElement | null) => void };
  menuFocus(): HTMLElement | null;
  forgetSelected(selectionId: string): Promise<unknown>;
};

/** Icon keys in the shared IC table, so every glyph resolves to the published icon set. */
const ICON_KEYS = {
  downloads: "filesDown",
  images: "photo",
  videos: "video",
  audio: "wave",
  documents: "filesPdf",
  storage: "filesDisk",
  trash: "trash",
  file: "filesDoc",
  folder: "folder",
  copy: "copy",
  move: "filesMove",
  share: "share",
  sort: "filesSort",
  more: "more",
  check: "check",
  grid: "grid",
  rows: "filesRows",
} as const;
const shortDate = (time: number) => {
  if (!time) return "";
  const date = new Date(time),
    now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(
        undefined,
        date.getFullYear() === now.getFullYear()
          ? { month: "short", day: "numeric" }
          : { year: "numeric", month: "short", day: "numeric" },
      );
};
const countLabel = (n: number) => (n === 1 ? "1 item" : n + " items");

type Place =
  | { kind: "browse" }
  | { kind: "category"; category: FilesCategory }
  | { kind: "folder"; path: string; volume?: string }
  | { kind: "trash" };
/** Trash rows from every mounted volume; restore and delete go back to the row's volume. */
type TrashRow = TrashEntry & { volume?: string };
/** The storage* argument naming a non-primary volume (the primary needs none). */
const onVolume = (volume?: string) => (volume ? { volume } : {});
type Dialog =
  | {
      kind: "dest";
      op: "move" | "copy";
      paths: string[];
      at: string;
      folders: StorageEntry[];
      volume?: string;
    }
  | {
      kind: "name";
      op: "create" | "rename";
      path: string;
      value: string;
      volume?: string;
    }
  /** The rows the owner is shown and confirms; Empty deletes only these. */
  | { kind: "empty"; items: TrashRow[] }
  | { kind: "trashItem"; item: TrashRow; confirmDelete: boolean };
/** StorageBrowser.BATCH_MAX: ids per storageEmptyTrash call. */
const EMPTY_BATCH = 500;

/** Installs the Files browser over the files view. accept() opens a selected file in the
 * existing document preview; clearSelected() closes it. */
export function installFilesBrowserAdapter<Selection extends FilesSelection>(
  module: FilesView,
  accept: (
    module: string,
    result: Selection,
    api: ViewApi,
    recent?: false,
  ) => Promise<void>,
  clearSelected: () => void,
  {
    storage,
    createInlineModal,
    menuFocus,
    forgetSelected,
  }: FilesBrowserHost<Selection>,
): FilesAgentRunner {
  let ICONS = {} as Record<keyof typeof ICON_KEYS, string>;
  const iconFor = (entry: Pick<StorageEntry, "directory" | "mimeType">) =>
    entry.directory
      ? ICONS.folder
      : entry.mimeType.startsWith("image/")
        ? ICONS.images
        : entry.mimeType.startsWith("video/")
          ? ICONS.videos
          : entry.mimeType.startsWith("audio/")
            ? ICONS.audio
            : entry.mimeType === "application/pdf" ||
                entry.mimeType.startsWith("text/") ||
                entry.mimeType.includes("document") ||
                entry.mimeType.includes("sheet") ||
                entry.mimeType.includes("presentation") ||
                entry.mimeType.includes("msword")
              ? ICONS.documents
              : ICONS.file;
  const { render, back, onLeave: leave } = module;
  let api: ViewApi | undefined,
    place: Place = { kind: "browse" };
  let access = "unknown",
    legacy = false,
    volumes: StorageVolume[] = [],
    counts: Partial<Record<FilesCategory, number>> = {},
    trashCount = 0;
  let entries: StorageEntry[] = [],
    rootFolders: StorageEntry[] = [],
    categoryFolders: CategoryFolder[] | undefined,
    trashItems: TrashRow[] = [],
    loaded = false,
    busy = false,
    error = "";
  let selection: Set<string> | null = null,
    filter: FilesFilter | null = null,
    pendingFilter: FilesFilter | null = null,
    filterRows: StorageEntry[] = [];
  let dialog: Dialog | undefined,
    dialogTrigger: HTMLElement | null = null,
    opened: { path: string; volume?: string; selectionId?: string } | undefined;
  let selectionEpoch = 0;
  let generation = 0,
    stateGeneration = 0,
    filterGeneration = 0,
    revision = 0,
    watching = "",
    active = false,
    pressTimer: ReturnType<typeof setTimeout> | undefined,
    pressed = "";
  const repaint = () => api?.set({ filesBrowserRevision: ++revision });
  const modal = createInlineModal(
    () => {
      if (!busy) {
        dialog = undefined;
        repaint();
      }
    },
    () => (dialogTrigger?.isConnected ? dialogTrigger : menuFocus()),
  );
  const toast = (text: string) => {
    if (text) api?.toast(text);
  };
  const failed = (value: Result) => {
    if (value.status === "denied") {
      access = value.access || "denied";
      legacy = value.legacy === true;
      repaint();
      return true;
    }
    if (
      value.status !== "ready" &&
      value.status !== "opened" &&
      value.status !== "selected"
    ) {
      toast(value.message || "The operation could not be confirmed.");
      return true;
    }
    return false;
  };

  async function refreshState(
    current: () => boolean = () => true,
  ): Promise<boolean> {
    const ticket = ++stateGeneration;
    try {
      const state = await storage.storageState();
      if (ticket !== stateGeneration || !current()) return false;
      access = state.access || "denied";
      legacy = state.legacy === true;
      volumes = [...(state.volumes || [])].sort(
        (a, b) => Number(b.primary) - Number(a.primary),
      );
    } catch {
      if (ticket !== stateGeneration || !current()) return false;
      access = "unavailable";
      volumes = [];
    }
    return true;
  }
  const extraVolumes = () =>
    volumes.filter((volume) => !volume.primary).map((volume) => volume.id);
  /** Trash across the primary and every extra volume. A volume that cannot be read adds nothing. */
  async function trashAcross(): Promise<TrashRow[] | null> {
    const lists = await Promise.all(
      [undefined, ...extraVolumes()].map(async (volume) => {
        try {
          const value = await storage.storageTrashList(onVolume(volume));
          return value.status === "ready"
            ? (value.items || []).map((item) => ({
                ...item,
                ...onVolume(volume),
              }))
            : volume
              ? []
              : null;
        } catch {
          return volume ? [] : null;
        }
      }),
    );
    return lists[0] === null
      ? null
      : lists
          .flatMap((list) => list || [])
          .sort((a, b) => b.deletedAt - a.deletedAt);
  }
  const volumeLabel = (volume?: string) =>
    volume
      ? volumes.find((v) => v.id === volume)?.name || "Storage"
      : volumes.find((v) => v.primary)?.name || "Internal storage";
  const here = () => (place.kind === "folder" ? onVolume(place.volume) : {});
  async function loadCounts(ticket: number) {
    if (access !== "granted") return;
    const next: Partial<Record<FilesCategory, number>> = {};
    await Promise.all(
      CATEGORIES.map(async ({ id }) => {
        try {
          const value = await storage.storageCategory({
            category: id,
            countOnly: true,
          });
          if (value.status === "ready")
            next[id] = value.count ?? value.entries?.length ?? 0;
        } catch {
          /* Count stays blank. */
        }
      }),
    );
    let trash = 0;
    const rows = await trashAcross();
    if (rows) trash = rows.length;
    if (active && ticket === generation) {
      counts = next;
      trashCount = trash;
    }
  }
  /** Reload what is on screen (spec Refresh): the same place, rows that still exist, a selection
   * pruned to rows that are still listed (SelectionExists). */
  async function reload() {
    const ticket = ++generation,
      at = place;
    const current = () => active && ticket === generation;
    busy = true;
    repaint();
    try {
      if (!(await refreshState(current)) || !current()) return;
      if (access !== "granted") {
        entries = [];
        trashItems = [];
        loaded = true;
        return;
      }
      if (at.kind === "browse") {
        const [, root] = await Promise.all([
          loadCounts(ticket),
          storage.storageList({ path: "" }),
        ]);
        if (!current()) return;
        if (!failed(root))
          rootFolders = (root.entries || []).filter((entry) => entry.directory);
      } else if (at.kind === "trash") {
        const rows = await trashAcross();
        if (!current()) return;
        if (rows) trashItems = rows;
        else toast("Trash could not be read.");
      } else {
        const value =
          at.kind === "category"
            ? at.category === "downloads"
              ? await storage.storageList({ path: DOWNLOAD_FOLDER })
              : await storage.storageCategory({ category: at.category })
            : await storage.storageList({
                path: at.path,
                ...onVolume(at.volume),
              });
        if (!current()) return;
        if (value.status === "missing" && at.kind === "folder") {
          up();
          return;
        }
        if (!failed(value)) {
          entries = value.entries || [];
          categoryFolders =
            "folders" in value && Array.isArray(value.folders)
              ? value.folders
              : undefined;
          error = "";
        } else {
          entries = [];
          categoryFolders = undefined;
        }
      }
      if (!current()) return;
      if (filter && !pendingFilter) await runFilter(filter, current);
      if (!current()) return;
      if (selection) {
        const listed = new Set(entries.map((e) => e.path));
        selection = new Set([...selection].filter((path) => listed.has(path)));
      }
      loaded = true;
      void watch();
    } catch {
      if (current()) {
        error = "Files could not be read.";
        entries = [];
      }
    } finally {
      if (ticket === generation) {
        busy = false;
        repaint();
      }
    }
  }
  async function watch() {
    const key =
      place.kind === "folder"
        ? "p:" + (place.volume || "") + ":" + place.path
        : place.kind === "category"
          ? "c:" + place.category
          : "b";
    if (!active || key === watching) return;
    watching = key;
    try {
      await storage.storageWatch(
        place.kind === "folder"
          ? { path: place.path, ...onVolume(place.volume) }
          : place.kind === "category"
            ? { category: place.category }
            : {},
      );
    } catch {
      watching = "";
    }
  }
  let listening: Promise<{ remove(): Promise<void> }> | undefined,
    changeTimer: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    if (!active) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      if (active && !busy) void reload();
      else if (active) changed();
    }, 150);
  };
  const visibility = () => {
    if (active && !document.hidden) void reload();
  };
  function activate() {
    if (active) return;
    active = true;
    watching = "";
    listening ??= storage
      .addListener("storageChanged", changed)
      .catch(() => ({ remove: async () => {} }));
    document.addEventListener("visibilitychange", visibility);
    void reload();
  }
  function deactivate() {
    if (!active) return;
    active = false;
    watching = "";
    clearTimeout(changeTimer);
    document.removeEventListener("visibilitychange", visibility);
    void storage.storageUnwatch().catch(() => {});
  }

  /** Back from a folder walks up to where the folder was entered (Browse or a category). */
  let base: { from: Place; path: string; volume?: string } = {
    from: { kind: "browse" },
    path: "",
  };
  function show(next: Place) {
    selectionEpoch++;
    place = next;
    selection = null;
    dialog = undefined;
    entries = [];
    categoryFolders = undefined;
    loaded = false;
    error = "";
    api?.set({
      menu: false,
      folder: next.kind === "browse" ? null : "__files_browser",
    });
    void reload();
  }
  function go(next: Place) {
    if (busy && dialog) return;
    if (
      next.kind === "folder" &&
      (place.kind !== "folder" || place.volume !== next.volume)
    )
      base = { from: place, path: next.path, ...onVolume(next.volume) };
    show(next);
  }
  function up() {
    if (place.kind === "folder" && place.path && place.path !== base.path)
      show({
        kind: "folder",
        path: parentOf(place.path),
        ...onVolume(place.volume),
      });
    else show(place.kind === "folder" ? base.from : { kind: "browse" });
  }

  async function openFile(entry: StorageEntry) {
    if (busy || !api) return;
    const currentApi = api,
      ticket = selectionEpoch;
    const current = () => ticket === selectionEpoch && currentApi.isActive();
    busy = true;
    repaint();
    try {
      const volume = place.kind === "folder" ? place.volume : undefined;
      const value = await storage.storageSelect({
        path: entry.path,
        ...onVolume(volume),
      });
      if (!current()) {
        if (value.selectionId)
          await forgetSelected(value.selectionId).catch(() => {});
        return;
      }
      if (value.status !== "selected") {
        failed(value as Result);
        return;
      }
      opened = {
        path: entry.path,
        ...onVolume(volume),
        selectionId: value.selectionId,
      };
      await accept("files", value, currentApi, false);
    } catch {
      if (current()) toast("This file could not open.");
    } finally {
      busy = false;
      repaint();
    }
  }
  async function share(paths: string[], volume?: string) {
    if (busy || !paths.length) return;
    busy = true;
    repaint();
    try {
      const value = await storage.storageShare({ paths, ...onVolume(volume) });
      if (value.status !== "cancelled") failed(value);
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === "AbortError"))
        toast("Sharing could not open.");
    } finally {
      busy = false;
      repaint();
    }
  }
  const summarize = (outcomes: Outcome[], done: string, verb: string) => {
    const ok = outcomes.filter((o) => o.status === done).length,
      renamed = outcomes.filter(
        (o) => o.status === done && o.to && baseName(o.to) !== baseName(o.path),
      ).length;
    if (ok === outcomes.length)
      toast(
        `${verb} ${countLabel(ok)}` + (renamed ? ` · ${renamed} renamed` : ""),
      );
    else toast(`${verb} ${ok} of ${outcomes.length}`);
  };
  async function transfer(
    paths: string[],
    dest: string,
    copy: boolean,
    volume?: string,
  ) {
    busy = true;
    repaint();
    try {
      const value = await storage.storageTransfer({
        paths,
        dest,
        copy,
        ...onVolume(volume),
      });
      if (failed(value)) return false;
      summarize(
        value.outcomes || [],
        copy ? "copied" : "moved",
        copy ? "Copied" : "Moved",
      );
      if (
        !copy &&
        opened &&
        (value.outcomes || []).some(
          (o) => o.path === opened?.path && o.status === "moved",
        )
      )
        closePreview();
      return true;
    } catch {
      toast("The operation could not be confirmed.");
      return false;
    } finally {
      busy = false;
      selection = null;
      dialog = undefined;
      void reload();
    }
  }
  async function trash(paths: string[], volume?: string) {
    if (busy || !paths.length) return;
    busy = true;
    repaint();
    try {
      const value = await storage.storageTrash({ paths, ...onVolume(volume) });
      if (failed(value)) return;
      const outcomes = value.outcomes || [],
        ids = outcomes.flatMap((o) =>
          o.status === "trashed" && o.to ? [o.to] : [],
        );
      if (
        opened &&
        outcomes.some((o) => o.path === opened?.path && o.status === "trashed")
      )
        closePreview();
      if (ids.length)
        api?.toast(
          ids.length === outcomes.length
            ? `${countLabel(ids.length)} moved to Trash`
            : `${ids.length} of ${outcomes.length} moved to Trash`,
          { undo: () => void restore(ids, volume) },
        );
      else toast("Nothing was moved to Trash.");
    } catch {
      toast("The operation could not be confirmed.");
    } finally {
      busy = false;
      selection = null;
      void reload();
    }
  }
  async function restore(ids: string[], volume?: string) {
    busy = true;
    repaint();
    try {
      const value = await storage.storageRestore({ ids, ...onVolume(volume) });
      if (!failed(value))
        summarize(value.outcomes || [], "restored", "Restored");
    } catch {
      toast("The operation could not be confirmed.");
    } finally {
      busy = false;
      dialog = undefined;
      void reload();
    }
  }
  /** Permanent deletion of the rows the owner confirmed, on each row's volume. Items that reached
   * Trash after the confirmation was shown are not deleted. */
  async function emptyTrash(items: TrashRow[]) {
    busy = true;
    repaint();
    try {
      const byVolume = new Map<string | undefined, string[]>();
      for (const row of items)
        byVolume.set(row.volume, [...(byVolume.get(row.volume) ?? []), row.id]);
      empty: for (const [volume, ids] of byVolume)
        for (let at = 0; at < ids.length; at += EMPTY_BATCH)
          if (
            failed(
              await storage.storageEmptyTrash({
                ids: ids.slice(at, at + EMPTY_BATCH),
                confirmed: true,
                ...onVolume(volume),
              }),
            )
          )
            break empty;
    } catch {
      toast("The operation could not be confirmed.");
    } finally {
      busy = false;
      dialog = undefined;
      void reload();
    }
  }
  async function nameDialog() {
    const d = dialog;
    if (!d || d.kind !== "name" || busy) return;
    busy = true;
    repaint();
    try {
      if (
        d.op === "create" &&
        d.path === DOWNLOAD_FOLDER &&
        place.kind === "category" &&
        place.category === "downloads"
      ) {
        const parent = await storage.storageList({ path: DOWNLOAD_FOLDER });
        if (parent.status === "missing") {
          const created = await storage.storageCreateFolder({
            parent: "",
            name: DOWNLOAD_FOLDER,
          });
          if (created.status !== "exists" && failed(created)) return;
        } else if (failed(parent)) return;
      }
      const value =
        d.op === "create"
          ? await storage.storageCreateFolder({
              parent: d.path,
              name: d.value,
              ...onVolume(d.volume),
            })
          : await storage.storageRename({
              path: d.path,
              name: d.value,
              ...onVolume(d.volume),
            });
      if (value.status === "exists" || value.status === "invalid") {
        toast(value.message || "Choose another name.");
        return;
      }
      if (failed(value)) return;
      if (d.op === "rename" && opened?.path === d.path) closePreview();
      dialog = undefined;
    } catch {
      toast("The operation could not be confirmed.");
    } finally {
      busy = false;
      void reload();
    }
  }
  async function destination(at: string) {
    const d = dialog;
    if (!d || d.kind !== "dest") return;
    try {
      const value = await storage.storageList({
        path: at,
        ...onVolume(d.volume),
      });
      if (dialog !== d) return;
      if (failed(value)) return;
      dialog = {
        ...d,
        at,
        folders: sortEntries(
          (value.entries || []).filter((e) => e.directory),
          "name",
        ),
      };
    } catch {
      toast("This folder could not be read.");
    }
    repaint();
  }
  function beginDest(
    op: "move" | "copy",
    paths: string[],
    trigger?: EventTarget | null,
    volume?: string,
  ) {
    if (busy || !paths.length) return;
    dialogTrigger = trigger instanceof HTMLElement ? trigger : null;
    dialog = {
      kind: "dest",
      op,
      paths,
      at: "",
      folders: [],
      ...onVolume(volume),
    };
    api?.set({ menu: false });
    void destination("");
  }
  function closePreview() {
    clearSelected();
    opened = undefined;
    api?.set({ open: null });
  }

  /** Its own counter: a filter never takes a reload's ticket, so the reload still clears `busy`. */
  async function runFilter(
    value: FilesFilter,
    admitted: () => boolean,
  ): Promise<number | undefined> {
    const ticket = ++filterGeneration;
    const current = () =>
      ticket === filterGeneration && filter === value && admitted();
    try {
      const query = await storage.storageQuery({
        ...(value.text ? { text: value.text } : {}),
        ...(value.folder ? { folder: value.folder } : {}),
        ...(value.kind &&
        value.kind !== "folder" &&
        value.kind !== "document" &&
        value.kind !== "pdf"
          ? { mimePrefix: value.kind + "/" }
          : value.kind === "pdf"
            ? { mimePrefix: "application/pdf" }
            : {}),
        // Documents are queried as their set of types, folders by a walk (MediaStore has no folder rows).
        ...(value.kind === "document"
          ? { documents: true }
          : value.kind === "folder"
            ? { folders: true }
            : {}),
        ...(value.from ? { from: Date.parse(value.from) } : {}),
        ...(value.to
          ? {
              to:
                Date.parse(value.to) + (value.to.length === 10 ? 86399999 : 0),
            }
          : {}),
      });
      if (!current()) return;
      if (query.status === "ready") {
        filterRows = sortEntries(
          (query.entries || []).filter((entry) => filterMatches(value, entry)),
          "date",
        );
        return filterRows.length;
      }
      filterRows = [];
    } catch {
      if (current()) filterRows = [];
    }
  }
  const accessRequired = {
    status: "failed" as const,
    summary: "Files needs storage access. Nothing was changed.",
  };
  /** Own the read-only request independently of the reload that opens Files. */
  async function showFilter(
    value: FilesFilter,
    signal: AbortSignal,
  ): ReturnType<FilesAgentRunner["run"]> {
    const epoch = selectionEpoch;
    const current = () =>
      pendingFilter === value &&
      epoch === selectionEpoch &&
      !!api?.isActive() &&
      !signal.aborted;
    const unavailable = {
      status: "failed" as const,
      summary: "Files could not read this filter.",
    };
    pendingFilter = value;
    try {
      // The reload owns shared access and volume state. The filter only needs
      // its own read admission and must survive that reload's state ticket.
      const state = await storage.storageState().catch(() => undefined);
      signal.throwIfAborted();
      if (!current()) return unavailable;
      if (state?.access !== "granted") return accessRequired;
      filter = value;
      filterRows = [];
      place = { kind: "browse" };
      selection = null;
      dialog = undefined;
      api?.set({ folder: null, open: null, menu: false });
      const count = await runFilter(value, current);
      signal.throwIfAborted();
      if (!current() || count === undefined) return unavailable;
      return {
        status: "succeeded",
        summary: `Showing ${countLabel(count)} in Files.`,
      };
    } finally {
      if (pendingFilter === value) {
        const needsRepaint = current() && filter === value;
        pendingFilter = null;
        if (needsRepaint) repaint();
      }
    }
  }
  const reviewingPrimary = () =>
    api?.isActive?.() &&
    (typeof document === "undefined" || !document.hidden) &&
    !(place.kind === "folder" && place.volume && place.volume !== "primary");
  const runner: FilesAgentRunner = {
    async reviewedIdentities(paths, signal) {
      signal.throwIfAborted();
      if (!reviewingPrimary() || !storage.storageReviewedIdentities)
        throw Error("Open Files on primary storage to review these items");
      const result = await storage.storageReviewedIdentities({
        paths,
        volume: "primary",
      });
      signal.throwIfAborted();
      if (!reviewingPrimary() || result.status !== "ready" || !result.reviewed)
        throw Error("Files changed. Review them again.");
      return result.reviewed;
    },
    async run(op: FilesAgentOperation, signal) {
      signal.throwIfAborted();
      const reviewRequired = {
        status: "failed" as const,
        summary: "Review these files again. Nothing changed.",
      };
      if (
        (op.type === "files_move" || op.type === "files_trash") &&
        (!op.reviewed || !reviewingPrimary())
      )
        return reviewRequired;
      if (!api)
        return {
          status: "failed",
          summary: "Files is unavailable. Nothing was changed.",
        };
      if (!api.isActive?.()) api.open?.("files");
      if (op.type === "files_filter")
        return showFilter(validateFilesFilter(filesFilterOf(op)), signal);
      const refreshed = await refreshState(() => !signal.aborted);
      signal.throwIfAborted();
      if (!refreshed)
        return {
          status: "failed",
          summary: "Files changed. Nothing was changed.",
        };
      if (access !== "granted") return accessRequired;
      if (op.type === "files_open") {
        const currentApi = api,
          ticket = selectionEpoch;
        const value = await storage.storageSelect({ path: op.path });
        if (ticket !== selectionEpoch || !currentApi.isActive?.()) {
          if (value.selectionId)
            await forgetSelected(value.selectionId).catch(() => {});
          return {
            status: "failed",
            summary: "Files changed. Nothing was opened.",
          };
        }
        if (value.status !== "selected")
          return {
            status: "failed",
            summary: "That file is not there. Nothing was opened.",
          };
        opened = { path: op.path, selectionId: value.selectionId };
        await accept("files", value, currentApi, false);
        return { status: "succeeded", summary: "Opened the file in Files." };
      }
      if (op.type === "files_share") {
        const value = await storage.storageShare({ paths: op.paths });
        return value.status === "opened"
          ? {
              status: "succeeded",
              summary: "Opened the share sheet.",
            }
          : {
              status: "failed",
              summary: value.message || "Sharing could not open.",
            };
      }
      if (op.type === "files_folder_create") {
        const value = await storage.storageCreateFolder({
          parent: op.parent,
          name: op.name,
        });
        void reload();
        return value.status === "ready"
          ? {
              status: "succeeded",
              summary: "Created " + (value.path || op.name) + ".",
            }
          : {
              status: "failed",
              summary: value.message || "The folder was not created.",
            };
      }
      signal.throwIfAborted();
      if (!reviewingPrimary() || !op.reviewed) return reviewRequired;
      const selection = {
        paths: op.paths,
        reviewed: op.reviewed,
        volume: "primary",
      };
      const value =
        op.type === "files_move"
          ? await storage.storageTransfer({
              ...selection,
              dest: op.dest,
              copy: false,
            })
          : await storage.storageTrash(selection);
      void reload();
      if (value.status !== "ready")
        return {
          status: "failed",
          summary: value.message || "Nothing was changed.",
        };
      const done = (value.outcomes || []).filter(
        (o) => o.status === (op.type === "files_move" ? "moved" : "trashed"),
      ).length;
      // Files that are no longer where the owner reviewed them are left alone (AgentMoveOnlyReviewed).
      return {
        status: done ? "succeeded" : "failed",
        summary:
          op.type === "files_move"
            ? `Moved ${done} of ${op.paths.length}.`
            : `Moved ${done} of ${op.paths.length} to Trash.`,
      };
    },
  };

  const toggle = (path: string) => {
    if (!selection) return;
    selection.has(path) ? selection.delete(path) : selection.add(path);
    if (!selection.size) selection = null;
    repaint();
  };
  const press = (path: string) => ({
    down: () => {
      clearTimeout(pressTimer);
      pressed = "";
      pressTimer = setTimeout(() => {
        pressed = path;
        selection ??= new Set();
        selection.add(path);
        repaint();
      }, 500);
    },
    up: () => clearTimeout(pressTimer),
    cancel: () => clearTimeout(pressTimer),
    context: (event: Event) => {
      event.preventDefault();
      clearTimeout(pressTimer);
      if (pressed === path) return;
      pressed = path;
      selection ??= new Set();
      selection.add(path);
      repaint();
    },
  });
  const entryRow = (entry: StorageEntry, showFolder = false) => {
    const on = !!selection?.has(entry.path),
      p = press(entry.path);
    const meta = entry.directory
      ? entry.children !== undefined
        ? countLabel(entry.children)
        : ""
      : [
          formatSize(entry.size),
          shortDate(entry.modified),
          showFolder ? parentOf(entry.path) || "Internal storage" : "",
        ]
          .filter(Boolean)
          .join(" · ");
    return {
      id: JSON.stringify([
        place.kind === "folder" ? place.volume || "primary" : "primary",
        entry.path,
      ]),
      name: entry.name,
      sub: meta,
      d: iconFor(entry),
      isFolder: entry.directory,
      isFile: !entry.directory,
      selOn: !!selection && on,
      selOff: !!selection && !on,
      rowCss: on ? "background: var(--s2)" : "",
      label: selection
        ? (on ? "Deselect " : "Select ") + entry.name
        : "Open " + entry.name,
      down: p.down,
      up: p.up,
      cancel: p.cancel,
      context: p.context,
      tap: () => {
        if (pressed === entry.path) {
          pressed = "";
          return;
        }
        if (selection) {
          toggle(entry.path);
          return;
        }
        if (entry.directory)
          go({ kind: "folder", path: entry.path, ...here() });
        else void openFile(entry);
      },
    };
  };

  module.render = (state: ViewState, currentApi: ViewApi) => {
    api = currentApi;
    ICONS = Object.fromEntries(
      Object.entries(ICON_KEYS).map(([key, name]) => [
        key,
        currentApi.ic?.[name] ?? "",
      ]),
    ) as typeof ICONS;
    const out = render(state, currentApi);
    const visible = currentApi.isActive?.() !== false;
    if (visible && !active) {
      // Reload publishes its loading state. Start it after React finishes this render.
      queueMicrotask(() => {
        if (api === currentApi && currentApi.isActive?.() !== false) activate();
      });
    } else if (!visible) deactivate();
    const sort: SortMode =
      state.sort === "name" || state.sort === "size" ? state.sort : "date";
    const granted = access === "granted";
    // Browse (no search box and no Recents: the agent filters, decision F2).
    const primary = volumes.find((v) => v.primary) ?? volumes[0];
    const rootFolder: Extract<Place, { kind: "folder" }> = {
      kind: "folder",
      path: "",
    };
    const newFolder = () => {
      if (!granted || busy || !primary) return;
      const target =
        place.kind === "folder"
          ? place
          : place.kind === "category" && place.category === "downloads"
            ? { ...rootFolder, path: DOWNLOAD_FOLDER }
            : rootFolder;
      dialogTrigger = null;
      dialog = {
        kind: "name",
        op: "create",
        path: target.path,
        value: "",
        ...onVolume(target.volume),
      };
      currentApi.set({ menu: false });
    };
    out.toolbar = {
      ready: granted && !busy && !!primary && place.kind !== "trash",
      canCreate:
        place.kind === "browse" ||
        place.kind === "folder" ||
        (place.kind === "category" && place.category === "downloads"),
      newFolder,
      sort: () => {
        if (place.kind === "browse") go(rootFolder);
        currentApi.set({ menu: true });
      },
      toggleView: () => {
        if (place.kind === "browse") go(rootFolder);
        currentApi.set({ grid: !state.grid });
      },
      viewLabel: state.grid ? "List view" : "Grid view",
      viewIcon: state.grid ? ICONS.rows : ICONS.grid,
    };
    out.notSearching = true;
    out.searching = false;
    out.hasQuery = false;
    out.noQuery = true;
    out.results = [];
    out.recent = [];
    out.noRecent = false;
    out.locs = [];
    out.top = place.kind === "browse";
    out.browse = {
      ready: granted && !filter,
      denied: access === "denied",
      deniedLabel: legacy ? "Allow storage access" : "Allow all files access",
      unavailable: access === "unavailable" || access === "unsupported",
      grant: async () => {
        try {
          const value = await storage.storageRequestAccess();
          access = value.access || access;
        } catch {
          /* Read back below. */
        }
        void reload();
      },
      allFiles: () => go(rootFolder),
      allFilesIcon: ICONS.folder,
      folders: rootFolders.map((entry) => ({
        id: entry.path,
        name: entry.name,
        d: ICONS.folder,
        go: () => go({ kind: "folder", path: entry.path }),
      })),
      cats: CATEGORIES.map(({ id, label }) => ({
        id,
        name: label,
        d: ICONS[id],
        count: counts[id] === undefined ? "" : String(counts[id]),
        label,
        go: () => go({ kind: "category", category: id }),
      })),
      vols: volumes.map((volume) => ({
        id: volume.id,
        name: volume.name,
        free: formatFree(volume),
        barW:
          volume.total > 0
            ? Math.round((100 * (volume.total - volume.free)) / volume.total) +
              "%"
            : "0%",
        hasBar: volume.total > 0,
        d: ICONS.storage,
        label: volume.name,
        go: () =>
          go({
            kind: "folder",
            path: "",
            ...onVolume(volume.primary ? undefined : volume.id),
          }),
      })),
      trashCount: trashCount ? String(trashCount) : "",
      trashD: ICONS.trash,
      openTrash: () => go({ kind: "trash" }),
    };
    out.chip = filter
      ? {
          label: filterLabel(filter) + " · " + filterRows.length,
          clear: () => {
            filter = null;
            filterRows = [];
            repaint();
          },
        }
      : null;
    out.filterRows = filter
      ? filterRows.map((entry) => entryRow(entry, true))
      : [];
    out.filterEmpty = !!filter && !busy && filterRows.length === 0;
    out.storageBarStyle = "display:none";

    // Category, folder and trash share one detail page.
    out.inFolder = place.kind !== "browse";
    out.isSel = !!selection;
    out.notSel = !selection;
    out.isList = !state.grid;
    out.isGrid = !!state.grid;
    out.nativeTreeStatus = error;
    if (place.kind !== "browse") {
      const at = place;
      const volumeName =
        at.kind === "folder" && at.volume
          ? volumes.find((v) => v.id === at.volume)?.name || "Storage"
          : primary?.name || "Internal storage";
      const title =
        at.kind === "trash"
          ? "Trash"
          : at.kind === "category"
            ? (CATEGORIES.find((c) => c.id === at.category)?.label ??
              at.category)
            : at.path
              ? baseName(at.path)
              : at.volume
                ? volumeName
                : "All files";
      let items: Record<string, unknown>[] = [];
      if (at.kind === "trash") {
        items = trashItems.map((item) => ({
          id: item.id,
          name: item.name,
          sub: [
            item.directory ? "" : formatSize(item.size),
            [
              volumeLabel(item.volume),
              ...(item.origin || "").split("/").filter(Boolean),
            ].join(" › "),
          ]
            .filter(Boolean)
            .join(" · "),
          count: trashDaysLeft(item.deletedAt, Date.now()) + "d",
          d: iconFor(item),
          isFolder: false,
          isFile: true,
          selOn: false,
          selOff: false,
          rowCss: "",
          label: item.name,
          down: () => {},
          up: () => {},
          cancel: () => {},
          context: () => {},
          tap: (event: Event) => {
            if (busy) return;
            dialogTrigger =
              event?.currentTarget instanceof HTMLElement
                ? event.currentTarget
                : null;
            dialog = { kind: "trashItem", item, confirmDelete: false };
            repaint();
          },
        }));
      } else if (
        at.kind === "category" &&
        (at.category === "images" || at.category === "videos")
      ) {
        items = groupByFolder(entries, categoryFolders).map((group) => ({
          id: group.folder,
          name: group.name,
          sub: group.folder || "Internal storage",
          count: String(group.count),
          d: iconFor(group.latest),
          isFolder: true,
          isFile: false,
          selOn: false,
          selOff: false,
          rowCss: "",
          label: "Open " + group.name,
          down: () => {},
          up: () => {},
          cancel: () => {},
          context: () => {},
          tap: () => go({ kind: "folder", path: group.folder }),
        }));
      } else
        items = sortEntries(entries, sort, state.sortReverse === true).map(
          (entry) =>
            entryRow(
              entry,
              at.kind === "category" && at.category !== "downloads",
            ),
        );
      const listed =
        at.kind === "folder" ||
        (at.kind === "category" && !["images", "videos"].includes(at.category));
      const paths = () => [...(selection || [])];
      out.fd = {
        name: title,
        items,
        empty: loaded && !busy && items.length === 0 && !error,
        emptyD:
          at.kind === "trash"
            ? ICONS.trash
            : at.kind === "category"
              ? ICONS[at.category]
              : ICONS.folder,
        close: () => up(),
        crumbs:
          at.kind === "folder"
            ? breadcrumbs(at.path, volumeName).map((crumb, index, all) => ({
                id: JSON.stringify([at.volume || "primary", crumb.path]),
                label: crumb.label,
                last: index === all.length - 1,
                notLast: index < all.length - 1,
                go: () => {
                  if (crumb.path !== at.path)
                    go({
                      kind: "folder",
                      path: crumb.path,
                      ...onVolume(at.volume),
                    });
                },
              }))
            : [],
        hasCrumbs: at.kind === "folder",
        isTrash: at.kind === "trash",
        canEmpty: at.kind === "trash" && trashItems.length > 0 && !busy,
        empty_: () => {
          if (busy || !trashItems.length) return;
          dialog = { kind: "empty", items: [...trashItems] };
          repaint();
        },
        hasMenu: at.kind !== "trash",
        openMenu: () => currentApi.set({ menu: true }),
        moreD: ICONS.more,
        menuRows: [
          ...(["name", "date", "size"] as SortMode[]).map((mode) => ({
            id: "sort:" + mode,
            label:
              SORT_LABELS[mode] +
              (sort === mode
                ? " · " +
                  (mode === "name"
                    ? state.sortReverse
                      ? "Z–A"
                      : "A–Z"
                    : mode === "date"
                      ? state.sortReverse
                        ? "Oldest first"
                        : "Newest first"
                      : state.sortReverse
                        ? "Smallest first"
                        : "Largest first")
                : ""),
            d: ICONS.sort,
            on: sort === mode,
            go: () =>
              currentApi.set({
                menu: false,
                sort: mode,
                sortReverse: sort === mode ? !state.sortReverse : false,
              }),
          })),
          {
            id: "reverse-order",
            label: "Reverse order",
            d: ICONS.sort,
            on: state.sortReverse === true,
            go: () =>
              currentApi.set({ menu: false, sortReverse: !state.sortReverse }),
          },
          ...(listed && items.length
            ? [
                {
                  id: "select",
                  label: "Select",
                  d: ICONS.check,
                  on: false,
                  go: () => {
                    selection = new Set();
                    currentApi.set({ menu: false });
                  },
                },
              ]
            : []),
        ],
      };
      out.selCount = selection ? `${selection.size} selected` : "";
      out.selectionBusy = busy;
      out.selectionDisabled = busy || !selection?.size;
      out.selOp = selection?.size ? "1" : ".4";
      out.exitSel = () => {
        if (!busy) {
          selection = null;
          repaint();
        }
      };
      out.selAll = () => {
        if (busy) return;
        const all = entries.map((e) => e.path);
        selection = new Set(selection?.size === all.length ? [] : all);
        repaint();
      };
      const volumeHere = at.kind === "folder" ? at.volume : undefined;
      out.selShare = () =>
        void share(
          paths().filter(
            (path) => !entries.find((e) => e.path === path)?.directory,
          ),
          volumeHere,
        );
      out.selMove = (event: Event) =>
        beginDest("move", paths(), event?.currentTarget, volumeHere);
      out.selCopy = (event: Event) =>
        beginDest("copy", paths(), event?.currentTarget, volumeHere);
      out.selDel = () => void trash(paths(), volumeHere);
      out.selRename = (event: Event) => {
        const only = paths();
        if (only.length !== 1 || busy) return;
        dialogTrigger =
          event?.currentTarget instanceof HTMLElement
            ? event.currentTarget
            : null;
        dialog = {
          kind: "name",
          op: "rename",
          path: only[0],
          ...onVolume(volumeHere),
          value: baseName(only[0]),
        };
        repaint();
      };
      out.canRename = selection?.size === 1;
      out.icons = ICONS;
      out.menuOpen = !!state.menu;
      out.closeMenu = () => currentApi.set({ menu: false });
    } else {
      out.fd = null;
      out.menuOpen = false;
    }

    // The document preview opened from this browser acts on the same path.
    if (
      opened &&
      out.isPreview &&
      out.pv &&
      state.open === "__native_selected_document"
    ) {
      const path = opened.path;
      const volume = opened.volume;
      out.pv.share = () => void share([path], volume);
      out.pv.move = (event: Event) =>
        beginDest("move", [path], event?.currentTarget, volume);
      out.pv.del = () => void trash([path], volume);
      out.pv.startRename = (event: Event) => {
        dialogTrigger =
          event?.currentTarget instanceof HTMLElement
            ? event.currentTarget
            : null;
        dialog = {
          kind: "name",
          op: "rename",
          path,
          value: baseName(path),
          ...onVolume(volume),
        };
        repaint();
      };
      out.pv.canForget = false;
      out.pv.meta = [
        out.pv.meta,
        [
          volumeLabel(volume),
          ...parentOf(path).split("/").filter(Boolean),
        ].join(" › "),
      ]
        .filter(Boolean)
        .join(" · ");
    } else if (!out.isPreview) opened = undefined;

    const d = dialog;
    out.nativeTreeDialog = null;
    out.dlg = d
      ? {
          modalRef: modal.ref,
          busy,
          isDest: d.kind === "dest",
          isName: d.kind === "name",
          isEmpty: d.kind === "empty",
          isTrashItem: d.kind === "trashItem",
          title:
            d.kind === "dest"
              ? d.op === "move"
                ? "Move to"
                : "Copy to"
              : d.kind === "name"
                ? d.op === "create"
                  ? "New folder"
                  : "Rename"
                : d.kind === "empty"
                  ? "Empty Trash?"
                  : d.item.name,
          message:
            d.kind === "empty"
              ? `${countLabel(d.items.length)} will be deleted permanently.`
              : d.kind === "trashItem"
                ? d.confirmDelete
                  ? "Delete permanently?"
                  : [
                      volumeLabel(d.item.volume),
                      ...(d.item.origin || "").split("/").filter(Boolean),
                    ].join(" › ")
                : "",
          at:
            d.kind === "dest"
              ? breadcrumbs(
                  d.at,
                  d.volume
                    ? volumes.find((v) => v.id === d.volume)?.name || "Storage"
                    : primary?.name || "Internal storage",
                )
                  .map((c) => c.label)
                  .join(" › ")
              : "",
          canUp: d.kind === "dest" && d.at !== "",
          up: () => {
            if (d.kind === "dest") void destination(parentOf(d.at));
          },
          folders:
            d.kind === "dest"
              ? d.folders
                  .filter(
                    (f) =>
                      !d.paths.some(
                        (p) => f.path === p || f.path.startsWith(p + "/"),
                      ),
                  )
                  .map((f) => ({
                    id: JSON.stringify([d.volume || "primary", f.path]),
                    name: f.name,
                    label: "Open " + f.name,
                    d: ICONS.folder,
                    go: () => void destination(f.path),
                  }))
              : [],
          confirmLabel:
            d.kind === "dest"
              ? d.op === "move"
                ? "Move here"
                : "Copy here"
              : d.kind === "name"
                ? d.op === "create"
                  ? "Create"
                  : "Rename"
                : d.kind === "empty"
                  ? "Empty"
                  : "",
          confirmDisabled:
            busy ||
            (d.kind === "dest" &&
              d.op === "move" &&
              d.paths.every((p) => parentOf(p) === d.at)) ||
            (d.kind === "name" && !d.value.trim()),
          confirm: () => {
            if (busy) return;
            if (d.kind === "dest")
              void transfer(d.paths, d.at, d.op === "copy", d.volume);
            else if (d.kind === "name") void nameDialog();
            else if (d.kind === "empty") void emptyTrash(d.items);
          },
          value: d.kind === "name" ? d.value : "",
          onValue: (event: Event) => {
            if (dialog?.kind === "name") {
              dialog.value = (event.target as HTMLInputElement).value;
              repaint();
            }
          },
          onKey: (event: KeyboardEvent) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void nameDialog();
            }
          },
          restore: () => {
            if (d.kind === "trashItem")
              void restore([d.item.id], d.item.volume);
          },
          deleteNow: () => {
            if (d.kind !== "trashItem" || busy) return;
            if (!d.confirmDelete) {
              dialog = { ...d, confirmDelete: true };
              repaint();
              return;
            }
            void emptyTrash([d.item]);
          },
          deleteLabel:
            d.kind === "trashItem" && d.confirmDelete
              ? "Delete permanently"
              : "Delete now",
          cancel: () => {
            if (!busy) {
              dialog = undefined;
              repaint();
            }
          },
        }
      : null;
    return out;
  };
  module.back = (state: ViewState, currentApi: ViewApi) => {
    if (dialog) {
      if (!busy) {
        dialog = undefined;
        repaint();
      }
      return true;
    }
    if (state.menu) {
      currentApi.set({ menu: false });
      return true;
    }
    if (state.open) return back?.(state, currentApi);
    if (selection) {
      selection = null;
      repaint();
      return true;
    }
    if (place.kind !== "browse") {
      up();
      return true;
    }
    if (filter) {
      filter = null;
      filterRows = [];
      repaint();
      return true;
    }
    return back?.(state, currentApi);
  };
  module.onLeave = (...args: unknown[]) => {
    selectionEpoch++;
    dialog = undefined;
    selection = null;
    clearTimeout(pressTimer);
    deactivate();
    return leave?.(...args);
  };
  // Folder jumps (deep links) open Downloads; "preview" has no product meaning here.
  const preset = module.preset;
  module.preset = (sub: string) => {
    if (sub === "folder") {
      place = { kind: "folder", path: DOWNLOAD_FOLDER };
      base = { from: { kind: "browse" }, path: DOWNLOAD_FOLDER };
      return { folder: "__files_browser" };
    }
    return preset?.(sub);
  };
  return runner;
}
