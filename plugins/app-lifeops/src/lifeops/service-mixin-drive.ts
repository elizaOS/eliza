<<<<<<< HEAD
// @ts-nocheck — Mixin pattern: see service.ts for the composed public type.

import type { GoogleDriveFile } from "@elizaos/plugin-google";
import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
} from "@elizaos/shared";
=======
import type { LifeOpsConnectorMode, LifeOpsConnectorSide } from "@elizaos/shared";
import type { GoogleDriveFile } from "@elizaos/plugin-google";
import type {
  LifeOpsConnectorGrant,
  LifeOpsGoogleConnectorStatus,
} from "../contracts/index.js";
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
import {
  accountIdForGrant,
  requireGoogleServiceMethod,
} from "./google-plugin-delegates.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";
import {
  normalizeOptionalConnectorMode,
  normalizeOptionalConnectorSide,
} from "./service-normalize-connector.js";

export type { GoogleDriveFile };

export const GOOGLE_DRIVE_READ_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly";
export const GOOGLE_DRIVE_WRITE_SCOPE = "https://www.googleapis.com/auth/drive";
export const GOOGLE_DRIVE_FILE_SCOPE =
  "https://www.googleapis.com/auth/drive.file";

export const DRIVE_CONNECTOR_CAPABILITIES = {
  inbound: false,
  outbound: true,
  search: true,
  identity: true,
  attachments: true,
  deliveryStatus: false,
} as const;

<<<<<<< HEAD
function hasDriveRead(grant: {
  grantedScopes: string[];
  capabilities: string[];
}): boolean {
=======
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

type DriveMixinDependencies = LifeOpsServiceBase & {
  getGoogleConnectorStatus(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsGoogleConnectorStatus>;
};

function hasDriveRead(grant: LifeOpsConnectorGrant): boolean {
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
  const scopes = new Set(grant.grantedScopes);
  return (
    scopes.has(GOOGLE_DRIVE_WRITE_SCOPE) ||
    scopes.has(GOOGLE_DRIVE_READ_SCOPE) ||
    scopes.has(GOOGLE_DRIVE_FILE_SCOPE) ||
    grant.capabilities.includes("google.drive.read") ||
    grant.capabilities.includes("google.drive.write")
  );
}

<<<<<<< HEAD
function hasDriveWrite(grant: {
  grantedScopes: string[];
  capabilities: string[];
}): boolean {
=======
function hasDriveWrite(grant: LifeOpsConnectorGrant): boolean {
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
  const scopes = new Set(grant.grantedScopes);
  return (
    scopes.has(GOOGLE_DRIVE_WRITE_SCOPE) ||
    scopes.has(GOOGLE_DRIVE_FILE_SCOPE) ||
    grant.capabilities.includes("google.drive.write")
  );
}

/** @internal */
export function withDrive<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsDriveService> {
  const DriveBase = Base as unknown as Constructor<DriveMixinDependencies>;

  class LifeOpsDriveServiceMixin extends DriveBase {
    public async requireGoogleDriveReadGrant(
      requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      grantId?: string,
    ) {
      const status = await this.getGoogleConnectorStatus(
        requestUrl,
        normalizeOptionalConnectorMode(requestedMode, "mode"),
        normalizeOptionalConnectorSide(requestedSide, "side"),
        grantId,
      );
      const grant = status.grant;
      if (!status.connected || !grant) {
        fail(409, "Google Drive is not connected.");
      }
      if (!hasDriveRead(grant)) {
        fail(
          403,
          "Google Drive read access has not been granted. Reconnect Google through @elizaos/plugin-google with Drive scope.",
        );
      }
      return grant;
    }

    public async requireGoogleDriveWriteGrant(
      requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      grantId?: string,
    ) {
      const grant = await this.requireGoogleDriveReadGrant(
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      );
      if (!hasDriveWrite(grant)) {
        fail(
          403,
          "Google Drive write access has not been granted. Reconnect Google through @elizaos/plugin-google with Drive write scope.",
        );
      }
      return grant;
    }

    async listDriveFiles(
      requestUrl: URL,
      request: {
        mode?: LifeOpsConnectorMode;
        side?: LifeOpsConnectorSide;
        grantId?: string;
        folderId?: string;
        maxResults?: number;
        pageToken?: string;
      } = {},
    ): Promise<{ files: GoogleDriveFile[]; nextPageToken: string | null }> {
      const grant = await this.requireGoogleDriveReadGrant(
        requestUrl,
        request.mode,
        request.side,
        request.grantId,
      );
      const searchFiles = requireGoogleServiceMethod(
        this.runtime,
        "searchFiles",
      );
      const query = request.folderId
        ? `'${request.folderId}' in parents and trashed = false`
        : "'root' in parents and trashed = false";
      const files = await searchFiles({
        accountId: accountIdForGrant(grant),
        query,
        limit: request.maxResults,
      });
      return { files, nextPageToken: null };
    }

    async getDriveFile(
      requestUrl: URL,
      request: {
        mode?: LifeOpsConnectorMode;
        side?: LifeOpsConnectorSide;
        grantId?: string;
        fileId: string;
      },
    ): Promise<GoogleDriveFile> {
      const grant = await this.requireGoogleDriveReadGrant(
        requestUrl,
        request.mode,
        request.side,
        request.grantId,
      );
      const getFile = requireGoogleServiceMethod(this.runtime, "getFile");
      return getFile({
        accountId: accountIdForGrant(grant),
        fileId: request.fileId,
      });
    }

    async searchDriveFiles(
      requestUrl: URL,
      request: {
        mode?: LifeOpsConnectorMode;
        side?: LifeOpsConnectorSide;
        grantId?: string;
        query: string;
        maxResults?: number;
      },
    ): Promise<{ files: GoogleDriveFile[]; nextPageToken: string | null }> {
      const grant = await this.requireGoogleDriveReadGrant(
        requestUrl,
        request.mode,
        request.side,
        request.grantId,
      );
      const searchFiles = requireGoogleServiceMethod(
        this.runtime,
        "searchFiles",
      );
      const files = await searchFiles({
        accountId: accountIdForGrant(grant),
        query: request.query,
        limit: request.maxResults,
      });
      return { files, nextPageToken: null };
    }

    async getDocContent(
      requestUrl: URL,
      request: {
        mode?: LifeOpsConnectorMode;
        side?: LifeOpsConnectorSide;
        grantId?: string;
        documentId: string;
      },
    ): Promise<{ title: string; plainText: string }> {
      const grant = await this.requireGoogleDriveReadGrant(
        requestUrl,
        request.mode,
        request.side,
        request.grantId,
      );
      const getDocContent = requireGoogleServiceMethod(
        this.runtime,
        "getDocContent",
      );
      return getDocContent({
        accountId: accountIdForGrant(grant),
        documentId: request.documentId,
      });
    }

    async getSheetContent(
      requestUrl: URL,
      request: {
        mode?: LifeOpsConnectorMode;
        side?: LifeOpsConnectorSide;
        grantId?: string;
        spreadsheetId: string;
        range?: string;
      },
    ): Promise<{ title: string; rows: string[][] }> {
      const grant = await this.requireGoogleDriveReadGrant(
        requestUrl,
        request.mode,
        request.side,
        request.grantId,
      );
      const getSheetContent = requireGoogleServiceMethod(
        this.runtime,
        "getSheetContent",
      );
      return getSheetContent({
        accountId: accountIdForGrant(grant),
        spreadsheetId: request.spreadsheetId,
        range: request.range,
      });
    }

    async createDriveFile(
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
    ): Promise<GoogleDriveFile> {
      const grant = await this.requireGoogleDriveWriteGrant(
        requestUrl,
        request.mode,
        request.side,
        request.grantId,
      );
      const createDriveFile = requireGoogleServiceMethod(
        this.runtime,
        "createDriveFile",
      );
      return createDriveFile({
        accountId: accountIdForGrant(grant),
        name: request.name,
        mimeType: request.mimeType,
        content: request.content,
        parentFolderId: request.parentFolderId,
      });
    }

    async appendToDoc(
      requestUrl: URL,
      request: {
        mode?: LifeOpsConnectorMode;
        side?: LifeOpsConnectorSide;
        grantId?: string;
        documentId: string;
        text: string;
      },
    ): Promise<void> {
      const grant = await this.requireGoogleDriveWriteGrant(
        requestUrl,
        request.mode,
        request.side,
        request.grantId,
      );
      const appendToDoc = requireGoogleServiceMethod(
        this.runtime,
        "appendToDoc",
      );
      await appendToDoc({
        accountId: accountIdForGrant(grant),
        documentId: request.documentId,
        text: request.text,
      });
    }

    async updateSheetCells(
      requestUrl: URL,
      request: {
        mode?: LifeOpsConnectorMode;
        side?: LifeOpsConnectorSide;
        grantId?: string;
        spreadsheetId: string;
        range: string;
        values: ReadonlyArray<ReadonlyArray<string | number>>;
      },
    ): Promise<{ updatedRange: string; updatedCells: number }> {
      const grant = await this.requireGoogleDriveWriteGrant(
        requestUrl,
        request.mode,
        request.side,
        request.grantId,
      );
      const updateSheetCells = requireGoogleServiceMethod(
        this.runtime,
        "updateSheetCells",
      );
      return updateSheetCells({
        accountId: accountIdForGrant(grant),
        spreadsheetId: request.spreadsheetId,
        range: request.range,
        values: request.values,
      });
    }
  }

  return LifeOpsDriveServiceMixin as unknown as MixinClass<
    TBase,
    LifeOpsDriveService
  >;
}
