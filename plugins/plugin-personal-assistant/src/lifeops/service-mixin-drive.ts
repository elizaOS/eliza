/**
 * Google Drive service mixin: declares the LifeOps Drive service surface and the
 * `withDrive` mixin that composes the Drive domain's file and connector-scope
 * methods onto the LifeOpsService base.
 */
import type { GoogleDriveFile } from "@elizaos/plugin-google";
import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
} from "@elizaos/shared";
import type { LifeOpsConnectorGrant } from "../contracts/index.js";

export {
  DRIVE_CONNECTOR_CAPABILITIES,
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_READ_SCOPE,
  GOOGLE_DRIVE_WRITE_SCOPE,
} from "./domains/drive-service.js";
export type { GoogleDriveFile };

export interface LifeOpsDriveService {
  requireGoogleDriveReadGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsConnectorGrant>;
  requireGoogleDriveWriteGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsConnectorGrant>;
  listDriveFiles(
    requestUrl: URL,
    request?: {
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      grantId?: string;
      folderId?: string;
      maxResults?: number;
      pageToken?: string;
    },
  ): Promise<{ files: GoogleDriveFile[]; nextPageToken: string | null }>;
  getDriveFile(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      grantId?: string;
      fileId: string;
    },
  ): Promise<GoogleDriveFile>;
  searchDriveFiles(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      grantId?: string;
      query: string;
      maxResults?: number;
    },
  ): Promise<{ files: GoogleDriveFile[]; nextPageToken: string | null }>;
  getDocContent(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      grantId?: string;
      documentId: string;
    },
  ): Promise<{ title: string; plainText: string }>;
  getSheetContent(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      grantId?: string;
      spreadsheetId: string;
      range?: string;
    },
  ): Promise<{ title: string; rows: string[][] }>;
  createDriveFile(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      grantId?: string;
      name: string;
      mimeType: string;
      content?: string | Uint8Array;
      parentFolderId?: string;
    },
  ): Promise<GoogleDriveFile>;
  appendToDoc(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      grantId?: string;
      documentId: string;
      text: string;
    },
  ): Promise<void>;
  updateSheetCells(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      grantId?: string;
      spreadsheetId: string;
      range: string;
      values: ReadonlyArray<ReadonlyArray<string | number>>;
    },
  ): Promise<{ updatedRange: string; updatedCells: number }>;
}
