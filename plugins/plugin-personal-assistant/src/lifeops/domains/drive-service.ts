/**
 * Google Drive domain for LifeOps: maps the owner's Drive files and required
 * OAuth scopes from `@elizaos/plugin-google` into the assistant's connector
 * status/grant DTOs. Drive API calls live in the google plugin.
 */
import type { GoogleDriveFile } from "@elizaos/plugin-google";
import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
} from "@elizaos/shared";
import type {
  LifeOpsConnectorGrant,
  LifeOpsGoogleConnectorStatus,
} from "../../contracts/index.js";
import {
  accountIdForGrant,
  requireGoogleServiceMethod,
} from "../google-plugin-delegates.js";
import type { LifeOpsContext } from "../lifeops-context.js";
import { fail } from "../service-normalize.js";
import {
  normalizeOptionalConnectorMode,
  normalizeOptionalConnectorSide,
} from "../service-normalize-connector.js";

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

/**
 * Dependency owned by the `google` domain (`withGoogle`) rather than living on
 * {@link LifeOpsContext}. Injected as a typed callback wired from the composed
 * service instance.
 */
type DriveDomainDeps = {
  getGoogleConnectorStatus(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsGoogleConnectorStatus>;
};

function hasDriveRead(grant: LifeOpsConnectorGrant): boolean {
  const scopes = new Set(grant.grantedScopes);
  return (
    scopes.has(GOOGLE_DRIVE_WRITE_SCOPE) ||
    scopes.has(GOOGLE_DRIVE_READ_SCOPE) ||
    scopes.has(GOOGLE_DRIVE_FILE_SCOPE) ||
    grant.capabilities.includes("google.drive.read") ||
    grant.capabilities.includes("google.drive.write")
  );
}

function hasDriveWrite(grant: LifeOpsConnectorGrant): boolean {
  const scopes = new Set(grant.grantedScopes);
  return (
    scopes.has(GOOGLE_DRIVE_WRITE_SCOPE) ||
    scopes.has(GOOGLE_DRIVE_FILE_SCOPE) ||
    grant.capabilities.includes("google.drive.write")
  );
}

/**
 * Google Drive / Docs / Sheets reads and writes backed by
 * `@elizaos/plugin-google`. Depends on the `google` domain's
 * `getGoogleConnectorStatus` injected via {@link DriveDomainDeps}; Drive grant
 * resolution itself is owned by this domain.
 */
export class DriveDomain {
  constructor(
    private readonly ctx: LifeOpsContext,
    private readonly deps: DriveDomainDeps,
  ) {}

  public async requireGoogleDriveReadGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsConnectorGrant> {
    const status = await this.deps.getGoogleConnectorStatus(
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
  ): Promise<LifeOpsConnectorGrant> {
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
      this.ctx.runtime,
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
    const getFile = requireGoogleServiceMethod(this.ctx.runtime, "getFile");
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
      this.ctx.runtime,
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
      this.ctx.runtime,
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
      this.ctx.runtime,
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
      this.ctx.runtime,
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
      this.ctx.runtime,
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
      this.ctx.runtime,
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
