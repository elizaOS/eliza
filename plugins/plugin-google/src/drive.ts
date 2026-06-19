import type { docs_v1, drive_v3, sheets_v4 } from "googleapis";
import type { GoogleApiClientFactory } from "./client-factory.js";
import type {
  GoogleAccountRef,
  GoogleDocContent,
  GoogleDriveCreateFileInput,
  GoogleDriveFile,
  GoogleDriveFileList,
  GoogleSheetContent,
  GoogleSheetUpdateResult,
} from "./types.js";

const DRIVE_FILE_FIELDS = "id,name,mimeType,createdTime,webViewLink,modifiedTime,size,parents";

export class GoogleDriveClient {
  constructor(private readonly clientFactory: GoogleApiClientFactory) {}

  async searchFiles(
    params: GoogleAccountRef & { query: string; limit?: number }
  ): Promise<GoogleDriveFile[]> {
    const response = await this.searchDriveFiles({
      accountId: params.accountId,
      query: params.query,
      maxResults: params.limit,
    });
    return response.files;
  }

  async getFile(params: GoogleAccountRef & { fileId: string }): Promise<GoogleDriveFile> {
    const drive = await this.clientFactory.drive(params, ["drive.read"], "drive.getFile");
    const response = await drive.files.get({
      fileId: params.fileId,
      fields: DRIVE_FILE_FIELDS,
      supportsAllDrives: true,
    });

    return mapDriveFile(response.data);
  }

  async listDriveFiles(
    params: GoogleAccountRef & { folderId?: string; maxResults?: number; pageToken?: string }
  ): Promise<GoogleDriveFileList> {
    const drive = await this.clientFactory.drive(params, ["drive.read"], "drive.listFiles");
    const response = await drive.files.list({
      q: params.folderId
        ? `'${escapeDriveQuery(params.folderId)}' in parents and trashed = false`
        : "trashed = false",
      pageSize: normalizedPageSize(params.maxResults),
      pageToken: params.pageToken,
      orderBy: "modifiedTime desc",
      fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    return {
      files: (response.data.files ?? []).map(mapDriveFile),
      nextPageToken: response.data.nextPageToken ?? null,
    };
  }

  async searchDriveFiles(
    params: GoogleAccountRef & { query: string; maxResults?: number; pageToken?: string }
  ): Promise<GoogleDriveFileList> {
    const drive = await this.clientFactory.drive(params, ["drive.read"], "drive.searchDriveFiles");
    const response = await drive.files.list({
      q: driveQuery(params.query),
      pageSize: normalizedPageSize(params.maxResults),
      pageToken: params.pageToken,
      orderBy: "modifiedTime desc",
      fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    return {
      files: (response.data.files ?? []).map(mapDriveFile),
      nextPageToken: response.data.nextPageToken ?? null,
    };
  }

  async getDocContent(
    params: GoogleAccountRef & { documentId: string }
  ): Promise<GoogleDocContent> {
    const docs = await this.clientFactory.docs(params, ["drive.read"], "drive.getDocContent");
    const response = await docs.documents.get({
      documentId: params.documentId,
    });
    return {
      title: response.data.title ?? "",
      plainText: extractDocsPlainText(response.data),
    };
  }

  async getSheetContent(
    params: GoogleAccountRef & { spreadsheetId: string; range?: string }
  ): Promise<GoogleSheetContent> {
    const sheets = await this.clientFactory.sheets(params, ["drive.read"], "drive.getSheetContent");
    const response = await sheets.spreadsheets.get({
      spreadsheetId: params.spreadsheetId,
      includeGridData: true,
      ranges: params.range ? [params.range] : undefined,
    });
    return {
      title: response.data.sheets?.[0]?.properties?.title ?? "",
      rows: extractSheetRows(response.data),
    };
  }

  async createDriveFile(params: GoogleDriveCreateFileInput): Promise<GoogleDriveFile> {
    const drive = await this.clientFactory.drive(params, ["drive.write"], "drive.createFile");
    const requestBody: drive_v3.Schema$File = {
      name: params.name,
      mimeType: params.mimeType,
      parents: params.parentFolderId ? [params.parentFolderId] : undefined,
    };

    if (params.content === undefined) {
      const response = await drive.files.create({
        requestBody,
        fields: DRIVE_FILE_FIELDS,
        supportsAllDrives: true,
      });
      return mapDriveFile(response.data);
    }

    const response = await drive.files.create({
      requestBody,
      media: {
        mimeType:
          typeof params.content === "string" ? "text/plain; charset=UTF-8" : params.mimeType,
        body: typeof params.content === "string" ? params.content : Buffer.from(params.content),
      },
      fields: DRIVE_FILE_FIELDS,
      supportsAllDrives: true,
    });
    return mapDriveFile(response.data);
  }

  async appendToDoc(
    params: GoogleAccountRef & { documentId: string; text: string }
  ): Promise<void> {
    const docs = await this.clientFactory.docs(params, ["drive.write"], "drive.appendToDoc");
    await docs.documents.batchUpdate({
      documentId: params.documentId,
      requestBody: {
        requests: [
          {
            insertText: {
              text: params.text,
              endOfSegmentLocation: { segmentId: "" },
            },
          },
        ],
      },
    });
  }

  async updateSheetCells(
    params: GoogleAccountRef & {
      spreadsheetId: string;
      range: string;
      values: ReadonlyArray<ReadonlyArray<string | number>>;
    }
  ): Promise<GoogleSheetUpdateResult> {
    const sheets = await this.clientFactory.sheets(
      params,
      ["drive.write"],
      "drive.updateSheetCells"
    );
    const response = await sheets.spreadsheets.values.update({
      spreadsheetId: params.spreadsheetId,
      range: params.range,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        range: params.range,
        majorDimension: "ROWS",
        values: params.values.map((row) => [...row]),
      },
    });
    return {
      updatedRange: response.data.updatedRange ?? params.range,
      updatedCells: response.data.updatedCells ?? 0,
    };
  }
}

function mapDriveFile(file: drive_v3.Schema$File): GoogleDriveFile {
  return {
    id: file.id ?? "",
    name: file.name ?? "",
    mimeType: file.mimeType ?? undefined,
    createdTime: file.createdTime ?? undefined,
    webViewLink: file.webViewLink ?? undefined,
    modifiedTime: file.modifiedTime ?? undefined,
    size: file.size ?? undefined,
    parents: file.parents ?? undefined,
  };
}

function normalizedPageSize(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 25;
  }
  return Math.min(Math.trunc(value), 100);
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function driveQuery(query: string): string {
  const trimmed = query.trim();
  if (/\btrashed\s*=/.test(trimmed)) {
    return trimmed;
  }
  return `(${trimmed}) and trashed = false`;
}

function extractDocsPlainText(doc: docs_v1.Schema$Document): string {
  const parts: string[] = [];
  for (const element of doc.body?.content ?? []) {
    for (const paragraphElement of element.paragraph?.elements ?? []) {
      const text = paragraphElement.textRun?.content;
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join("");
}

function extractSheetRows(response: sheets_v4.Schema$Spreadsheet): string[][] {
  const rows: string[][] = [];
  for (const sheet of response.sheets ?? []) {
    for (const gridData of sheet.data ?? []) {
      for (const row of gridData.rowData ?? []) {
        const cells: string[] = (row.values ?? []).map((cell): string => {
          if (cell.formattedValue !== undefined && cell.formattedValue !== null) {
            return String(cell.formattedValue);
          }
          const value = cell.userEnteredValue;
          if (value?.stringValue !== undefined && value.stringValue !== null) {
            return String(value.stringValue);
          }
          if (value?.numberValue !== undefined && value.numberValue !== null) {
            return String(value.numberValue);
          }
          if (value?.boolValue !== undefined && value.boolValue !== null) {
            return String(value.boolValue);
          }
          return "";
        });
        rows.push(cells);
      }
    }
  }
  return rows;
}
