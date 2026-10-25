import { WebPlugin } from "@capacitor/core";
import { type MailAttachment, reviewMailAttachment } from "./attachment.ts";
import { fileArchive } from "./file-archive.ts";
export class FilesSourceReadError extends Error {
  override readonly name = "FilesSourceReadError";
}

export interface BrowserFilesOptions {
  databaseName: string;
  archiveName: string;
  pdfWorkerUrl: string;
  pdfAssetsBase: string;
  openSelectedDocumentViewer(
    name: string,
    url: string,
    onClose: () => void,
  ): () => void;
  runFilePicker<T>(
    choose: (signal: AbortSignal) => Promise<T>,
    cancelled: T,
  ): Promise<T>;
  inputFiles(
    signal: AbortSignal,
    options?: { photos?: boolean; directory?: boolean },
  ): Promise<File[]>;
}
interface DirectoryHandle {
  kind: "directory";
  name: string;
  values(): AsyncIterable<
    DirectoryHandle | { kind: "file"; name: string; getFile(): Promise<File> }
  >;
}

type Entry = {
  id: string;
  parentId: string;
  name: string;
  mimeType: string;
  directory: boolean;
  size: number;
  revision: string;
  createdAt?: number;
  modifiedAt?: number;
  blob?: Blob;
  bytes?: ArrayBuffer;
};
const revision = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
function createFileStorage(options: BrowserFilesOptions) {
  options = { ...options };
  let database: Promise<IDBDatabase> | undefined;
  function db() {
    return (database ??= new Promise((resolve, reject) => {
      let blocked = false;
      const r = indexedDB.open(options.databaseName, 2);
      r.onblocked = () => {
        blocked = true;
        database = undefined;
        reject(Error("Close other tabs for this app and retry Files."));
      };
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains("entries"))
          r.result.createObjectStore("entries", { keyPath: "id" });
        r.result.createObjectStore("workflowReceipts", { keyPath: "id" });
      };
      r.onsuccess = () => {
        if (blocked) {
          r.result.close();
          return;
        }
        r.result.onversionchange = () => {
          r.result.close();
          database = undefined;
        };
        resolve(r.result);
      };
      r.onerror = () => {
        database = undefined;
        reject(r.error);
      };
    }));
  }
  async function entries() {
    const d = await db();
    return new Promise<Entry[]>((resolve, reject) => {
      const r = d.transaction("entries").objectStore("entries").getAll();
      r.onsuccess = () =>
        resolve(
          r.result.map((row: Entry) =>
            row.bytes
              ? { ...row, blob: new Blob([row.bytes], { type: row.mimeType }) }
              : row,
          ),
        );
      r.onerror = () => reject(r.error);
    });
  }
  /** Read, validate, and mutate in one transaction, including across tabs. */
  async function transaction<T>(
    action: (all: Entry[], store: IDBObjectStore) => T,
  ) {
    const d = await db();
    return new Promise<T>((resolve, reject) => {
      const tx = d.transaction("entries", "readwrite"),
        store = tx.objectStore("entries");
      let result: T;
      let failure: unknown;
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = (event) =>
        reject(
          failure ||
            (event.target as IDBRequest)?.error ||
            tx.error ||
            Error("File storage failed."),
        );
      const request = store.getAll();
      request.onsuccess = () => {
        try {
          result = action(request.result, store);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
    });
  }
  return { db, entries, transaction };
}
const root: Entry = {
  id: "root",
  parentId: "",
  name: "Browser files",
  mimeType: "",
  directory: true,
  size: 0,
  revision: "root",
};
const publicEntry = ({ blob, bytes, ...entry }: Entry) => ({
  ...entry,
  canCreate: entry.directory,
  canRename: entry.id !== "root",
  canDelete: entry.id !== "root",
  canMove: entry.id !== "root",
});
const validName = (name: string) => {
  name = name.trim();
  if (
    !name ||
    /[\\/\0]/.test(name) ||
    [".", ".."].includes(name) ||
    name.length > 240
  )
    throw Error("Choose a valid file name.");
  return name.trim();
};
function waitForFileRead<T>(
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      if (error) reject(error);
      else resolve(value as T);
    };
    const cancel = () =>
      finish(new DOMException("Files read cancelled", "AbortError"));
    signal.addEventListener("abort", cancel, { once: true });
    work.then(
      (value) => finish(null, value),
      (error) => finish(error),
    );
    if (signal.aborted) cancel();
  });
}
export class BrowserFiles extends WebPlugin {
  constructor(
    private options: BrowserFilesOptions,
    private storage = createFileStorage(options),
  ) {
    super();
    this.options = { ...options };
  }
  /** File and durable operation receipt commit together; deletion never permits replay to recreate it. */
  async saveWorkflowAttachment(
    input: MailAttachment & { operationId: string },
    signal: AbortSignal,
  ) {
    input = { ...input };
    signal.throwIfAborted();
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(input.operationId))
      throw Error("Invalid workflow operation.");
    const checked = await reviewMailAttachment(input),
      name = validName(input.name),
      fingerprint = JSON.stringify([name, input.mimeType, checked.sha256]);
    const bytes = Uint8Array.from(atob(input.dataBase64), (c) =>
        c.charCodeAt(0),
      ),
      d = await this.storage.db();
    signal.throwIfAborted();
    return new Promise<{ id: string; name: string; sha256: string }>(
      (resolve, reject) => {
        const tx = d.transaction(["entries", "workflowReceipts"], "readwrite"),
          store = tx.objectStore("entries"),
          receipts = tx.objectStore("workflowReceipts");
        let result: { id: string; name: string; sha256: string },
          failure: unknown;
        const cancel = () => {
          try {
            tx.abort();
          } catch {}
        };
        signal.addEventListener("abort", cancel, { once: true });
        tx.oncomplete = () => {
          signal.removeEventListener("abort", cancel);
          resolve(result);
        };
        tx.onabort = tx.onerror = () => {
          signal.removeEventListener("abort", cancel);
          reject(
            failure || tx.error || new DOMException("Cancelled", "AbortError"),
          );
        };
        const receipt = receipts.get(input.operationId);
        receipt.onsuccess = () => {
          try {
            signal.throwIfAborted();
            if (receipt.result) {
              if (receipt.result.fingerprint !== fingerprint)
                throw Error("Saved file receipt does not match this step.");
              result = receipt.result.result;
              return;
            }
            const all = store.getAll();
            all.onsuccess = () => {
              try {
                signal.throwIfAborted();
                const rows = all.result as Entry[];
                let folder = rows.find(
                  (row) => row.parentId === "root" && row.name === "Receipts",
                );
                if (folder && !folder.directory)
                  throw Error(
                    "A file named Receipts already exists. Rename it before saving receipts.",
                  );
                const now = Date.now();
                if (!folder) {
                  folder = {
                    id: crypto.randomUUID(),
                    parentId: "root",
                    name: "Receipts",
                    mimeType: "",
                    directory: true,
                    size: 0,
                    revision: revision(),
                    createdAt: now,
                    modifiedAt: now,
                  };
                  store.add(folder);
                }
                const folderId = folder.id;
                let savedName = name;
                for (
                  let n = 2;
                  rows.some(
                    (row) =>
                      row.parentId === folderId && row.name === savedName,
                  );
                  n++
                ) {
                  const dot = name.lastIndexOf(".");
                  savedName =
                    dot > 0
                      ? name.slice(0, dot) + " (" + n + ")" + name.slice(dot)
                      : name + " (" + n + ")";
                }
                result = {
                  id: crypto.randomUUID(),
                  name: savedName,
                  sha256: checked.sha256,
                };
                store.add({
                  ...result,
                  parentId: folder.id,
                  mimeType: input.mimeType,
                  directory: false,
                  size: checked.size,
                  revision: revision(),
                  createdAt: now,
                  modifiedAt: now,
                  bytes: bytes.buffer,
                });
                receipts.add({ id: input.operationId, fingerprint, result });
              } catch (error) {
                failure = error;
                tx.abort();
              }
            };
          } catch (error) {
            failure = error;
            tx.abort();
          }
        };
      },
    );
  }
  private selection = new Map<string, { id: string; revision: string }>();
  private previews = new Map<string, string>();
  private viewers = new Map<string, () => void>();
  private urls = new Map<string, string>();
  async choose() {
    return this.list({});
  }
  async workflowFiles(input: { recent: boolean }, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const choose = (all: Entry[]) =>
      all
        .filter((row) => !row.directory)
        .sort(
          (a, b) =>
            (b.modifiedAt || 0) - (a.modifiedAt || 0) ||
            a.id.localeCompare(b.id),
        )
        .slice(0, input.recent ? 20 : 2000);
    const all = await waitForFileRead(this.storage.entries(), signal),
      rows = choose(all);
    signal?.throwIfAborted();
    if (!input.recent && all.filter((row) => !row.directory).length > 2000)
      throw Error("Choose a smaller Files source.");
    const result = [];
    for (const row of rows) {
      signal?.throwIfAborted();
      let text: string | undefined,
        contentStatus = "binary";
      if (
        row.mimeType.startsWith("text/") ||
        [
          "application/json",
          "application/xml",
          "application/javascript",
        ].includes(row.mimeType)
      ) {
        if (row.size > 16000)
          throw new FilesSourceReadError(
            "A selected Files text source exceeds the 16,000-byte read limit. No partial source was returned.",
          );
        if (row.blob) {
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(
              await waitForFileRead(row.blob.arrayBuffer(), signal),
            );
            if (text.includes("\0")) {
              text = undefined;
              contentStatus = "binary";
            } else contentStatus = "text";
          } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            contentStatus = "binary";
          }
        }
      }
      result.push({
        id: row.id,
        parentId: row.parentId,
        name: row.name,
        mimeType: row.mimeType,
        size: row.size,
        revision: row.revision,
        createdAt: row.createdAt ?? null,
        modifiedAt: row.modifiedAt ?? null,
        contentStatus,
        ...(text === undefined ? {} : { text }),
      });
    }
    signal?.throwIfAborted();
    const latest = await waitForFileRead(this.storage.entries(), signal);
    signal?.throwIfAborted();
    if (!input.recent && latest.filter((row) => !row.directory).length > 2000)
      throw Error("Choose a smaller Files source.");
    const current = choose(latest);
    if (
      JSON.stringify(current.map((row) => [row.id, row.revision])) !==
      JSON.stringify(rows.map((row) => [row.id, row.revision]))
    )
      throw Error("Files changed during the read. Run the step again.");
    return {
      scope: input.recent
        ? "20 most recently imported or changed files"
        : "All managed files",
      files: result,
    };
  }

  async importDirectory(
    files: { path: string; file: File }[],
    name: string,
    signal?: AbortSignal,
  ) {
    const folder: Entry = {
        id: crypto.randomUUID(),
        parentId: "root",
        name: validName(name),
        mimeType: "",
        directory: true,
        size: 0,
        revision: revision(),
      },
      rows: Entry[] = [folder],
      directories = new Map<string, string>([["", folder.id]]);
    for (const item of files) {
      const parts = item.path.split("/").map(validName);
      let path = "",
        parentId = folder.id;
      for (const part of parts.slice(0, -1)) {
        path = path ? path + "/" + part : part;
        let id = directories.get(path);
        if (!id) {
          id = crypto.randomUUID();
          directories.set(path, id);
          rows.push({
            id,
            parentId,
            name: part,
            mimeType: "",
            directory: true,
            size: 0,
            revision: revision(),
          });
        }
        parentId = id;
      }
      rows.push({
        id: crypto.randomUUID(),
        parentId,
        name: parts[parts.length - 1],
        mimeType: item.file.type || "application/octet-stream",
        directory: false,
        size: item.file.size,
        revision: revision(),
        bytes: await waitForFileRead(item.file.arrayBuffer(), signal),
      });
    }
    await this.storage.transaction((all, store) => {
      signal?.throwIfAborted();
      if (all.some((e) => e.parentId === "root" && e.name === folder.name))
        throw Error("A folder with this name already exists.");
      const names = new Set<string>();
      for (const row of rows) {
        const key = row.parentId + "/" + row.name;
        if (names.has(key)) throw Error("Duplicate folder entry.");
        names.add(key);
        store.add({ ...row, createdAt: Date.now(), modifiedAt: Date.now() });
      }
    });
    return this.list({ id: folder.id });
  }
  async importFolder() {
    return this.options.runFilePicker<
      Awaited<ReturnType<BrowserFiles["list"]>> | { status: string }
    >(
      async (signal) => {
        const picker = (
          window as Window & {
            showDirectoryPicker?: (options: {
              mode: "read";
            }) => Promise<DirectoryHandle>;
          }
        ).showDirectoryPicker;
        if (picker) {
          const directory = await picker.call(window, { mode: "read" });
          signal.throwIfAborted();
          const files: { path: string; file: File }[] = [];
          const walk = async (handle: DirectoryHandle, prefix = "") => {
            for await (const entry of handle.values()) {
              signal.throwIfAborted();
              const path = prefix + entry.name;
              if (entry.kind === "directory") await walk(entry, path + "/");
              else files.push({ path, file: await entry.getFile() });
            }
          };
          await walk(directory);
          signal.throwIfAborted();
          return this.importDirectory(files, directory.name, signal);
        }
        const files = await this.options.inputFiles(signal, {
          directory: true,
        });
        signal.throwIfAborted();
        if (!files.length) return { status: "cancelled" };
        const name = files[0].webkitRelativePath.split("/")[0];
        return this.importDirectory(
          files.map((file) => ({
            path: file.webkitRelativePath.split("/").slice(1).join("/"),
            file,
          })),
          name,
          signal,
        );
      },
      { status: "cancelled" },
    );
  }
  async usage() {
    const d = await this.storage.db();
    return new Promise<{ bytes: number; files: number }>((resolve, reject) => {
      let bytes = 0,
        files = 0;
      const tx = d.transaction("entries"),
        cursor = tx.objectStore("entries").openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        const row = current.value as Entry;
        if (!row.directory) {
          files++;
          bytes += row.bytes?.byteLength ?? row.blob?.size ?? row.size;
        }
        current.continue();
      };
      tx.oncomplete = () => resolve({ bytes, files });
      tx.onabort = tx.onerror = () =>
        reject(tx.error || Error("File storage could not be read."));
    });
  }
  async list(input: { id?: string }) {
    const all = await this.storage.entries(),
      folder =
        input.id && input.id !== "root"
          ? all.find((e) => e.id === input.id)
          : root;
    if (!folder?.directory) throw Error("Choose a folder.");
    return {
      status: "ready",
      message: "",
      rootId: "root",
      folder: publicEntry(folder),
      entries: all.filter((e) => e.parentId === folder.id).map(publicEntry),
    };
  }
  private insert(row: Entry, signal?: AbortSignal) {
    return this.storage.transaction((all, store) => {
      signal?.throwIfAborted();
      if (
        row.parentId !== "root" &&
        !all.some((e) => e.id === row.parentId && e.directory)
      )
        throw Error("Choose a folder.");
      if (all.some((e) => e.parentId === row.parentId && e.name === row.name))
        throw Error("Choose a different name.");
      store.add({ ...row, createdAt: Date.now(), modifiedAt: Date.now() });
    });
  }
  async createFolder(input: { id: string; name: string }) {
    await this.insert({
      id: crypto.randomUUID(),
      parentId: input.id,
      name: validName(input.name),
      mimeType: "",
      directory: true,
      size: 0,
      revision: revision(),
    });
    return { status: "created", message: "Folder created." };
  }
  async importFile(file: File, parentId = "root", signal?: AbortSignal) {
    const row: Entry = {
      id: crypto.randomUUID(),
      parentId,
      name: validName(file.name),
      mimeType: file.type || "application/octet-stream",
      directory: false,
      size: file.size,
      revision: revision(),
      bytes: await waitForFileRead(file.arrayBuffer(), signal),
    };
    await this.insert(row, signal);
    signal?.throwIfAborted();
    const selected = await this.select({ id: row.id });
    if (signal?.aborted) {
      await this.forgetSelected(selected);
      signal.throwIfAborted();
    }
    return selected;
  }
  async pick(photos = false) {
    const cancelled = {
      status: "cancelled",
      action: photos ? "photos" : "files",
    };
    return this.options.runFilePicker<
      | Awaited<ReturnType<BrowserFiles["importFile"]>>
      | { status: string; action: string; message?: string }
    >(async (signal) => {
      const files = await this.options.inputFiles(signal, { photos });
      signal.throwIfAborted();
      if (!files.length) return cancelled;
      try {
        return await this.importFile(files[0], "root", signal);
      } catch (error) {
        if (signal.aborted) throw error;
        return {
          status: "failed",
          action: cancelled.action,
          message: "File could not be imported. Try again.",
        };
      }
    }, cancelled);
  }
  private async mutate(
    input: { id: string; expectedRevision: string },
    change: (row: Entry, all: Entry[]) => Entry | null,
  ) {
    const parentId = await this.storage.transaction((all, store) => {
      const row = all.find((e) => e.id === input.id);
      if (!row || row.revision !== input.expectedRevision)
        throw Error("This file changed. Refresh and try again.");
      const updated = change(row, all);
      if (
        updated &&
        all.some(
          (e) =>
            e.id !== row.id &&
            e.parentId === updated.parentId &&
            e.name === updated.name,
        )
      )
        throw Error("Choose a different name.");
      if (updated)
        store.put({ ...updated, revision: revision(), modifiedAt: Date.now() });
      else store.delete(row.id);
      return updated?.parentId || row.parentId;
    });
    return { status: "changed", message: "File updated.", parentId };
  }
  async rename(input: { id: string; expectedRevision: string; name: string }) {
    await this.mutate(input, (row) => ({
      ...row,
      name: validName(input.name),
    }));
    return { status: "renamed", message: "Renamed." };
  }
  async delete(input: {
    id: string;
    expectedRevision: string;
    confirmPermanent: boolean;
  }) {
    if (!input.confirmPermanent) throw Error("Confirm deletion.");
    await this.mutate(input, (row, all) => {
      if (all.some((e) => e.parentId === row.id))
        throw Error("Empty this folder before deleting it.");
      return null;
    });
    return { status: "deleted", message: "Deleted." };
  }
  async move(input: {
    id: string;
    expectedRevision: string;
    destinationId: string;
  }) {
    await this.mutate(input, (row, all) => {
      const target =
        input.destinationId === "root"
          ? root
          : all.find((e) => e.id === input.destinationId);
      if (!target?.directory) throw Error("Choose a destination folder.");
      let ancestor: Entry | undefined = target;
      while (ancestor) {
        if (ancestor.id === row.id)
          throw Error("Choose a folder outside this folder.");
        const parentId: string = ancestor.parentId;
        ancestor = all.find((e) => e.id === parentId);
      }
      return { ...row, parentId: target.id };
    });
    return { status: "moved", message: "Moved." };
  }
  private batchRows(
    all: Entry[],
    items: { id: string; expectedRevision: string }[],
  ) {
    if (
      !items.length ||
      new Set(items.map((item) => item.id)).size !== items.length
    )
      throw Error("Select files first.");
    return items.map((item) => {
      const row = all.find((row) => row.id === item.id);
      if (!row || row.revision !== item.expectedRevision)
        throw Error("A selected file changed. Refresh and select again.");
      return row;
    });
  }
  async changeMany(input: {
    items: { id: string; expectedRevision: string }[];
    action: "move" | "delete";
    destinationId?: string;
    confirmPermanent?: boolean;
  }) {
    await this.storage.transaction((all, store) => {
      const rows = this.batchRows(all, input.items);
      if (input.action === "delete") {
        if (!input.confirmPermanent) throw Error("Confirm deletion.");
        if (rows.some((row) => all.some((child) => child.parentId === row.id)))
          throw Error("Empty selected folders before deleting them.");
        for (const row of rows) store.delete(row.id);
      } else if (input.action === "move") {
        const target =
          input.destinationId === "root"
            ? root
            : all.find((row) => row.id === input.destinationId);
        if (!target?.directory) throw Error("Choose a destination folder.");
        const names = new Set<string>();
        for (const row of rows) {
          let ancestor: Entry | undefined = target;
          while (ancestor) {
            if (ancestor.id === row.id)
              throw Error("Choose a folder outside the selection.");
            const parentId: string = ancestor.parentId;
            ancestor = all.find((e) => e.id === parentId);
          }
          if (
            names.has(row.name) ||
            all.some(
              (e) =>
                e.id !== row.id &&
                e.parentId === target.id &&
                e.name === row.name,
            )
          )
            throw Error("The destination already contains a selected name.");
          names.add(row.name);
        }
        for (const row of rows)
          store.put({
            ...row,
            parentId: target.id,
            revision: revision(),
            modifiedAt: Date.now(),
          });
      } else throw Error("Choose a file operation.");
    });
    return {
      status: input.action === "move" ? "moved" : "deleted",
      message:
        input.action === "move" ? "Selection moved." : "Selection deleted.",
    };
  }
  async shareMany(input: {
    items: { id: string; expectedRevision: string }[];
  }) {
    const all = await this.storage.entries(),
      rows = this.batchRows(all, input.items),
      files: { path: string; bytes: Uint8Array<ArrayBuffer> }[] = [];
    const visit = async (row: Entry, path: string) => {
      if (row.directory) {
        files.push({ path: path + "/", bytes: new Uint8Array(0) });
        for (const child of all.filter((e) => e.parentId === row.id))
          await visit(child, path + "/" + child.name);
      } else {
        if (!row.blob) throw Error("File bytes unavailable.");
        files.push({
          path,
          bytes: new Uint8Array(await row.blob.arrayBuffer()),
        });
      }
    };
    for (const row of rows) await visit(row, row.name);
    const blob = fileArchive(files),
      url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = this.options.archiveName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { status: "opened", message: "Selection downloaded." };
  }
  async select(input: { id: string }) {
    const row = (await this.storage.entries()).find((e) => e.id === input.id);
    if (!row?.blob) throw Error("Choose a file.");
    const selectionId = crypto.randomUUID(),
      uri = URL.createObjectURL(row.blob);
    this.selection.set(selectionId, { id: row.id, revision: row.revision });
    this.urls.set(selectionId, uri);
    return {
      status: "selected",
      action: "files",
      selectionId,
      uri,
      name: row.name,
      mimeType: row.mimeType,
    };
  }
  private async selected(id: string) {
    const selected = this.selection.get(id),
      row = (await this.storage.entries()).find((e) => e.id === selected?.id);
    if (!row?.blob || row.revision !== selected?.revision)
      throw Error("Select this file again.");
    return { ...row, blob: row.blob };
  }
  async readSelected(input: { selectionId: string }) {
    const row = await this.selected(input.selectionId);
    if (row.size > 2_000_000)
      return {
        status: "large",
        message: "Open or download this file to read it.",
      };
    if (
      !row.mimeType.startsWith("text/") &&
      ![
        "application/json",
        "application/xml",
        "application/javascript",
      ].includes(row.mimeType)
    )
      return {
        status: "binary",
        message: "Open or download this file.",
        mimeType: row.mimeType,
        bytes: row.size,
      };
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        await row.blob.arrayBuffer(),
      );
      if (text.includes("\0"))
        return { status: "binary", message: "Open or download this file." };
      await this.selected(input.selectionId);
      return { status: "read", text, mimeType: row.mimeType, bytes: row.size };
    } catch (error) {
      if (error instanceof TypeError)
        return { status: "binary", message: "Open or download this file." };
      throw error;
    }
  }
  async pdfSelected(input: { selectionId: string; page: number }) {
    const row = await this.selected(input.selectionId);
    if (
      row.mimeType !== "application/pdf" ||
      !Number.isInteger(input.page) ||
      input.page < 0
    )
      throw Error("Choose a PDF page.");
    const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist");
    GlobalWorkerOptions.workerSrc = this.options.pdfWorkerUrl;
    const task = getDocument({
      data: new Uint8Array(await row.blob.arrayBuffer()),
      cMapUrl: this.options.pdfAssetsBase + "cmaps/",
      cMapPacked: true,
      standardFontDataUrl: this.options.pdfAssetsBase + "standard_fonts/",
      wasmUrl: this.options.pdfAssetsBase + "wasm/",
    });
    try {
      const pdf = await task.promise;
      if (input.page >= pdf.numPages) throw Error("Choose a PDF page.");
      const page = await pdf.getPage(input.page + 1),
        base = page.getViewport({ scale: 1 }),
        viewport = page.getViewport({
          scale: Math.min(2, 1200 / base.width, 1600 / base.height),
        }),
        canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
      await this.selected(input.selectionId);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value ? resolve(value) : reject(Error("Page rendering failed.")),
          "image/png",
        ),
      );
      await this.selected(input.selectionId);
      const previous = this.previews.get(input.selectionId);
      if (previous) URL.revokeObjectURL(previous);
      const imageUri = URL.createObjectURL(blob);
      this.previews.set(input.selectionId, imageUri);
      const content = await page.getTextContent();
      await this.selected(input.selectionId);
      const text = content.items
        .map((item) =>
          "str" in item
            ? item.str + ("hasEOL" in item && item.hasEOL ? "\n" : " ")
            : "",
        )
        .join("")
        .trim();
      return {
        status: "rendered",
        page: input.page,
        pageCount: pdf.numPages,
        imageUri,
        text,
      };
    } finally {
      await task.destroy();
    }
  }
  async attachment(input: { selectionId: string }) {
    const row = await this.selected(input.selectionId);
    if (row.size > 5 * 1024 * 1024) throw Error("Choose a file up to 5 MiB.");
    const bytes = new Uint8Array(await row.blob.arrayBuffer());
    await this.selected(input.selectionId);
    let raw = "";
    for (let i = 0; i < bytes.length; i += 16384)
      raw += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return { name: row.name, mimeType: row.mimeType, dataBase64: btoa(raw) };
  }
  async openSelected(input: { selectionId: string }) {
    const row = await this.selected(input.selectionId),
      url = this.urls.get(input.selectionId);
    if (!url) throw Error("Select this file again.");
    this.viewers.get(input.selectionId)?.();
    const close = this.options.openSelectedDocumentViewer(row.name, url, () => {
      if (this.viewers.get(input.selectionId) === close)
        this.viewers.delete(input.selectionId);
    });
    this.viewers.set(input.selectionId, close);
    return { status: "opened", message: "Document opened." };
  }
  async shareSelected(input: { selectionId: string }) {
    const row = await this.selected(input.selectionId),
      link = document.createElement("a");
    const url = this.urls.get(input.selectionId);
    if (!url) throw Error("Select this file again.");
    link.href = url;
    link.download = row.name;
    document.body.append(link);
    link.click();
    link.remove();
    return { status: "opened" };
  }
  async renameSelected(input: { selectionId: string; name: string }) {
    const row = await this.selected(input.selectionId);
    await this.rename({
      id: row.id,
      expectedRevision: row.revision,
      name: input.name,
    });
    await this.forgetSelected(input);
    return this.select({ id: row.id });
  }
  async forgetSelected(input: { selectionId: string }) {
    this.viewers.get(input.selectionId)?.();
    this.viewers.delete(input.selectionId);
    const url = this.urls.get(input.selectionId);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(input.selectionId);
    const preview = this.previews.get(input.selectionId);
    if (preview) URL.revokeObjectURL(preview);
    this.previews.delete(input.selectionId);
    this.selection.delete(input.selectionId);
  }
  async restoreSelected() {
    return { status: "cancelled", action: "files" };
  }
  async forget() {
    for (const id of this.selection.keys())
      await this.forgetSelected({ selectionId: id });
    return { status: "forgotten", message: "Folder closed." };
  }
}

/** Configure once per storage domain; constructors share storage but own their selections. */
export function createBrowserFiles(
  options: BrowserFilesOptions,
): new () => BrowserFiles {
  options = { ...options };
  const storage = createFileStorage(options);
  return class extends BrowserFiles {
    constructor() {
      super(options, storage);
    }
  };
}
