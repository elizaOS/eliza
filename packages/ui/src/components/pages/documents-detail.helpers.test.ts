/**
 * Unit tests for documents detail helpers: validates document label formatters and summary derivation.
 */
import { describe, expect, it } from "vitest";
import type { DocumentRecord } from "../../api/client-types-chat";
import {
  getDocumentSourceLabel,
  getDocumentSummary,
  getDocumentTypeLabel,
} from "./documents-detail.helpers.ts";

describe("documents-detail.helpers", () => {
  const t = (k: string, opts?: Record<string, unknown>) => {
    let str = typeof opts?.defaultValue === "string" ? opts.defaultValue : k;
    if (opts?.count !== undefined) {
      str = str.replace("{{count}}", String(opts.count));
    }
    return str;
  };

  it("derives uppercase document type label from mime type", () => {
    expect(getDocumentTypeLabel("application/pdf")).toBe("PDF");
    expect(getDocumentTypeLabel("text/markdown")).toBe("MARKDOWN");
    expect(getDocumentTypeLabel(undefined)).toBe("DOCUMENT");
  });

  it("derives source label for youtube, url, and upload sources", () => {
    expect(getDocumentSourceLabel("youtube", t)).toBe("YouTube");
    expect(getDocumentSourceLabel("url", t)).toBe("From URL");
    expect(getDocumentSourceLabel("file", t)).toBe("Upload");
  });

  it("formats full document summary string with fragment count and size", () => {
    const doc: DocumentRecord = {
      id: "doc-1",
      title: "Notes",
      source: "url",
      fragmentCount: 5,
      fileSize: 1024,
    } as unknown as DocumentRecord;

    const summary = getDocumentSummary(doc, t);
    expect(summary).toContain("From URL");
    expect(summary).toContain("5 fragments");
    expect(summary).toContain("1.0 KB");
  });
});
