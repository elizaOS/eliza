import { googleApiFetch } from "./google-fetch.js";

// ---------------------------------------------------------------------------
// Drive v3 / Docs v1 / Sheets v4 REST endpoints
// ---------------------------------------------------------------------------

const DRIVE_FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";
const DOCS_ENDPOINT = "https://docs.googleapis.com/v1/documents";
const SHEETS_ENDPOINT = "https://sheets.googleapis.com/v4/spreadsheets";

// ---------------------------------------------------------------------------
// Typed API shapes
// ---------------------------------------------------------------------------

/** Minimal file metadata returned by Drive v3 list/get. */
export interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string | null;
  modifiedTime: string | null;
  size: string | null;
  webViewLink: string | null;
  parents: string[];
}

interface DriveFilesListResponse {
  files?: Array<{
    id?: string;
    name?: string;
    mimeType?: string;
    createdTime?: string;
    modifiedTime?: string;
    size?: string;
    webViewLink?: string;
    parents?: string[];
  }>;
  nextPageToken?: string;
}

interface DriveFileGetResponse {
  id?: string;
  name?: string;
  mimeType?: string;
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  parents?: string[];
}

// Docs v1 shapes (only what we need for plain-text extraction)

interface DocsStructuralElement {
  paragraph?: {
    elements?: Array<{
      textRun?: { content?: string };
    }>;
  };
}

interface DocsDocumentResponse {
  title?: string;
  body?: {
    content?: DocsStructuralElement[];
  };
}

// Sheets v4 shapes

interface SheetsSpreadsheetResponse {
  sheets?: Array<{
    properties?: { title?: string };
    data?: Array<{
      rowData?: Array<{
        values?: Array<{
          formattedValue?: string;
          userEnteredValue?: {
            stringValue?: string;
            numberValue?: number;
            boolValue?: boolean;
          };
        }>;
      }>;
    }>;
  }>;
}

// ---------------------------------------------------------------------------
// Drive field list
// ---------------------------------------------------------------------------

const FILE_FIELDS =
  "id,name,mimeType,createdTime,modifiedTime,size,webViewLink,parents";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

function normalizeDriveFile(raw: DriveFileGetResponse): GoogleDriveFile {
  return {
    id: raw.id ?? "",
    name: raw.name ?? "",
    mimeType: raw.mimeType ?? "",
    createdTime: raw.createdTime ?? null,
    modifiedTime: raw.modifiedTime ?? null,
    size: raw.size ?? null,
    webViewLink: raw.webViewLink ?? null,
    parents: raw.parents ?? [],
  };
}

function extractDocsPlainText(doc: DocsDocumentResponse): string {
  const parts: string[] = [];
  for (const element of doc.body?.content ?? []) {
    for (const pe of element.paragraph?.elements ?? []) {
      const text = pe.textRun?.content;
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join("");
}

function extractSheetRows(
  response: SheetsSpreadsheetResponse,
): string[][] {
  const rows: string[][] = [];
  for (const sheet of response.sheets ?? []) {
    for (const gridData of sheet.data ?? []) {
      for (const row of gridData.rowData ?? []) {
        const cells = (row.values ?? []).map((cell) => {
          if (cell.formattedValue !== undefined) {
            return cell.formattedValue;
          }
          const uev = cell.userEnteredValue;
          if (uev?.stringValue !== undefined) return uev.stringValue;
          if (uev?.numberValue !== undefined) return String(uev.numberValue);
          if (uev?.boolValue !== undefined) return String(uev.boolValue);
          return "";
        });
        rows.push(cells);
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Public client functions
// ---------------------------------------------------------------------------

/**
 * List files in a Drive folder (default: root, up to `maxResults`).
 * Uses Drive v3 files.list.
 */
export async function listDriveFiles(args: {
  accessToken: string;
  folderId?: string;
  maxResults?: number;
  pageToken?: string;
}): Promise<{ files: GoogleDriveFile[]; nextPageToken: string | null }> {
  const params = new URLSearchParams({
    fields: `nextPageToken,files(${FILE_FIELDS})`,
    pageSize: String(Math.min(Math.max(1, args.maxResults ?? 20), 100)),
    orderBy: "modifiedTime desc",
  });
  if (args.folderId) {
    params.set("q", `'${args.folderId}' in parents and trashed = false`);
  } else {
    params.set("q", "trashed = false");
  }
  if (args.pageToken) {
    params.set("pageToken", args.pageToken);
  }

  const response = await googleApiFetch(
    `${DRIVE_FILES_ENDPOINT}?${params.toString()}`,
    { headers: authHeaders(args.accessToken) },
  );
  const body = (await response.json()) as DriveFilesListResponse;
  return {
    files: (body.files ?? []).map(normalizeDriveFile),
    nextPageToken: body.nextPageToken ?? null,
  };
}

/**
 * Get file metadata for a single Drive file by ID.
 */
export async function getDriveFile(args: {
  accessToken: string;
  fileId: string;
}): Promise<GoogleDriveFile> {
  const params = new URLSearchParams({ fields: FILE_FIELDS });
  const response = await googleApiFetch(
    `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(args.fileId)}?${params.toString()}`,
    { headers: authHeaders(args.accessToken) },
  );
  const body = (await response.json()) as DriveFileGetResponse;
  return normalizeDriveFile(body);
}

/**
 * Full-text search across Drive using Drive v3 query syntax.
 * `query` is passed directly as the Drive API `q` parameter value.
 */
export async function searchDriveFiles(args: {
  accessToken: string;
  query: string;
  maxResults?: number;
}): Promise<{ files: GoogleDriveFile[]; nextPageToken: string | null }> {
  const params = new URLSearchParams({
    fields: `nextPageToken,files(${FILE_FIELDS})`,
    pageSize: String(Math.min(Math.max(1, args.maxResults ?? 20), 100)),
    orderBy: "modifiedTime desc",
    q: `(${args.query}) and trashed = false`,
  });

  const response = await googleApiFetch(
    `${DRIVE_FILES_ENDPOINT}?${params.toString()}`,
    { headers: authHeaders(args.accessToken) },
  );
  const body = (await response.json()) as DriveFilesListResponse;
  return {
    files: (body.files ?? []).map(normalizeDriveFile),
    nextPageToken: body.nextPageToken ?? null,
  };
}

/**
 * Read a Google Doc body as plain text via Docs v1 documents.get.
 */
export async function getDocContent(args: {
  accessToken: string;
  documentId: string;
}): Promise<{ title: string; plainText: string }> {
  const response = await googleApiFetch(
    `${DOCS_ENDPOINT}/${encodeURIComponent(args.documentId)}`,
    { headers: authHeaders(args.accessToken) },
  );
  const doc = (await response.json()) as DocsDocumentResponse;
  return {
    title: doc.title ?? "",
    plainText: extractDocsPlainText(doc),
  };
}

/**
 * Read a Google Sheet as a 2-D array of strings via Sheets v4 spreadsheets.get.
 * `range` is optional A1 notation; when absent the full first sheet is returned.
 */
export async function getSheetContent(args: {
  accessToken: string;
  spreadsheetId: string;
  range?: string;
}): Promise<{ title: string; rows: string[][] }> {
  const params = new URLSearchParams({ includeGridData: "true" });
  if (args.range) {
    params.set("ranges", args.range);
  }
  const response = await googleApiFetch(
    `${SHEETS_ENDPOINT}/${encodeURIComponent(args.spreadsheetId)}?${params.toString()}`,
    { headers: authHeaders(args.accessToken) },
  );
  const data = (await response.json()) as SheetsSpreadsheetResponse;
  return {
    title: data.sheets?.[0]?.properties?.title ?? "",
    rows: extractSheetRows(data),
  };
}

/**
 * Create a new Drive file.
 *
 * - Pass `content` as a string for text files or `Uint8Array` for binary.
 * - Omit `content` to create a Google-native type (Docs, Sheets, etc.) with no body.
 * - `mimeType` must be a valid Google MIME type or media type.
 */
export async function createDriveFile(args: {
  accessToken: string;
  name: string;
  mimeType: string;
  content?: string | Uint8Array;
  parentFolderId?: string;
}): Promise<GoogleDriveFile> {
  const metadata: Record<string, unknown> = {
    name: args.name,
    mimeType: args.mimeType,
  };
  if (args.parentFolderId) {
    metadata.parents = [args.parentFolderId];
  }

  if (args.content === undefined) {
    // Metadata-only creation: Google-native types (Docs, Sheets, Forms …)
    const response = await googleApiFetch(
      `${DRIVE_FILES_ENDPOINT}?fields=${FILE_FIELDS}`,
      {
        method: "POST",
        headers: {
          ...authHeaders(args.accessToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(metadata),
      },
    );
    return normalizeDriveFile((await response.json()) as DriveFileGetResponse);
  }

  // Multipart upload for files with content
  const boundary = `boundary_${Date.now().toString(36)}`;
  const metaPart = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    "",
  ].join("\r\n");

  const contentMimeType =
    typeof args.content === "string"
      ? "text/plain; charset=UTF-8"
      : args.mimeType;

  let requestBody: BodyInit;
  if (typeof args.content === "string") {
    requestBody =
      metaPart +
      [`--${boundary}`, `Content-Type: ${contentMimeType}`, "", args.content, `--${boundary}--`].join(
        "\r\n",
      );
  } else {
    const enc = new TextEncoder();
    const header = enc.encode(
      `${metaPart}--${boundary}\r\nContent-Type: ${contentMimeType}\r\n\r\n`,
    );
    const footer = enc.encode(`\r\n--${boundary}--`);
    const merged = new Uint8Array(
      header.length + args.content.length + footer.length,
    );
    merged.set(header, 0);
    merged.set(args.content, header.length);
    merged.set(footer, header.length + args.content.length);
    requestBody = merged;
  }

  const params = new URLSearchParams({
    uploadType: "multipart",
    fields: FILE_FIELDS,
  });
  const response = await googleApiFetch(
    `https://www.googleapis.com/upload/drive/v3/files?${params.toString()}`,
    {
      method: "POST",
      headers: {
        ...authHeaders(args.accessToken),
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: requestBody,
    },
  );
  return normalizeDriveFile((await response.json()) as DriveFileGetResponse);
}

/**
 * Append plain text to an existing Google Doc via Docs v1 batchUpdate.
 * Text is inserted at the end of the document body.
 */
export async function appendToDoc(args: {
  accessToken: string;
  documentId: string;
  text: string;
}): Promise<void> {
  await googleApiFetch(
    `${DOCS_ENDPOINT}/${encodeURIComponent(args.documentId)}:batchUpdate`,
    {
      method: "POST",
      headers: {
        ...authHeaders(args.accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [
          {
            insertText: {
              text: args.text,
              endOfSegmentLocation: { segmentId: "" },
            },
          },
        ],
      }),
    },
  );
}

/**
 * Update cells in a Google Sheet via Sheets v4 values.update.
 * `range` must be A1 notation, e.g. `"Sheet1!A1:C3"`.
 * `values` is a 2-D array of strings/numbers to write.
 */
export async function updateSheetCells(args: {
  accessToken: string;
  spreadsheetId: string;
  range: string;
  values: ReadonlyArray<ReadonlyArray<string | number>>;
}): Promise<{ updatedRange: string; updatedCells: number }> {
  const params = new URLSearchParams({ valueInputOption: "USER_ENTERED" });
  const response = await googleApiFetch(
    `${SHEETS_ENDPOINT}/${encodeURIComponent(args.spreadsheetId)}/values/${encodeURIComponent(args.range)}?${params.toString()}`,
    {
      method: "PUT",
      headers: {
        ...authHeaders(args.accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        range: args.range,
        majorDimension: "ROWS",
        values: args.values,
      }),
    },
  );
  const data = (await response.json()) as {
    updatedRange?: string;
    updatedCells?: number;
  };
  return {
    updatedRange: data.updatedRange ?? args.range,
    updatedCells: data.updatedCells ?? 0,
  };
}
