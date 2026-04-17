/**
 * Integration test: Google Drive / Docs / Sheets via google-drive.ts.
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
 *   GOOGLE_OAUTH_TEST_TOKEN=ya29.xxx bunx vitest run eliza/apps/app-lifeops/test/google-drive.integration.test.ts
 */
import { describe, expect, it } from "vitest";
import { itIf } from "../../../../test/helpers/conditional-tests.ts";
import {
  listDriveFiles,
  getDriveFile,
  searchDriveFiles,
  getDocContent,
  getSheetContent,
} from "../src/lifeops/google-drive.js";

const SKIP_REASON = process.env.SKIP_REASON?.trim();
const ACCESS_TOKEN = process.env.GOOGLE_OAUTH_TEST_TOKEN?.trim() ?? "";
const LIVE_CREDS_AVAILABLE = !SKIP_REASON && ACCESS_TOKEN.length > 0;

const TEST_FILE_ID =
  process.env.GOOGLE_DRIVE_TEST_FILE_ID?.trim() ?? "";
const TEST_DOCUMENT_ID =
  process.env.GOOGLE_DOCS_TEST_DOCUMENT_ID?.trim() ?? "";
const TEST_SPREADSHEET_ID =
  process.env.GOOGLE_SHEETS_TEST_SPREADSHEET_ID?.trim() ?? "";

describe("Integration: google-drive client", () => {
  it("skips when GOOGLE_OAUTH_TEST_TOKEN is absent", () => {
    if (LIVE_CREDS_AVAILABLE) {
      // Nothing to assert when we have creds — the live tests below do the work.
      return;
    }
    // When creds are absent this test documents the skip.
    expect(ACCESS_TOKEN).toBe("");
  });

  itIf(LIVE_CREDS_AVAILABLE)(
    "listDriveFiles returns a non-null response with a files array",
    async () => {
      const result = await listDriveFiles({
        accessToken: ACCESS_TOKEN,
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
      const file = await getDriveFile({
        accessToken: ACCESS_TOKEN,
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
      const result = await searchDriveFiles({
        accessToken: ACCESS_TOKEN,
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
      const result = await getDocContent({
        accessToken: ACCESS_TOKEN,
        documentId: TEST_DOCUMENT_ID,
      });
      expect(typeof result.title).toBe("string");
      expect(typeof result.plainText).toBe("string");
    },
  );

  itIf(LIVE_CREDS_AVAILABLE && TEST_SPREADSHEET_ID.length > 0)(
    "getSheetContent returns a title and rows array for the specified spreadsheet",
    async () => {
      const result = await getSheetContent({
        accessToken: ACCESS_TOKEN,
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
