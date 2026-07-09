/**
 * Contract for the Files-list per-viewer selection (#14778): OWNER/agent see
 * the whole store; USER/GUEST get the designed restricted state (empty +
 * `restricted: true`), never a healthy-empty fabrication. Pure use-case.
 */
import type { AccessContext, StoredFileListItem, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { selectFilesForViewer } from "./files-disclosure.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const VIEWER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;

const FILES: StoredFileListItem[] = [
  {
    url: "/api/media/a.png",
    hash: "a",
    fileName: "a.png",
    mimeType: "image/png",
    size: 10,
    createdAt: 2,
  },
  {
    url: "/api/media/b.pdf",
    hash: "b",
    fileName: "b.pdf",
    mimeType: "application/pdf",
    size: 20,
    createdAt: 1,
  },
];

const ctx = (over: Partial<AccessContext>): AccessContext => ({
  requesterEntityId: VIEWER,
  ...over,
});

describe("selectFilesForViewer", () => {
  it("no access context (single-owner boundary) → full store, not restricted", () => {
    expect(selectFilesForViewer(FILES, undefined, AGENT)).toEqual({
      files: FILES,
      restricted: false,
    });
  });

  it("agent self-read → full store", () => {
    expect(
      selectFilesForViewer(FILES, ctx({ requesterEntityId: AGENT }), AGENT),
    ).toEqual({ files: FILES, restricted: false });
  });

  it("OWNER and ADMIN rank → full store", () => {
    for (const c of [
      ctx({ role: "OWNER", isOwner: true }),
      ctx({ role: "ADMIN" }),
    ]) {
      expect(selectFilesForViewer(FILES, c, AGENT)).toEqual({
        files: FILES,
        restricted: false,
      });
    }
  });

  it("USER and GUEST → restricted state (empty + flag), distinct from empty store", () => {
    for (const c of [ctx({ role: "USER" }), ctx({ role: "GUEST" })]) {
      expect(selectFilesForViewer(FILES, c, AGENT)).toEqual({
        files: [],
        restricted: true,
      });
    }
  });

  it("an OWNER with a genuinely empty store is NOT restricted", () => {
    expect(
      selectFilesForViewer([], ctx({ role: "OWNER", isOwner: true }), AGENT),
    ).toEqual({ files: [], restricted: false });
  });
});
