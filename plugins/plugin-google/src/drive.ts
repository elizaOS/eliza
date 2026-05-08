import type { drive_v3 } from "googleapis";
import type { GoogleApiClientFactory } from "./client-factory.js";
import type { GoogleAccountRef, GoogleDriveFile } from "./types.js";

const DRIVE_FILE_FIELDS = "id,name,mimeType,createdTime,webViewLink,modifiedTime,size,parents";

export class GoogleDriveClient {
  constructor(private readonly clientFactory: GoogleApiClientFactory) {}

  async searchFiles(
    params: GoogleAccountRef & { query: string; limit?: number }
  ): Promise<GoogleDriveFile[]> {
    const drive = await this.clientFactory.drive(params, ["drive.read"], "drive.searchFiles");
    const response = await drive.files.list({
      q: params.query,
      pageSize: params.limit ?? 25,
      orderBy: "modifiedTime desc",
      fields: `files(${DRIVE_FILE_FIELDS})`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    return (response.data.files ?? []).map(mapDriveFile);
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
