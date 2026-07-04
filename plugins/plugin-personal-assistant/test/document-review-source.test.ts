// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { describe, expect, it } from "vitest";
import {
  computeDocumentSourceHash,
  createDocumentSourceSnapshot,
  type DocumentSourceRef,
  documentSourceKey,
} from "../src/lifeops/document-review.js";

/**
 * Document-source identity + capture. The source key uniquely identifies a
 * document across kinds; the content hash binds a snapshot to its exact bytes
 * (tamper-evidence); and local-file capture is gated behind an explicit,
 * fully-attributed read permission (owner-consent boundary, #8833).
 */

const drive: DocumentSourceRef = {
  kind: "drive_document",
  fileId: "f1",
  revisionId: "r1",
  title: "Q3 plan",
  accountEmail: "owner@x.com",
};

describe("documentSourceKey", () => {
  it("builds a stable key per source kind", () => {
    expect(documentSourceKey(drive)).toBe("drive_document:f1:r1");
    expect(documentSourceKey({ ...drive, revisionId: null })).toBe(
      "drive_document:f1:unversioned",
    );
    expect(
      documentSourceKey({
        kind: "gmail_draft",
        draftId: "d1",
        messageId: null,
        threadId: null,
        accountEmail: null,
        subject: null,
      }),
    ).toBe("gmail_draft:d1:unmaterialized");
    expect(
      documentSourceKey({
        kind: "local_file",
        path: "/tmp/a.txt",
      } as DocumentSourceRef),
    ).toBe("local_file:/tmp/a.txt");
    expect(
      documentSourceKey({
        kind: "pasted_text",
        pasteId: "p1",
      } as DocumentSourceRef),
    ).toBe("pasted_text:p1");
  });
});

describe("computeDocumentSourceHash", () => {
  it("is deterministic and sensitive to text and source", () => {
    const h = computeDocumentSourceHash(drive, "hello");
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeDocumentSourceHash(drive, "hello")).toBe(h);
    expect(computeDocumentSourceHash(drive, "hello!")).not.toBe(h);
    expect(
      computeDocumentSourceHash({ ...drive, fileId: "f2" }, "hello"),
    ).not.toBe(h);
  });
});

describe("createDocumentSourceSnapshot", () => {
  it("captures a valid source as untrusted content", () => {
    const res = createDocumentSourceSnapshot({
      source: drive,
      text: "body",
      capturedAt: "2026-06-23T00:00:00.000Z",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toMatchObject({
        sourceKey: "drive_document:f1:r1",
        textLength: 4,
        trustBoundary: "untrusted_document_content",
      });
      expect(res.value.sourceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("rejects a source missing its identifier", () => {
    const res = createDocumentSourceSnapshot({
      source: { ...drive, fileId: "" },
      text: "body",
      capturedAt: "2026-06-23T00:00:00.000Z",
    });
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(res.errors.map((e) => e.code)).toContain("INVALID_SOURCE_REF");
  });

  it("requires explicit, fully-attributed read permission for local files", () => {
    const base = {
      text: "body",
      capturedAt: "2026-06-23T00:00:00.000Z",
    };
    // No permission at all → rejected.
    const noPerm = createDocumentSourceSnapshot({
      ...base,
      source: { kind: "local_file", path: "/tmp/a.txt" } as DocumentSourceRef,
    });
    expect(noPerm.ok).toBe(false);
    if (!noPerm.ok)
      expect(noPerm.errors.map((e) => e.code)).toContain(
        "LOCAL_FILE_PERMISSION_REQUIRED",
      );

    // Granted but missing attribution fields → still rejected.
    const partial = createDocumentSourceSnapshot({
      ...base,
      source: {
        kind: "local_file",
        path: "/tmp/a.txt",
        readPermission: {
          granted: true,
          permissionId: "",
          grantedBy: "",
          grantedAt: "",
          reason: "",
        },
      } as DocumentSourceRef,
    });
    expect(partial.ok).toBe(false);

    // Fully-attributed grant → accepted.
    const ok = createDocumentSourceSnapshot({
      ...base,
      source: {
        kind: "local_file",
        path: "/tmp/a.txt",
        readPermission: {
          granted: true,
          permissionId: "perm-1",
          grantedBy: "owner",
          grantedAt: "2026-06-23T00:00:00.000Z",
          reason: "review contract",
        },
      } as DocumentSourceRef,
    });
    expect(ok.ok).toBe(true);
  });
});
