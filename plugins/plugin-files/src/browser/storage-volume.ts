import {
  CATEGORIES,
  DOWNLOAD_FOLDER,
  freeName,
  inCategory,
  joinPath,
  parentOf,
  type StorageEntry,
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
  async query(): Promise<{ entries: StorageEntry[] }> {
    return { entries: await this.walk() };
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
    let current = row;
    const requireRow = async (parentId: string) => {
      const found = (await this.children(parentId)).find(
        (e) => e.id === row.id,
      );
      if (!found) throw new Missing();
      return found;
    };
    if (name !== row.name) {
      // A temporary unique name first, so the rename can't clash in the source folder either.
      await this.library.rename({
        id: row.id,
        expectedRevision: row.revision,
        name: ".moving-" + crypto.randomUUID(),
      });
      current = await requireRow(row.parentId);
    }
    await this.library.move({
      id: current.id,
      expectedRevision: current.revision,
      destinationId: targetId,
    });
    if (name !== row.name) {
      current = await requireRow(targetId);
      await this.library.rename({
        id: current.id,
        expectedRevision: current.revision,
        name,
      });
    }
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
  async transfer(
    paths: unknown,
    dest: unknown,
    copy: boolean,
  ): Promise<{ outcomes: { path: string; status: string; to?: string }[] }> {
    if (
      !Array.isArray(paths) ||
      !paths.length ||
      paths.length > BATCH_MAX ||
      new Set(paths).size !== paths.length
    )
      throw Error("Invalid selection");
    const target = validPath(dest, true),
      targetId = await this.folderId(target),
      outcomes = [];
    for (const raw of paths) {
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
  async trash(
    paths: unknown,
  ): Promise<{ outcomes: { path: string; status: string; to?: string }[] }> {
    if (
      !Array.isArray(paths) ||
      !paths.length ||
      paths.length > BATCH_MAX ||
      new Set(paths).size !== paths.length
    )
      throw Error("Invalid selection");
    const trashId = await this.trashId(),
      outcomes = [];
    for (const raw of paths) {
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
  async trashList(): Promise<{ items: TrashEntry[] }> {
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
  async restore(
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
  async emptyTrash(
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
  async volume() {
    let free = 0,
      total = 0;
    try {
      const estimate = await navigator.storage?.estimate?.();
      total = estimate?.quota ?? 0;
      free = Math.max(0, total - (estimate?.usage ?? 0));
    } catch {
      /* Free space is then not shown. */
    }
    return {
      id: "primary",
      name: "Internal storage",
      primary: true,
      free,
      total,
    };
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
        case "storageCategory":
          return { status: "ready", ...(await this.category(input.category)) };
        case "storageQuery":
          return { status: "ready", ...(await this.query()) };
        case "storageTransfer":
          return {
            status: "ready",
            ...(await this.transfer(
              input.paths,
              input.dest ?? "",
              input.copy === true,
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
          return { status: "ready", ...(await this.trash(input.paths)) };
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
