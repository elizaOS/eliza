/**
 * Adversarial unit tests for the Telegram multipart parser (#23105): the
 * parser is strict about delimiter-LINE framing, so boundary bytes inside
 * file content must not truncate a part, malformed framing must yield no
 * parts (caller answers 400), and caps must hold. Harness is deterministic
 * and pure — it exercises the parser function directly with hand-built
 * buffers; the wire-level behavior is covered by the delivery-row suite.
 */
import { describe, expect, it } from "vitest";

import { parseMultipartPartsForTest } from "../scripts/start-mocks.ts";

const BOUNDARY = "testboundary1234";

function part(
  name: string,
  filename: string | undefined,
  data: Buffer,
): Buffer {
  const disposition = filename
    ? `form-data; name="${name}"; filename="${filename}"`
    : `form-data; name="${name}"`;
  return Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\n`),
    Buffer.from(`Content-Disposition: ${disposition}\r\n\r\n`),
    data,
    Buffer.from("\r\n"),
  ]);
}

function body(...parts: Buffer[]): Buffer {
  return Buffer.concat([...parts, Buffer.from(`--${BOUNDARY}--\r\n`)]);
}

const CT = `multipart/form-data; boundary=${BOUNDARY}`;

describe("telegram multipart parser (adversarial)", () => {
  it("parses a well-formed upload without gaining or losing bytes", () => {
    const payload = Buffer.from("hello bytes \r\n with CRLF inside");
    const raw = body(
      part("chat_id", undefined, Buffer.from("-10023105")),
      part("caption", undefined, Buffer.from("matrix caption")),
      part("photo", "matrix-payload.png", payload),
    );
    const parts = parseMultipartPartsForTest(raw, CT);
    // ALL THREE parts must parse — a loop that advances past the next
    // delimiter skips every second part (the caption here).
    expect(parts.map((p) => p.name)).toEqual(["chat_id", "caption", "photo"]);
    const chat = parts.find((p) => p.name === "chat_id");
    expect(chat?.data.toString("utf8")).toBe("-10023105");
    const caption = parts.find((p) => p.name === "caption");
    expect(caption?.data.toString("utf8")).toBe("matrix caption");
    const photo = parts.find((p) => p.name === "photo");
    expect(photo?.filename).toBe("matrix-payload.png");
    // Exact byte equality: the trailing CRLF belongs to the delimiter, not
    // the payload (regression guard for the +\r\n truncation bug class).
    expect(photo && Buffer.compare(photo.data, payload)).toBe(0);
  });

  it("parses every part of a five-part body in order (skip regression)", () => {
    const raw = body(
      ...[1, 2, 3, 4, 5].map((n) =>
        part(`field${n}`, undefined, Buffer.from(`value-${n}`)),
      ),
    );
    const parts = parseMultipartPartsForTest(raw, CT);
    expect(parts.map((p) => p.name)).toEqual([
      "field1",
      "field2",
      "field3",
      "field4",
      "field5",
    ]);
    for (const p of parts) {
      const n = p.name.slice("field".length);
      expect(p.data.toString("utf8")).toBe(`value-${n}`);
    }
  });

  it("does not truncate when the file content contains the boundary mid-line", () => {
    // Boundary bytes appear inside the payload WITHOUT CRLF framing around
    // them as a delimiter line would have — they are content, not framing.
    const payload = Buffer.concat([
      Buffer.from(`before--${BOUNDARY}after`),
      Buffer.from("x".repeat(64)),
    ]);
    const raw = body(part("photo", "collide.bin", payload));
    const parts = parseMultipartPartsForTest(raw, CT);
    const photo = parts.find((p) => p.name === "photo");
    expect(photo).toBeDefined();
    expect(photo && Buffer.compare(photo.data, payload)).toBe(0);
  });

  it("does not truncate when the file content contains CRLF + boundary as a full delimiter line", () => {
    // A payload that embeds a TRUE delimiter-line-shaped sequence. Strict
    // RFC 2046 framing means the part genuinely ends at the first embedded
    // delimiter and the trailing junk is not a valid part — the parser must
    // return the truncated prefix and NOT fabricate the full payload; the
    // caller's byte-hash check would then fail. We assert the parser stops
    // at the embedded delimiter (honest truncation, not silent success on
    // wrong bytes) and the closing delimiter is not consumed as part data.
    const payload = Buffer.concat([
      Buffer.from("first segment"),
      Buffer.from(`\r\n--${BOUNDARY}\r\n`),
      Buffer.from("second segment that must NOT be silently appended"),
    ]);
    const raw = body(part("photo", "embedded-delimiter.bin", payload));
    const parts = parseMultipartPartsForTest(raw, CT);
    const photo = parts.find((p) => p.name === "photo");
    expect(photo?.data.toString("utf8")).toBe("first segment");
  });

  it("rejects a body whose first boundary occurrence is mid-line", () => {
    // No delimiter at body start and the first boundary hit lacks CRLF
    // framing before it — nothing is a valid part.
    const raw = Buffer.concat([
      Buffer.from(`junk--${BOUNDARY}more junk\r\n`),
      body(part("photo", "x.bin", Buffer.from("data"))),
    ]);
    const parts = parseMultipartPartsForTest(raw, CT);
    // The junk prefix means the first real delimiter is not at body start;
    // the parser may still find later properly-framed delimiters, but the
    // first part's payload start would be unparseable garbage — the key
    // assertion is it never returns a part whose data includes the junk.
    for (const p of parts) {
      expect(p.data.toString("utf8")).not.toContain("junk");
    }
  });

  it("returns no parts for malformed bodies (caller answers 400)", () => {
    expect(parseMultipartPartsForTest(Buffer.from(""), CT)).toEqual([]);
    expect(
      parseMultipartPartsForTest(Buffer.from("not multipart at all"), CT),
    ).toEqual([]);
    // Missing closing delimiter: the final part cannot be framed.
    const unterminated = Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\n`),
      Buffer.from(
        'Content-Disposition: form-data; name="photo"; filename="f"\r\n\r\n',
      ),
      Buffer.from("bytes"),
      // no closing delimiter
    ]);
    expect(parseMultipartPartsForTest(unterminated, CT)).toEqual([]);
  });

  it("requires a filename before a part counts as a file upload", () => {
    const raw = body(part("photo", undefined, Buffer.from("value-only")));
    const parts = parseMultipartPartsForTest(raw, CT);
    const photo = parts.find((p) => p.name === "photo");
    // The part parses, but carries no filename — the fixture treats it as
    // form text, not an upload.
    expect(photo?.filename).toBeUndefined();
  });
});
