// @ts-nocheck — Mixin pattern: each `withFoo()` returns a class that calls
// methods belonging to sibling mixins (e.g. `this.recordScreenTimeEvent`).
// Type checking each mixin in isolation surfaces 700+ phantom errors because
// the local TBase constraint can't see sibling mixin methods. Real type
// safety is enforced at the composed-service level (LifeOpsService class).
// Refactoring requires either declaration-merging every cross-mixin method
// or moving to a single composed interface — tracked as separate work.
import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
} from "@elizaos/shared";
import { resolveGoogleExecutionTarget } from "./google-connector-gateway.js";
import {
  appendToDoc,
  createDriveFile,
  type GoogleDriveFile,
  getDocContent,
  getDriveFile,
  getSheetContent,
  listDriveFiles,
  searchDriveFiles,
  updateSheetCells,
} from "./google-drive.js";
import {
  getDriveFileWithGoogleWorkspaceBridge,
  searchDriveFilesWithGoogleWorkspaceBridge,
} from "./google-workspace-bridge.js";
import { ensureFreshGoogleAccessToken } from "./google-oauth.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";
import {
  normalizeOptionalConnectorMode,
  normalizeOptionalConnectorSide,
} from "./service-normalize-connector.js";

// ---------------------------------------------------------------------------
// Scope constants — Drive requires the full drive scope for read+write.
// Docs and Sheets inherit access from Drive scopes.
// ---------------------------------------------------------------------------

export const GOOGLE_DRIVE_READ_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly";
export const GOOGLE_DRIVE_WRITE_SCOPE = "https://www.googleapis.com/auth/drive";
export const GOOGLE_DRIVE_FILE_SCOPE =
  "https://www.googleapis.com/auth/drive.file";

/**
 * Returns true when the grant has at least one scope that permits reading
 * from Drive (drive, drive.readonly, or drive.file).
 */
function hasGoogleDriveReadScope(grant: { grantedScopes: string[] }): boolean {
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
function hasGoogleDriveWriteScope(grant: { grantedScopes: string[] }): boolean {
  const scopes = new Set(grant.grantedScopes);
  return (
    scopes.has(GOOGLE_DRIVE_WRITE_SCOPE) || scopes.has(GOOGLE_DRIVE_FILE_SCOPE)
  );
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

    async lifeOpsDriveAccessToken(grant: {
      tokenRef: string | null;
    }): Promise<string> {
      return (
        await ensureFreshGoogleAccessToken(
          grant.tokenRef ??
            fail(409, "Google Drive token reference is missing."),
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
        // Deprecated transition fallback only: plugin-google does not yet
        // expose paged Drive folder listing, so this path still uses the
        // legacy LifeOps token until a paged account-scoped method exists.
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
        const bridgeGet = await getDriveFileWithGoogleWorkspaceBridge({
          runtime: this.runtime,
          grant,
          fileId: request.fileId,
        });
        if (bridgeGet.status === "handled") {
          return bridgeGet.value;
        }
        if (bridgeGet.error) {
          this.logLifeOpsWarn(
            "google_workspace_bridge_fallback",
            bridgeGet.reason,
            {
              provider: "google",
              operation: "drive.getFile",
              grantId: grant.id,
              mode: grant.mode,
              error:
                bridgeGet.error instanceof Error
                  ? bridgeGet.error.message
                  : String(bridgeGet.error),
            },
          );
        }
        // Deprecated transition fallback: plugin-google is the primary Drive
        // file metadata path; this local-token REST path remains only for
        // unmigrated Google credential records.
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
        const bridgeSearch = await searchDriveFilesWithGoogleWorkspaceBridge({
          runtime: this.runtime,
          grant,
          query: request.query,
          maxResults: request.maxResults,
        });
        if (bridgeSearch.status === "handled") {
          return bridgeSearch.value;
        }
        if (bridgeSearch.error) {
          this.logLifeOpsWarn(
            "google_workspace_bridge_fallback",
            bridgeSearch.reason,
            {
              provider: "google",
              operation: "drive.searchFiles",
              grantId: grant.id,
              mode: grant.mode,
              error:
                bridgeSearch.error instanceof Error
                  ? bridgeSearch.error.message
                  : String(bridgeSearch.error),
            },
          );
        }
        // Deprecated transition fallback: plugin-google is the primary Drive
        // search path; this local-token REST path remains only for unmigrated
        // Google credential records.
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
        // Deprecated transition fallback only: plugin-google does not yet
        // expose Docs content reads, so this path still uses the legacy
        // LifeOps token until an account-scoped method exists.
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
        // Deprecated transition fallback only: plugin-google does not yet
        // expose Sheets content reads, so this path still uses the legacy
        // LifeOps token until an account-scoped method exists.
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
        // Deprecated transition fallback only: plugin-google does not yet
        // expose Drive file writes, so this path still uses the legacy
        // LifeOps token until an account-scoped method exists.
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
        // Deprecated transition fallback only: plugin-google does not yet
        // expose Docs writes, so this path still uses the legacy LifeOps token
        // until an account-scoped method exists.
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
        // Deprecated transition fallback only: plugin-google does not yet
        // expose Sheets writes, so this path still uses the legacy LifeOps
        // token until an account-scoped method exists.
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
