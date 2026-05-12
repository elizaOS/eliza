/**
 * Integration test: Google Drive / Docs / Sheets through @elizaos/plugin-google.
 *
 * Gated on GOOGLE_OAUTH_TEST_TOKEN being set (a valid Bearer access token
 * with at least the drive.readonly scope). When absent, all live tests skip
 * cleanly. Set SKIP_REASON to document a deliberate skip.
 *
 * Optional env vars used only when present:
 *   GOOGLE_DRIVE_TEST_FILE_ID     — a known Drive file ID to test getDriveFile
 *   GOOGLE_DOCS_TEST_DOCUMENT_ID  — a known Google Doc ID to test getDocContent
 *   GOOGLE_SHEETS_TEST_SPREADSHEET_ID — a known Spreadsheet ID to test getSheetContent
 *
 * Run:
 *   GOOGLE_OAUTH_TEST_TOKEN=ya29.xxx bunx --bun vitest run plugins/app-lifeops/test/google-drive.integration.test.ts
 */
import {
  GoogleApiClientFactory,
  GoogleDriveClient,
} from "@elizaos/plugin-google";
import { OAuth2Client } from "google-auth-library";
import { describe, expect, it } from "vitest";
import { itIf } from "../../../test/helpers/conditional-tests.ts";

const SKIP_REASON = process.env.SKIP_REASON?.trim();
const ACCESS_TOKEN = process.env.GOOGLE_OAUTH_TEST_TOKEN?.trim() ?? "";
const LIVE_CREDS_AVAILABLE = !SKIP_REASON && ACCESS_TOKEN.length > 0;

const TEST_FILE_ID = process.env.GOOGLE_DRIVE_TEST_FILE_ID?.trim() ?? "";
const TEST_DOCUMENT_ID = process.env.GOOGLE_DOCS_TEST_DOCUMENT_ID?.trim() ?? "";
const TEST_SPREADSHEET_ID =
  process.env.GOOGLE_SHEETS_TEST_SPREADSHEET_ID?.trim() ?? "";
const TEST_ACCOUNT_ID = "google-live-test";

function driveClient(): GoogleDriveClient {
  const auth = new OAuth2Client();
  auth.setCredentials({ access_token: ACCESS_TOKEN });
  return new GoogleDriveClient(
    new GoogleApiClientFactory({
      async getAuthClient() {
        return auth;
      },
    }),
  );
}

describe("Integration: plugin-google Drive client", () => {
  it.skipIf(LIVE_CREDS_AVAILABLE)(
    "documents that live google-drive tests are skipped when GOOGLE_OAUTH_TEST_TOKEN is absent",
    () => {
      expect(ACCESS_TOKEN).toBe("");
      expect(LIVE_CREDS_AVAILABLE).toBe(false);
    },
  );

  itIf(LIVE_CREDS_AVAILABLE)(
    "listDriveFiles returns a non-null response with a files array",
    async () => {
      const result = await driveClient().listDriveFiles({
        accountId: TEST_ACCOUNT_ID,
        maxResults: 5,
      });
      expect(Array.isArray(result.files)).toBe(true);
      // nextPageToken is a string or null
      expect(
        result.nextPageToken === null ||
          typeof result.nextPageToken === "string",
      ).toBe(true);
      for (const file of result.files) {
        expect(typeof file.id).toBe("string");
        expect(file.id.length).toBeGreaterThan(0);
        expect(typeof file.name).toBe("string");
        expect(typeof file.mimeType).toBe("string");
        expect(Array.isArray(file.parents)).toBe(true);
      }
    },
  );

  itIf(LIVE_CREDS_AVAILABLE && TEST_FILE_ID.length > 0)(
    "getDriveFile returns metadata for the specified file",
    async () => {
      const file = await driveClient().getFile({
        accountId: TEST_ACCOUNT_ID,
        fileId: TEST_FILE_ID,
      });
      expect(file.id).toBe(TEST_FILE_ID);
      expect(typeof file.name).toBe("string");
      expect(typeof file.mimeType).toBe("string");
    },
  );

  itIf(LIVE_CREDS_AVAILABLE)(
    "searchDriveFiles with a broad query returns a result",
    async () => {
      const result = await driveClient().searchDriveFiles({
        accountId: TEST_ACCOUNT_ID,
        // Search for any non-trashed file — broad but legal Drive query.
        query: "mimeType != 'application/vnd.google-apps.folder'",
        maxResults: 5,
      });
      expect(Array.isArray(result.files)).toBe(true);
      // May be empty for accounts with no matching files — shape check only.
      for (const file of result.files) {
        expect(typeof file.id).toBe("string");
        expect(file.id.length).toBeGreaterThan(0);
      }
    },
  );

  itIf(LIVE_CREDS_AVAILABLE && TEST_DOCUMENT_ID.length > 0)(
    "getDocContent returns title and plainText for the specified document",
    async () => {
      const result = await driveClient().getDocContent({
        accountId: TEST_ACCOUNT_ID,
        documentId: TEST_DOCUMENT_ID,
      });
      expect(typeof result.title).toBe("string");
      expect(typeof result.plainText).toBe("string");
    },
  );

  itIf(LIVE_CREDS_AVAILABLE && TEST_SPREADSHEET_ID.length > 0)(
    "getSheetContent returns a title and rows array for the specified spreadsheet",
    async () => {
      const result = await driveClient().getSheetContent({
        accountId: TEST_ACCOUNT_ID,
        spreadsheetId: TEST_SPREADSHEET_ID,
      });
      expect(typeof result.title).toBe("string");
      expect(Array.isArray(result.rows)).toBe(true);
      for (const row of result.rows) {
        expect(Array.isArray(row)).toBe(true);
        for (const cell of row) {
          expect(typeof cell).toBe("string");
        }
      }
    },
  );
});
