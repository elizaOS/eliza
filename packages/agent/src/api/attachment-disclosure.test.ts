/**
 * Contract for per-viewer chat-attachment DTO selection (#14781): the
 * OWNER/ADMIN-full / USER-grant-driven / GUEST-none matrix, the room-open
 * default for unmarked messages, and the fail-closed variant swap. Pure
 * use-case functions, no harness.
 */
import type { AccessContext, Memory, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  selectAttachmentsForViewer,
  serializeMessageAttachments,
} from "./attachment-disclosure.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const OWNER_ENTITY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const VIEWER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;
const STRANGER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as UUID;

const ORIGINAL_URL = "/api/media/aaaa1111.png";
const REDACTED_URL = "/api/media/bbbb2222.png";

function row(
  over: Partial<Memory> = {},
): Pick<Memory, "content" | "metadata" | "entityId"> {
  return {
    entityId: OWNER_ENTITY,
    content: {
      text: "here",
      attachments: [
        {
          id: "att-1",
          url: ORIGINAL_URL,
          contentType: "image",
          mimeType: "image/png",
          title: "payslip.png",
          description: "Payslip for Bob",
          text: "SSN 123-45-6789",
          thumbnailUrl: "/api/media/cccc3333.png",
          redactedUrl: REDACTED_URL,
        },
      ],
    },
    metadata: {},
    ...over,
  } as Pick<Memory, "content" | "metadata" | "entityId">;
}

const ctx = (over: Partial<AccessContext> = {}): AccessContext => ({
  requesterEntityId: VIEWER,
  role: "USER",
  ...over,
});

describe("selectAttachmentsForViewer", () => {
  it("no access context (single-owner dashboard) serves the full DTO unchanged", () => {
    const r = row();
    expect(selectAttachmentsForViewer(r, undefined, AGENT)).toEqual(
      serializeMessageAttachments(r.content as Record<string, unknown>),
    );
  });

  it("unmarked messages default to room-open: any viewer in the conversation sees the full attachment", () => {
    const out = selectAttachmentsForViewer(row(), ctx(), AGENT);
    expect(out).toHaveLength(1);
    expect(out?.[0].url).toBe(ORIGINAL_URL);
    expect(out?.[0].redacted).toBeUndefined();
  });

  it("OWNER/ADMIN viewers see marked messages in full", () => {
    const marked = row({
      metadata: { scope: "owner-private" } as Memory["metadata"],
    });
    for (const c of [
      ctx({ role: "OWNER", isOwner: true }),
      ctx({ role: "ADMIN" }),
    ]) {
      const out = selectAttachmentsForViewer(marked, c, AGENT);
      expect(out?.[0].url).toBe(ORIGINAL_URL);
      expect(out?.[0].redacted).toBeUndefined();
    }
  });

  it("USER with a redacted grant gets the variant URL, flagged, with original + enrichment withheld", () => {
    const marked = row({
      metadata: {
        scope: "owner-private",
        share: { grants: [{ entityId: VIEWER, mode: "redacted" }] },
      } as Memory["metadata"],
    });
    const out = selectAttachmentsForViewer(marked, ctx(), AGENT);
    expect(out).toHaveLength(1);
    const att = out?.[0];
    expect(att?.url).toBe(REDACTED_URL);
    expect(att?.redacted).toBe(true);
    // The original URL, thumbnail, and enrichment text/description derive
    // from the ORIGINAL bytes — all withheld.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(ORIGINAL_URL);
    expect(att?.thumbnailUrl).toBeUndefined();
    expect(att?.text).toBeUndefined();
    expect(att?.description).toBeUndefined();
  });

  it("a redacted grant with no stored variant discloses NOTHING (fail closed)", () => {
    const marked = row({
      metadata: {
        scope: "owner-private",
        share: { grants: [{ entityId: VIEWER, mode: "redacted" }] },
      } as Memory["metadata"],
    });
    const content = marked.content as unknown as {
      attachments: Array<Record<string, unknown>>;
    };
    delete content.attachments[0].redactedUrl;
    expect(selectAttachmentsForViewer(marked, ctx(), AGENT)).toBeUndefined();
  });

  it("ungranted USER and GUEST get no attachments from a marked message", () => {
    const marked = row({
      metadata: { scope: "owner-private" } as Memory["metadata"],
    });
    for (const c of [
      ctx({ requesterEntityId: STRANGER }),
      ctx({ requesterEntityId: STRANGER, role: "GUEST" }),
    ]) {
      expect(selectAttachmentsForViewer(marked, c, AGENT)).toBeUndefined();
    }
  });

  it("an unreadable scope marking fails closed to owner-private, never open", () => {
    const corrupt = row({
      metadata: { scope: "??garbage??" } as unknown as Memory["metadata"],
    });
    expect(selectAttachmentsForViewer(corrupt, ctx(), AGENT)).toBeUndefined();
  });

  it("a USER with a full grant sees a marked message's attachments in full", () => {
    const marked = row({
      metadata: {
        scope: "owner-private",
        share: { grants: [{ entityId: VIEWER, mode: "full" }] },
      } as Memory["metadata"],
    });
    const out = selectAttachmentsForViewer(marked, ctx(), AGENT);
    expect(out?.[0].url).toBe(ORIGINAL_URL);
    expect(out?.[0].redacted).toBeUndefined();
  });
});
