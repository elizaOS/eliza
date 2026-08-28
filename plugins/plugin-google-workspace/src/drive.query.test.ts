import { describe, expect, it, vi } from "vitest";
import { GoogleDriveClient } from "./drive.ts";

function makeClient() {
  const list = vi.fn(async () => ({ data: { files: [] } }));
  const fakeDrive = { files: { list } };
  const factory = { drive: vi.fn(async () => fakeDrive) };
  return { client: new GoogleDriveClient(factory as never), list };
}

describe("searchDriveFiles trashed-filter preservation", () => {
  it("existing: preserves an explicit top-level trashed predicate", async () => {
    const { client, list } = makeClient();
    await client.searchDriveFiles({
      accountId: "acct",
      query: "name contains 'Plan' and trashed = true",
    } as never);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ q: "name contains 'Plan' and trashed = true" })
    );
  });

  it("existing: appends trashed = false for a plain query", async () => {
    const { client, list } = makeClient();
    await client.searchDriveFiles({
      accountId: "acct",
      query: "name contains 'Plan'",
    } as never);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ q: "(name contains 'Plan') and trashed = false" })
    );
  });

  it("BUG: quoted-literal 'trashed =' text silently drops the trashed = false filter", async () => {
    const { client, list } = makeClient();
    await client.searchDriveFiles({
      accountId: "acct",
      query: "name contains 'trashed = report'",
    } as never);
    // Should append trashed = false; currently returns the raw query,
    // exposing trashed (deleted) files in results.
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        q: "(name contains 'trashed = report') and trashed = false",
      })
    );
  });

  it("BUG: quoted-literal 'trashed =' at the start of a fullText search", async () => {
    const { client, list } = makeClient();
    await client.searchDriveFiles({
      accountId: "acct",
      query: "fullText contains 'trashed = true'",
    } as never);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        q: "(fullText contains 'trashed = true') and trashed = false",
      })
    );
  });
});

describe("driveQuery quoted-literal edge cases", () => {
  it("handles empty query", async () => {
    const { client, list } = makeClient();
    await client.searchDriveFiles({ accountId: "acct", query: "   " } as never);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: "() and trashed = false" }));
  });

  it("handles escaped quote inside a literal", async () => {
    const { client, list } = makeClient();
    await client.searchDriveFiles({
      accountId: "acct",
      query: "name contains 'it\\'s trashed = here'",
    } as never);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        q: "(name contains 'it\\'s trashed = here') and trashed = false",
      })
    );
  });

  it("strips trashed text only inside quoted literals in compound queries", async () => {
    const { client, list } = makeClient();
    await client.searchDriveFiles({
      accountId: "acct",
      query: "name contains 'a' and fullText contains 'trashed = b' and mimeType = 'text/plain'",
    } as never);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        q: "(name contains 'a' and fullText contains 'trashed = b' and mimeType = 'text/plain') and trashed = false",
      })
    );
  });
});
