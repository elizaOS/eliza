import type { NoteFormat } from "./types.js";

/**
 * Notes folders. The device owns the folder list; the agent stores only each
 * note's `format.data.folderId`. A host that has folders sends the current
 * list with each chat message in `content.metadata.notesFolders`, so the agent
 * can name a folder without keeping a second copy of the list.
 */
export const NOTE_FOLDERS_METADATA_KEY = "notesFolders";
export const NOTE_FOLDER_LIMIT = 100;
export const NOTE_FOLDER_NAME_MAX = 40;
const NOTE_FOLDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface NoteFolder {
  id: string;
  name: string;
}

const folderName = (value: string) => value.replace(/\s+/gu, " ").trim();
const folderKey = (name: string) =>
  folderName(name).normalize("NFKC").toLowerCase();

/**
 * The folder list this message carries. `undefined` means the host sent no
 * usable list: a host without folders, or a list that breaks the contract. It
 * never reads as "no folders exist".
 */
export function readNoteFolders(metadata: unknown): NoteFolder[] | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return undefined;
  const list = (metadata as Record<string, unknown>)[NOTE_FOLDERS_METADATA_KEY];
  if (!Array.isArray(list) || list.length > NOTE_FOLDER_LIMIT) return undefined;
  const ids = new Set<string>();
  const names = new Set<string>();
  const folders: NoteFolder[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
    const { id, name: rawName } = row as Record<string, unknown>;
    if (typeof id !== "string" || typeof rawName !== "string") return undefined;
    const name = folderName(rawName);
    if (
      !NOTE_FOLDER_ID.test(id) ||
      !name ||
      name.length > NOTE_FOLDER_NAME_MAX ||
      name.includes("\0") ||
      ids.has(id) ||
      names.has(folderKey(name))
    )
      return undefined;
    ids.add(id);
    names.add(folderKey(name));
    folders.push({ id, name });
  }
  return folders;
}

/** Folders are addressed by name; case and spacing differences do not matter. */
export function findNoteFolder(
  folders: readonly NoteFolder[],
  name: string,
): NoteFolder | undefined {
  const wanted = folderKey(name);
  return folders.find((folder) => folderKey(folder.name) === wanted);
}

export function noteFolderId(
  format: NoteFormat | undefined,
): string | undefined {
  const id = format?.data.folderId;
  return typeof id === "string" ? id : undefined;
}

/** The note's format with its folder set, or cleared when `folderId` is null. */
export function withNoteFolder(
  format: NoteFormat | undefined,
  folderId: string | null,
): NoteFormat {
  const { folderId: _current, ...data } = format?.data ?? {};
  return {
    kind: format?.kind ?? "text",
    data: folderId === null ? data : { ...data, folderId },
  };
}
