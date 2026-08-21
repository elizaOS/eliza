/**
 * Domain contracts for the Dropbox provider adapter. Every service method is
 * account-scoped (`DropboxAccountRef`), listings and search results carry a
 * deterministic dropbox.com deep link for citations, and credential resolution
 * is pluggable via `DropboxCredentialResolver` (Dropbox access tokens are
 * short-lived, so the resolver owns refresh).
 */

export const DROPBOX_SERVICE_NAME = "dropbox";

/** All Dropbox API calls are account-scoped; there is no single-account shortcut. */
export interface DropboxAccountRef {
  accountId: string;
}

export interface DropboxResolvedCredential {
  accessToken: string;
  dropboxAccountId?: string;
}

export interface DropboxCredentialResolver {
  getCredential(request: DropboxAccountRef): Promise<DropboxResolvedCredential>;
}

export interface DropboxEntry {
  /** "file" | "folder" | "deleted" per the wire `.tag`. */
  kind: "file" | "folder" | "deleted";
  id: string;
  name: string;
  /** Lower-cased canonical path, e.g. "/reports/q3.pdf". */
  pathLower: string;
  pathDisplay: string;
  /** dropbox.com browse deep link for citations. */
  url: string;
  size?: number;
  clientModified?: string;
  serverModified?: string;
  contentHash?: string;
}

export interface DropboxListPage {
  entries: DropboxEntry[];
  cursor: string | null;
  hasMore: boolean;
}

export interface DropboxFileText {
  entry: DropboxEntry;
  /** UTF-8 decoded content. Only offered for text-like files under the size cap. */
  text: string;
}

export interface DropboxUploadInput extends DropboxAccountRef {
  /** Absolute destination path, e.g. "/notes/today.md". */
  path: string;
  content: string | Uint8Array;
  /** "add" fails on conflict; "overwrite" replaces. Defaults to "add". */
  mode?: "add" | "overwrite";
}

export interface IDropboxService {
  listFolder(
    params: DropboxAccountRef & { path?: string; cursor?: string; limit?: number }
  ): Promise<DropboxListPage>;
  search(
    params: DropboxAccountRef & { query: string; cursor?: string; limit?: number }
  ): Promise<DropboxListPage>;
  getMetadata(params: DropboxAccountRef & { path: string }): Promise<DropboxEntry>;
  downloadText(params: DropboxAccountRef & { path: string }): Promise<DropboxFileText>;
  upload(params: DropboxUploadInput): Promise<DropboxEntry>;
  getTemporaryLink(params: DropboxAccountRef & { path: string }): Promise<string>;
}
