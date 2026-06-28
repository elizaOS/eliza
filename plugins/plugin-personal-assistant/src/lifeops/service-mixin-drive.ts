import type { GoogleDriveFile } from "@elizaos/plugin-google";
import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
} from "@elizaos/shared";
import type {
  LifeOpsConnectorGrant,
  LifeOpsGoogleConnectorStatus,
} from "../contracts/index.js";
import { DriveDomain } from "./domains/drive-service.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";

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

/**
 * `getGoogleConnectorStatus` is contributed by the Google mixin (`withGoogle`);
 * the localized cast wires it into the Drive sub-service from the composed
 * instance.
 */
type GoogleConnectorStatusProvider = {
  getGoogleConnectorStatus(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsGoogleConnectorStatus>;
};

/** @internal */
export function withDrive<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsDriveService> {
  class LifeOpsDriveServiceMixin extends Base {
    // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
    // Public (not private) to avoid TS4094 on the re-exported mixin class.
    readonly driveDomain = new DriveDomain(this, {
      getGoogleConnectorStatus: (
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      ) =>
        (
          this as unknown as GoogleConnectorStatusProvider
        ).getGoogleConnectorStatus(
          requestUrl,
          requestedMode,
          requestedSide,
          grantId,
        ),
    });

    requireGoogleDriveReadGrant(
      requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      grantId?: string,
    ): Promise<LifeOpsConnectorGrant> {
      return this.driveDomain.requireGoogleDriveReadGrant(
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      );
    }

    requireGoogleDriveWriteGrant(
      requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      grantId?: string,
    ): Promise<LifeOpsConnectorGrant> {
      return this.driveDomain.requireGoogleDriveWriteGrant(
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      );
    }

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
    ): Promise<{ files: GoogleDriveFile[]; nextPageToken: string | null }> {
      return this.driveDomain.listDriveFiles(requestUrl, request);
    }

    getDriveFile(
      requestUrl: URL,
      request: {
        mode?: LifeOpsConnectorMode;
        side?: LifeOpsConnectorSide;
        grantId?: string;
        fileId: string;
      },
    ): Promise<GoogleDriveFile> {
      return this.driveDomain.getDriveFile(requestUrl, request);
    }

    searchDriveFiles(
      requestUrl: URL,
      request: {
        mode?: LifeOpsConnectorMode;
        side?: LifeOpsConnectorSide;
        grantId?: string;
        query: string;
        maxResults?: number;
      },
    ): Promise<{ files: GoogleDriveFile[]; nextPageToken: string | null }> {
      return this.driveDomain.searchDriveFiles(requestUrl, request);
    }

    getDocContent(
      requestUrl: URL,
      request: {
        mode?: LifeOpsConnectorMode;
        side?: LifeOpsConnectorSide;
        grantId?: string;
        documentId: string;
      },
    ): Promise<{ title: string; plainText: string }> {
      return this.driveDomain.getDocContent(requestUrl, request);
    }

    getSheetContent(
      requestUrl: URL,
      request: {
        mode?: LifeOpsConnectorMode;
        side?: LifeOpsConnectorSide;
        grantId?: string;
        spreadsheetId: string;
        range?: string;
      },
    ): Promise<{ title: string; rows: string[][] }> {
      return this.driveDomain.getSheetContent(requestUrl, request);
    }

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
    ): Promise<GoogleDriveFile> {
      return this.driveDomain.createDriveFile(requestUrl, request);
    }

    appendToDoc(
      requestUrl: URL,
      request: {
        mode?: LifeOpsConnectorMode;
        side?: LifeOpsConnectorSide;
        grantId?: string;
        documentId: string;
        text: string;
      },
    ): Promise<void> {
      return this.driveDomain.appendToDoc(requestUrl, request);
    }

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
    ): Promise<{ updatedRange: string; updatedCells: number }> {
      return this.driveDomain.updateSheetCells(requestUrl, request);
    }
  }

  return LifeOpsDriveServiceMixin as unknown as MixinClass<
    TBase,
    LifeOpsDriveService
  >;
}
