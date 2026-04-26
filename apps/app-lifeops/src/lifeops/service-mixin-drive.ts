// @ts-nocheck — mixin: type safety is enforced on the composed class
import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
} from "@elizaos/shared";
import {
  resolveGoogleExecutionTarget,
} from "./google-connector-gateway.js";
import {
  appendToDoc,
  createDriveFile,
  getDriveFile,
  getDocContent,
  getSheetContent,
  listDriveFiles,
  searchDriveFiles,
  type GoogleDriveFile,
  updateSheetCells,
} from "./google-drive.js";
import {
  ensureFreshGoogleAccessToken,
} from "./google-oauth.js";
import { fail } from "./service-normalize.js";
import {
  normalizeOptionalConnectorMode,
  normalizeOptionalConnectorSide,
} from "./service-normalize-connector.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

// ---------------------------------------------------------------------------
// Scope constants — Drive requires the full drive scope for read+write.
// Docs and Sheets inherit access from Drive scopes.
// ---------------------------------------------------------------------------

export const GOOGLE_DRIVE_READ_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly";
export const GOOGLE_DRIVE_WRITE_SCOPE =
  "https://www.googleapis.com/auth/drive";
export const GOOGLE_DRIVE_FILE_SCOPE =
  "https://www.googleapis.com/auth/drive.file";

/**
 * Returns true when the grant has at least one scope that permits reading
 * from Drive (drive, drive.readonly, or drive.file).
 */
function hasGoogleDriveReadScope(grant: {
  grantedScopes: string[];
}): boolean {
  const scopes = new Set(grant.grantedScopes);
  return (
    scopes.has(GOOGLE_DRIVE_WRITE_SCOPE) ||
    scopes.has(GOOGLE_DRIVE_READ_SCOPE) ||
    scopes.has(GOOGLE_DRIVE_FILE_SCOPE)
  );
}

/**
 * Returns true when the grant has a scope that permits writing to Drive
 * (drive or drive.file).
 */
function hasGoogleDriveWriteScope(grant: {
  grantedScopes: string[];
}): boolean {
  const scopes = new Set(grant.grantedScopes);
  return scopes.has(GOOGLE_DRIVE_WRITE_SCOPE) || scopes.has(GOOGLE_DRIVE_FILE_SCOPE);
}

// ---------------------------------------------------------------------------
// Capability descriptor (returned by the connector registry)
// ---------------------------------------------------------------------------

export const DRIVE_CONNECTOR_CAPABILITIES = {
  inbound: false,
  outbound: true,
  search: true,
  identity: true,
  attachments: true,
  deliveryStatus: false,
} as const;

// ---------------------------------------------------------------------------
// Mixin
// ---------------------------------------------------------------------------

/** @internal */
export function withDrive<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsDriveServiceMixin extends Base {

    // -----------------------------------------------------------------------
    // Grant helpers
    // -----------------------------------------------------------------------

    public async requireGoogleDriveReadGrant(
      requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      grantId?: string,
    ) {
      const status = await this.getGoogleConnectorStatus(
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      );
      const grant = status.grant;
      if (!status.connected || !grant) {
        fail(409, "Google Drive is not connected.");
      }
      if (!hasGoogleDriveReadScope(grant)) {
        fail(
          403,
          "Google Drive read access has not been granted. Reconnect Google with Drive scope.",
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
      if (!hasGoogleDriveWriteScope(grant)) {
        fail(
          403,
          "Google Drive write access has not been granted. Reconnect Google with Drive write scope.",
        );
      }
      return grant;
    }

    // -----------------------------------------------------------------------
    // Token helper
    // -----------------------------------------------------------------------

    async lifeOpsDriveAccessToken(
      grant: { tokenRef: string | null },
    ): Promise<string> {
      return (
        await ensureFreshGoogleAccessToken(
          grant.tokenRef ?? fail(409, "Google Drive token reference is missing."),
        )
      ).accessToken;
    }

    // -----------------------------------------------------------------------
    // Public Drive methods
    // -----------------------------------------------------------------------

    /**
     * List Drive files in a folder (defaults to root).
     */
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
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const grant = await this.requireGoogleDriveReadGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );

      const run = async () => {
        const accessToken = await this.lifeOpsDriveAccessToken(grant);
        return listDriveFiles({
          accessToken,
          folderId: request.folderId,
          maxResults: request.maxResults,
          pageToken: request.pageToken,
        });
      };

      return resolveGoogleExecutionTarget(grant) === "cloud"
        ? this.runManagedGoogleOperation(grant, run)
        : this.withGoogleGrantOperation(grant, run);
    }

    /**
     * Get Drive file metadata by ID.
     */
    async getDriveFile(
      requestUrl: URL,
      request: {
        mode?: LifeOpsConnectorMode;
        side?: LifeOpsConnectorSide;
        grantId?: string;
        fileId: string;
      },
    ): Promise<GoogleDriveFile> {
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const grant = await this.requireGoogleDriveReadGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );

      const run = async () => {
        const accessToken = await this.lifeOpsDriveAccessToken(grant);
        return getDriveFile({ accessToken, fileId: request.fileId });
      };

      return resolveGoogleExecutionTarget(grant) === "cloud"
        ? this.runManagedGoogleOperation(grant, run)
        : this.withGoogleGrantOperation(grant, run);
    }

    /**
     * Search Drive files using Drive v3 query syntax.
     */
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
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const grant = await this.requireGoogleDriveReadGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );

      const run = async () => {
        const accessToken = await this.lifeOpsDriveAccessToken(grant);
        return searchDriveFiles({
          accessToken,
          query: request.query,
          maxResults: request.maxResults,
        });
      };

      return resolveGoogleExecutionTarget(grant) === "cloud"
        ? this.runManagedGoogleOperation(grant, run)
        : this.withGoogleGrantOperation(grant, run);
    }

    /**
     * Read a Google Doc as plain text.
     */
    async getDocContent(
      requestUrl: URL,
      request: {
        mode?: LifeOpsConnectorMode;
        side?: LifeOpsConnectorSide;
        grantId?: string;
        documentId: string;
      },
    ): Promise<{ title: string; plainText: string }> {
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const grant = await this.requireGoogleDriveReadGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );

      const run = async () => {
        const accessToken = await this.lifeOpsDriveAccessToken(grant);
        return getDocContent({ accessToken, documentId: request.documentId });
      };

      return resolveGoogleExecutionTarget(grant) === "cloud"
        ? this.runManagedGoogleOperation(grant, run)
        : this.withGoogleGrantOperation(grant, run);
    }

    /**
     * Read a Google Sheet as a 2-D array of strings.
     */
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
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const grant = await this.requireGoogleDriveReadGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );

      const run = async () => {
        const accessToken = await this.lifeOpsDriveAccessToken(grant);
        return getSheetContent({
          accessToken,
          spreadsheetId: request.spreadsheetId,
          range: request.range,
        });
      };

      return resolveGoogleExecutionTarget(grant) === "cloud"
        ? this.runManagedGoogleOperation(grant, run)
        : this.withGoogleGrantOperation(grant, run);
    }

    /**
     * Create a new Drive file.
     * Pass `content` for files with body; omit for Google-native types (Docs, Sheets, …).
     */
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
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const grant = await this.requireGoogleDriveWriteGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );

      const run = async () => {
        const accessToken = await this.lifeOpsDriveAccessToken(grant);
        return createDriveFile({
          accessToken,
          name: request.name,
          mimeType: request.mimeType,
          content: request.content,
          parentFolderId: request.parentFolderId,
        });
      };

      return resolveGoogleExecutionTarget(grant) === "cloud"
        ? this.runManagedGoogleOperation(grant, run)
        : this.withGoogleGrantOperation(grant, run);
    }

    /**
     * Append plain text to an existing Google Doc.
     */
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
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const grant = await this.requireGoogleDriveWriteGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );

      const run = async () => {
        const accessToken = await this.lifeOpsDriveAccessToken(grant);
        return appendToDoc({
          accessToken,
          documentId: request.documentId,
          text: request.text,
        });
      };

      await (resolveGoogleExecutionTarget(grant) === "cloud"
        ? this.runManagedGoogleOperation(grant, run)
        : this.withGoogleGrantOperation(grant, run));
    }

    /**
     * Update cells in a Google Sheet.
     * `range` is A1 notation; `values` is a 2-D array of strings/numbers.
     */
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
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const grant = await this.requireGoogleDriveWriteGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );

      const run = async () => {
        const accessToken = await this.lifeOpsDriveAccessToken(grant);
        return updateSheetCells({
          accessToken,
          spreadsheetId: request.spreadsheetId,
          range: request.range,
          values: request.values,
        });
      };

      return resolveGoogleExecutionTarget(grant) === "cloud"
        ? this.runManagedGoogleOperation(grant, run)
        : this.withGoogleGrantOperation(grant, run);
    }
  }

  return LifeOpsDriveServiceMixin;
}
