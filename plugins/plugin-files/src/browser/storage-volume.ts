import {
  CATEGORIES,
  DOWNLOAD_FOLDER,
  freeName,
  inCategory,
  joinPath,
  parentOf,
  type StorageEntry,
  type StorageVolume,
  type TrashEntry,
  trashExpired,
  validName,
  validPath,
  within,
} from "./storage-model.ts";

/**
 * Path-based browser storage operations over the host's existing file library. A clash keeps both
 * ("a (1).pdf"), trash records the origin before anything moves, and only Empty deletes.
 */
type Row = {
  id: string;
  parentId: string;
  name: string;
  mimeType: string;
  directory: boolean;
  size: number;
  revision: string;
  modifiedAt?: number;
  createdAt?: number;
};
type Library = {
  list(input: { id?: string }): Promise<{ folder: Row; entries: Row[] }>;
  createFolder(input: { id: string; name: string }): Promise<unknown>;
  rename(input: {
    id: string;
    expectedRevision: string;
    name: string;
  }): Promise<unknown>;
  move(input: {
    id: string;
    expectedRevision: string;
    destinationId: string;
  }): Promise<unknown>;
  place(input: {
    id: string;
    expectedRevision: string;
    destinationId: string;
    name: string;
  }): Promise<void>;
  delete(input: {
    id: string;
    expectedRevision: string;
    confirmPermanent: boolean;
  }): Promise<unknown>;
  select(input: { id: string }): Promise<{
    status: string;
    selectionId: string;
    name: string;
    mimeType: string;
  }>;
  attachment(input: {
    selectionId: string;
  }): Promise<{ name: string; mimeType: string; dataBase64: string }>;
  forgetSelected(input: { selectionId: string }): Promise<unknown>;
  importFile(file: File, parentId?: string): Promise<{ selectionId: string }>;
  shareMany(input: {
    items: { id: string; expectedRevision: string }[];
  }): Promise<unknown>;
  usage(): Promise<{ bytes: number; files: number }>;
};
type Status = { status: string; message?: string };
type StorageNamespace = { trashFolder: string; trashKey: string };
const BATCH_MAX = 500,
  WALK_MAX = 5000;
type TrashRecord = {
  name: string;
  origin: string;
  deletedAt: number;
  directory: boolean;
  mimeType: string;
  size: number;
};

const trashFlights = new Map<string, Promise<void>>();

class Missing extends Error {}
class Exists extends Error {}

export class BrowserStorageVolume {
  private library: Library;
  private changed: () => void;
  private now: () => number;
  private storeOverride?: Pick<Storage, "getItem" | "setItem">;
  private readonly namespace: StorageNamespace;
  // localStorage is read when used, so blocked storage fails one operation instead of app start.
  private get store(): Pick<Storage, "getItem" | "setItem"> {
    return this.storeOverride ?? localStorage;
  }
  constructor(
    library: Library,
    namespace: StorageNamespace,
    changed: () => void = () => {},
    now: () => number = Date.now,
    store?: Pick<Storage, "getItem" | "setItem">,
  ) {
    if (
      !/^\.[A-Za-z0-9_-]+$/.test(namespace.trashFolder) ||
      !namespace.trashKey
    )
      throw Error("Invalid browser storage namespace");
    this.namespace = { ...namespace };
    this.library = library;
    this.changed = changed;
    this.now = now;
    this.storeOverride = store;
  }

  private async children(id: string): Promise<Row[]> {
    return (await this.library.list({ id })).entries;
  }
  private async entry(path: string): Promise<Row | undefined> {
    let id = "root",
      row: Row | undefined;
    for (const part of path ? path.split("/") : []) {
      row = (await this.children(id)).find((e) => e.name === part);
      if (!row) return undefined;
      id = row.id;
    }
    return row;
  }
  private async folderId(path: string, create = false): Promise<string> {
    let id = "root";
    for (const part of path ? path.split("/") : []) {
      let row = (await this.children(id)).find((e) => e.name === part);
      if (!row && create) {
        await this.library.createFolder({ id, name: part });
        row = (await this.children(id)).find((e) => e.name === part);
      }
      if (!row?.directory) throw new Missing();
      id = row.id;
    }
    return id;
  }
  private row(path: string, e: Row, children?: number): StorageEntry {
    return {
      path,
      name: e.name,
      directory: e.directory,
      mimeType: e.directory ? "" : e.mimeType || "application/octet-stream",
      size: e.directory ? 0 : e.size,
      modified: e.modifiedAt ?? e.createdAt ?? 0,
      ...(e.directory ? { children: children ?? 0 } : {}),
    };
  }
  private async visible(id: string): Promise<Row[]> {
    return (await this.children(id)).filter((e) => !e.name.startsWith("."));
  }

  async list(path: unknown): Promise<{ entries: StorageEntry[] }> {
    const folder = validPath(path, true),
      id = await this.folderId(folder);
    const rows = await this.visible(id);
    return {
      entries: await Promise.all(
        rows.map(async (e) =>
          this.row(
            joinPath(folder, e.name),
            e,
            e.directory ? (await this.visible(e.id)).length : undefined,
          ),
        ),
      ),
    };
  }
  /** Every visible file, bounded. Hidden folders (the trash included) are skipped. */
  private async walk(): Promise<StorageEntry[]> {
    const out: StorageEntry[] = [],
      queue: [string, string][] = [["root", ""]];
    while (queue.length && out.length < WALK_MAX) {
      const next = queue.shift();
      if (!next) break;
      const [id, path] = next;
      for (const e of await this.visible(id)) {
        const p = joinPath(path, e.name);
        if (e.directory) queue.push([e.id, p]);
        else out.push(this.row(p, e));
      }
    }
    return out;
  }
  async category(input: unknown): Promise<{ entries: StorageEntry[] }> {
    const category = CATEGORIES.find(({ id }) => id === input)?.id;
    if (!category) throw Error("Unknown category");
    if (category === "downloads") {
      try {
        return {
          entries: (await this.list(DOWNLOAD_FOLDER)).entries.filter(
            (e) => !e.directory,
          ),
        };
      } catch (error) {
        if (error instanceof Missing) return { entries: [] };
        throw error;
      }
    }
    return {
      entries: (await this.walk())
        .filter((e) => inCategory(category, e))
        .sort((a, b) => b.modified - a.modified),
    };
  }
  /** Visible folders under the requested path, bounded like the file walk. */
  private async walkFolders(under: string): Promise<StorageEntry[]> {
    const start = validPath(under, true);
    let id: string;
    try {
      id = await this.folderId(start);
    } catch (error) {
      if (error instanceof Missing) return [];
      throw error;
    }
    const out: StorageEntry[] = [],
      queue: [string, string][] = [[id, start]];
    let visited = 0;
    for (const [folder, path] of queue) {
      if (visited++ >= WALK_MAX) break;
      for (const entry of await this.visible(folder)) {
        if (!entry.directory) continue;
        const child = joinPath(path, entry.name);
        queue.push([entry.id, child]);
        out.push(this.row(child, entry, (await this.visible(entry.id)).length));
        if (out.length >= WALK_MAX) return out;
      }
    }
    return out;
  }
  async query(
    input: { folders?: boolean; folder?: string } = {},
  ): Promise<{ entries: StorageEntry[] }> {
    return {
      entries:
        input.folders === true
          ? await this.walkFolders(
              typeof input.folder === "string" ? input.folder : "",
            )
          : await this.walk(),
    };
  }

  async createFolder(
    parent: unknown,
    name: unknown,
  ): Promise<{ path: string }> {
    const folder = validPath(parent, true),
      clean = validName(name);
    if (clean.startsWith(".")) throw Error("Invalid name");
    const id = await this.folderId(folder),
      free = freeName(
        clean,
        (await this.children(id)).map((e) => e.name),
        true,
      );
    await this.library.createFolder({ id, name: free });
    this.changed();
    return { path: joinPath(folder, free) };
  }
  async rename(path: unknown, name: unknown): Promise<{ path: string }> {
    const from = validPath(path),
      clean = validName(name);
    if (clean.startsWith(".")) throw Error("Invalid name");
    const row = await this.entry(from);
    if (!row) throw new Missing();
    if (clean === row.name) return { path: from };
    if (
      (await this.children(row.parentId)).some(
        (e) => e.id !== row.id && e.name.toLowerCase() === clean.toLowerCase(),
      )
    )
      throw new Exists();
    await this.library.rename({
      id: row.id,
      expectedRevision: row.revision,
      name: clean,
    });
    this.changed();
    return { path: joinPath(parentOf(from), clean) };
  }
  /** Moves a row into a folder under a name free there, never replacing (spec MoveOne). */
  private async place(row: Row, targetId: string, name: string): Promise<void> {
    const move = {
      id: row.id,
      expectedRevision: row.revision,
      destinationId: targetId,
    };
    if (name === row.name) await this.library.move(move);
    else await this.library.place({ ...move, name });
  }
  private async copyInto(
    row: Row,
    targetId: string,
    name: string,
  ): Promise<void> {
    if (row.directory) {
      await this.library.createFolder({ id: targetId, name });
      const created = (await this.children(targetId)).find(
        (e) => e.name === name,
      );
      if (!created) throw new Missing();
      for (const child of await this.children(row.id))
        await this.copyInto(child, created.id, child.name);
      return;
    }
    const selected = await this.library.select({ id: row.id });
    try {
      const data = await this.library.attachment({
        selectionId: selected.selectionId,
      });
      const bytes = Uint8Array.from(atob(data.dataBase64), (c) =>
        c.charCodeAt(0),
      );
      const imported = await this.library.importFile(
        new File([bytes], name, { type: row.mimeType }),
        targetId,
      );
      await this.library
        .forgetSelected({ selectionId: imported.selectionId })
        .catch(() => {});
    } finally {
      await this.library
        .forgetSelected({ selectionId: selected.selectionId })
        .catch(() => {});
    }
  }
  private async reviewedIdentity(row: Row): Promise<string> {
    const bytes = new TextEncoder().encode(
      JSON.stringify([row.id, row.revision]),
    );
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }
  async reviewedIdentities(paths: unknown): Promise<string[]> {
    if (!Array.isArray(paths) || !paths.length || paths.length > BATCH_MAX)
      throw Error("Invalid selection");
    return Promise.all(
      paths.map(async (path) => {
        const row = await this.entry(validPath(path));
        if (!row) throw new Missing();
        return this.reviewedIdentity(row);
      }),
    );
  }
  private reviewTokens(
    paths: unknown[],
    reviewed: unknown,
  ): string[] | undefined {
    if (reviewed === undefined) return undefined;
    if (
      !Array.isArray(reviewed) ||
      reviewed.length !== paths.length ||
      reviewed.some(
        (token) =>
          typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token),
      )
    )
      throw Error("Invalid reviewed files");
    return reviewed;
  }
  async transfer(
    paths: unknown,
    dest: unknown,
    copy: boolean,
    reviewed?: unknown,
  ): Promise<{ outcomes: { path: string; status: string; to?: string }[] }> {
    if (
      !Array.isArray(paths) ||
      !paths.length ||
      paths.length > BATCH_MAX ||
      new Set(paths).size !== paths.length
    )
      throw Error("Invalid selection");
    const tokens = this.reviewTokens(paths, reviewed);
    const target = validPath(dest, true),
      targetId = await this.folderId(target),
      outcomes = [];
    for (const [index, raw] of paths.entries()) {
      let path: string;
      try {
        path = validPath(raw);
      } catch {
        outcomes.push({ path: String(raw), status: "invalid" });
        continue;
      }
      const row = await this.entry(path);
      if (!row) {
        outcomes.push({ path, status: "missing" });
        continue;
      }
      if (tokens && tokens[index] !== (await this.reviewedIdentity(row))) {
        outcomes.push({ path, status: "changed" });
        continue;
      }
      if (!copy && parentOf(path) === target) {
        outcomes.push({ path, status: "unchanged", to: path });
        continue;
      }
      if (row.directory && within(target, path)) {
        outcomes.push({ path, status: "invalid" });
        continue;
      }
      const name = freeName(
        row.name,
        (await this.children(targetId)).map((e) => e.name),
        row.directory,
      );
      try {
        if (copy) await this.copyInto(row, targetId, name);
        else await this.place(row, targetId, name);
        outcomes.push({
          path,
          status: copy ? "copied" : "moved",
          to: joinPath(target, name),
        });
      } catch {
        outcomes.push({ path, status: "failed" });
      }
    }
    this.changed();
    return { outcomes };
  }

  // A listing may prune the journal, so it must hold the same custody as writers.
  private withTrashLock<T>(work: () => Promise<T>): Promise<T> {
    const key = "browser-files-trash:" + this.namespace.trashKey;
    const locks = globalThis.navigator?.locks;
    if (locks?.request) return locks.request(key, { mode: "exclusive" }, work);

    const previous = trashFlights.get(key) ?? Promise.resolve();
    const attempt = previous.then(work);
    const tail = attempt.then(
      () => {},
      () => {},
    );
    trashFlights.set(key, tail);
    return attempt.finally(() => {
      if (trashFlights.get(key) === tail) trashFlights.delete(key);
    });
  }

  private records(): Record<string, TrashRecord> {
    try {
      const value = JSON.parse(
        this.store.getItem(this.namespace.trashKey) || "{}",
      );
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
    } catch {
      return {};
    }
  }
  private save(records: Record<string, TrashRecord>) {
    this.store.setItem(this.namespace.trashKey, JSON.stringify(records));
  }
  /** The trash folder is created by the first trash, never by reading it. */
  private async trashId(): Promise<string> {
    return this.folderId(this.namespace.trashFolder, true);
  }
  private async existingTrashId(): Promise<string | undefined> {
    try {
      return await this.folderId(this.namespace.trashFolder);
    } catch (error) {
      if (error instanceof Missing) return undefined;
      throw error;
    }
  }
  /** The origin is recorded before anything moves, so an interrupted trash never loses the way back. */
  trash(paths: unknown, reviewed?: unknown) {
    return this.withTrashLock(() => this.trashRows(paths, reviewed));
  }
  private async trashRows(
    paths: unknown,
    reviewed?: unknown,
  ): Promise<{ outcomes: { path: string; status: string; to?: string }[] }> {
    if (
      !Array.isArray(paths) ||
      !paths.length ||
      paths.length > BATCH_MAX ||
      new Set(paths).size !== paths.length
    )
      throw Error("Invalid selection");
    const tokens = this.reviewTokens(paths, reviewed);
    let trashId = tokens ? undefined : await this.trashId();
    const outcomes = [];
    for (const [index, raw] of paths.entries()) {
      let path: string;
      try {
        path = validPath(raw);
      } catch {
        outcomes.push({ path: String(raw), status: "invalid" });
        continue;
      }
      const row = await this.entry(path);
      if (!row) {
        outcomes.push({ path, status: "missing" });
        continue;
      }
      if (tokens && tokens[index] !== (await this.reviewedIdentity(row))) {
        outcomes.push({ path, status: "changed" });
        continue;
      }
      trashId ??= await this.trashId();
      const id = crypto.randomUUID(),
        records = this.records();
      records[id] = {
        name: row.name,
        origin: parentOf(path),
        deletedAt: this.now(),
        directory: row.directory,
        mimeType: row.directory ? "" : row.mimeType,
        size: row.directory ? 0 : row.size,
      };
      this.save(records);
      try {
        await this.place(row, trashId, id);
        outcomes.push({ path, status: "trashed", to: id });
      } catch {
        const back = this.records();
        delete back[id];
        this.save(back);
        outcomes.push({ path, status: "failed" });
      }
    }
    this.changed();
    return { outcomes };
  }
  /** Trash, newest first; items past the 30-day retention are deleted here. */
  trashList() {
    return this.withTrashLock(() => this.listTrashRows());
  }
  private async listTrashRows(): Promise<{ items: TrashEntry[] }> {
    const trashId = await this.existingTrashId(),
      rows = trashId ? await this.children(trashId) : [],
      records = this.records(),
      now = this.now(),
      items: TrashEntry[] = [];
    for (const row of rows) {
      const record = records[row.name];
      if (!record) continue;
      if (trashExpired(record.deletedAt, now)) {
        await this.erase(row);
        delete records[row.name];
        continue;
      }
      items.push({ id: row.name, ...record });
    }
    for (const id of Object.keys(records))
      if (!rows.some((row) => row.name === id)) delete records[id];
    this.save(records);
    return { items: items.sort((a, b) => b.deletedAt - a.deletedAt) };
  }
  restore(ids: unknown) {
    return this.withTrashLock(() => this.restoreRows(ids));
  }
  private async restoreRows(
    ids: unknown,
  ): Promise<{ outcomes: { path: string; status: string; to?: string }[] }> {
    if (!Array.isArray(ids) || !ids.length || ids.length > BATCH_MAX)
      throw Error("Invalid selection");
    const trashId = await this.existingTrashId(),
      outcomes = [];
    for (const id of ids) {
      const records = this.records(),
        record = records[id],
        row = trashId
          ? (await this.children(trashId)).find((e) => e.name === id)
          : undefined;
      if (!record || !row) {
        outcomes.push({ path: id, status: "missing" });
        continue;
      }
      let origin = "";
      try {
        origin = validPath(record.origin, true);
      } catch {
        origin = "";
      }
      try {
        let originId: string;
        try {
          originId = await this.folderId(origin, true);
        } catch {
          origin = "";
          originId = "root";
        }
        const name = freeName(
          validName(record.name),
          (await this.children(originId)).map((e) => e.name),
          record.directory,
        );
        await this.place(row, originId, name);
        delete records[id];
        this.save(records);
        outcomes.push({
          path: id,
          status: "restored",
          to: joinPath(origin, name),
        });
      } catch {
        outcomes.push({ path: id, status: "failed" });
      }
    }
    this.changed();
    return { outcomes };
  }
  private async erase(row: Row): Promise<void> {
    if (row.directory)
      for (const child of await this.children(row.id)) await this.erase(child);
    const latest = (await this.children(row.parentId)).find(
      (e) => e.id === row.id,
    );
    if (latest)
      await this.library.delete({
        id: latest.id,
        expectedRevision: latest.revision,
        confirmPermanent: true,
      });
  }
  /** Permanent deletion, only after the owner confirmed it. */
  emptyTrash(ids: unknown, confirmed: boolean) {
    return this.withTrashLock(() => this.emptyTrashRows(ids, confirmed));
  }
  private async emptyTrashRows(
    ids: unknown,
    confirmed: boolean,
  ): Promise<Status & { count?: number }> {
    if (!confirmed)
      return {
        status: "confirmation-required",
        message: "Confirm before deleting permanently.",
      };
    // Only the confirmed items: something trashed after the confirmation is not deleted.
    if (!Array.isArray(ids) || !ids.length)
      return { status: "invalid", message: "Invalid name or path." };
    const trashId = await this.existingTrashId(),
      records = this.records();
    let count = 0;
    for (const row of trashId ? await this.children(trashId) : []) {
      if (ids && !ids.includes(row.name)) continue;
      await this.erase(row);
      delete records[row.name];
      count++;
    }
    this.save(records);
    this.changed();
    return { status: "ready", count };
  }
  async share(paths: unknown): Promise<Status> {
    if (!Array.isArray(paths)) throw Error("Invalid selection");
    const items = [];
    for (const path of paths.slice(0, 100)) {
      const row = await this.entry(validPath(path));
      if (row && !row.directory)
        items.push({ id: row.id, expectedRevision: row.revision });
    }
    if (!items.length)
      return { status: "unsupported", message: "Select files to share." };
    try {
      await this.library.shareMany({ items });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        return { status: "cancelled" };
      return {
        status: "unsupported",
        message: "Sharing is unavailable in this browser.",
      };
    }
    return { status: "opened" };
  }
  async select(path: unknown) {
    const row = await this.entry(validPath(path));
    if (!row || row.directory) throw new Missing();
    return this.library.select({ id: row.id });
  }
  async volume(): Promise<StorageVolume> {
    const volume = {
      id: "primary",
      name: "Internal storage",
      primary: true,
      free: 0,
      total: 0,
    };
    try {
      const estimate = await navigator.storage?.estimate?.();
      const { quota, usage } = estimate ?? {};
      if (
        typeof quota === "number" &&
        Number.isFinite(quota) &&
        quota > 0 &&
        typeof usage === "number" &&
        Number.isFinite(usage) &&
        usage >= 0 &&
        usage <= quota
      )
        return { ...volume, free: quota - usage, total: quota };
    } catch {
      /* The origin quota is optional. */
    }

    try {
      const usage = await this.library.usage();
      if (
        Number.isSafeInteger(usage.bytes) &&
        usage.bytes >= 0 &&
        Number.isSafeInteger(usage.files) &&
        usage.files >= 0
      )
        return { ...volume, usage };
    } catch {
      /* Keep the volume usable when usage cannot be read. */
    }
    return volume;
  }

  /** The host storage* plugin surface. */
  async run(
    method: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // The browser has one volume. Like Android, a volume that is not mounted is refused.
    if (input.volume !== undefined && input.volume !== "primary")
      return { status: "unavailable", message: "This storage is not mounted." };
    try {
      switch (method) {
        case "storageState":
          return {
            status: "ready",
            access: "granted",
            volumes: [await this.volume()],
          };
        case "storageRequestAccess":
          return { status: "ready", access: "granted" };
        case "storageList":
          return { status: "ready", ...(await this.list(input.path ?? "")) };
        case "storageCategory": {
          const { entries } = await this.category(input.category);
          return {
            status: "ready",
            ...(input.countOnly === true
              ? { count: entries.length }
              : { entries }),
          };
        }
        case "storageQuery":
          return { status: "ready", ...(await this.query(input)) };
        case "storageReviewedIdentities":
          return {
            status: "ready",
            reviewed: await this.reviewedIdentities(input.paths),
          };
        case "storageTransfer":
          return {
            status: "ready",
            ...(await this.transfer(
              input.paths,
              input.dest ?? "",
              input.copy === true,
              input.reviewed,
            )),
          };
        case "storageRename":
          return {
            status: "ready",
            ...(await this.rename(input.path, input.name)),
          };
        case "storageCreateFolder":
          return {
            status: "ready",
            ...(await this.createFolder(input.parent ?? "", input.name)),
          };
        case "storageTrash":
          return {
            status: "ready",
            ...(await this.trash(input.paths, input.reviewed)),
          };
        case "storageTrashList":
          return { status: "ready", ...(await this.trashList()) };
        case "storageRestore":
          return { status: "ready", ...(await this.restore(input.ids)) };
        case "storageEmptyTrash":
          return {
            ...(await this.emptyTrash(input.ids, input.confirmed === true)),
          };
        case "storageShare":
          return { ...(await this.share(input.paths)) };
        case "storageSelect":
          return { ...(await this.select(input.path)) };
        case "storageOpen":
          return { ...(await this.select(input.path)) };
        case "storageWatch":
        case "storageUnwatch":
          return { status: "ready" };
      }
      return { status: "unsupported", message: "Unsupported file operation." };
    } catch (error) {
      if (error instanceof Missing)
        return { status: "missing", message: "This item is no longer there." };
      if (error instanceof Exists)
        return { status: "exists", message: "That name is already used here." };
      if (error instanceof Error && /Invalid/.test(error.message))
        return { status: "invalid", message: "Invalid name or path." };
      return {
        status: "failed",
        message: "The operation could not be confirmed.",
      };
    }
  }
}
