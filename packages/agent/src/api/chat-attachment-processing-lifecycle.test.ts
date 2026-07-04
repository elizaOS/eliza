/**
 * End-to-end lifecycle test for chat attachments (#10714): every supported
 * upload MIME type is validated, persisted through the real content-addressed
 * media store on a temp ELIZA_STATE_DIR, served back with correct headers and
 * range support, and processed into text. Model calls (image-description,
 * transcription) run against a stubbed runtime; storage and serving are real.
 */
import { Buffer } from "node:buffer";
import fs from "node:fs";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime, Media } from "@elizaos/core";
import { afterAll, describe, expect, it, vi } from "vitest";

const oldStateDir = process.env.ELIZA_STATE_DIR;
const stateDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "chat-attachment-lifecycle-"),
);
process.env.ELIZA_STATE_DIR = stateDir;

// Imported after ELIZA_STATE_DIR is set so media-store resolves to the temp dir.
const { buildChatAttachments, CHAT_UPLOAD_MIME_TYPES, validateChatImages } =
  await import("./server-helpers.ts");
const { mediaFileNameFromUrl, serveMediaFile } = await import(
  "./media-store.ts"
);
const { ContentType, DefaultMessageService, ModelType } = await import(
  "@elizaos/core"
);

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  if (oldStateDir === undefined) {
    delete process.env.ELIZA_STATE_DIR;
  } else {
    process.env.ELIZA_STATE_DIR = oldStateDir;
  }
});

const EXPECTED_EXT_BY_MIME: Record<
  (typeof CHAT_UPLOAD_MIME_TYPES)[number],
  string
> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "weba",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/ogg": "ogv",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
};

function expectedContentType(mimeType: string): string {
  if (mimeType.startsWith("image/")) return ContentType.IMAGE;
  if (mimeType.startsWith("audio/")) return ContentType.AUDIO;
  if (mimeType.startsWith("video/")) return ContentType.VIDEO;
  return ContentType.DOCUMENT;
}

function expectedServedMime(mimeType: string): string {
  if (mimeType === "text/plain") return "text/plain; charset=utf-8";
  if (mimeType === "text/csv") return "text/csv; charset=utf-8";
  if (mimeType === "text/markdown") return "text/markdown; charset=utf-8";
  if (mimeType === "image/jpeg") return "image/jpeg";
  if (mimeType === "audio/mp3") return "audio/mpeg";
  if (mimeType === "audio/x-wav" || mimeType === "audio/wave")
    return "audio/wav";
  return mimeType;
}

function nameForMime(
  mimeType: (typeof CHAT_UPLOAD_MIME_TYPES)[number],
): string {
  return `sample.${EXPECTED_EXT_BY_MIME[mimeType]}`;
}

function buildPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function bytesForMime(mimeType: string): Buffer {
  if (mimeType === "application/pdf") {
    return buildPdf("Hello PDF from lifecycle 10714");
  }
  if (mimeType === "text/plain") {
    return Buffer.from("plain text lifecycle body", "utf8");
  }
  if (mimeType === "text/csv") {
    return Buffer.from("name,score\nada,99\ngrace,97", "utf8");
  }
  if (mimeType === "text/markdown") {
    return Buffer.from("# Lifecycle\n\n- upload\n- process", "utf8");
  }
  return Buffer.from(`binary fixture for ${mimeType}`, "utf8");
}

function makeRes(): {
  res: ServerResponse;
  get: () => { status: number; headers: Record<string, unknown> };
} {
  let status = 0;
  let headers: Record<string, unknown> = {};
  const res = {
    writeHead(nextStatus: number, nextHeaders: Record<string, unknown>) {
      status = nextStatus;
      headers = nextHeaders;
      return this;
    },
    end() {},
    write() {
      return true;
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    emit() {
      return true;
    },
  } as unknown as ServerResponse;
  return { res, get: () => ({ status, headers }) };
}

function serve(url: string, options: { method?: string; range?: string } = {}) {
  const { res, get } = makeRes();
  const handled = serveMediaFile(
    {
      method: options.method ?? "HEAD",
      headers: options.range ? { range: options.range } : {},
    } as never,
    res,
    url,
  );
  expect(handled).toBe(true);
  return get();
}

function mediaPathFromUrl(url: string): string {
  const fileName = mediaFileNameFromUrl(url);
  if (!fileName) throw new Error(`expected stored media URL, got ${url}`);
  return path.join(stateDir, "media", fileName);
}

async function mediaStoreFetch(input: unknown): Promise<Response> {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : typeof (input as { url?: unknown })?.url === "string"
          ? String((input as { url: string }).url)
          : String(input);
  const parsed = new URL(raw);
  const pathName = parsed.pathname;
  const fileName = mediaFileNameFromUrl(pathName);
  if (!fileName) {
    return new Response("not found", { status: 404, statusText: "Not Found" });
  }
  const body = fs.readFileSync(path.join(stateDir, "media", fileName));
  const head = serve(pathName);
  return new Response(body, {
    status: 200,
    statusText: "OK",
    headers: {
      "Content-Type": String(head.headers["Content-Type"]),
    },
  });
}

function makeRuntime(mimeType: string): IAgentRuntime {
  return {
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
    getSetting: vi.fn(() => undefined),
    getCache: vi.fn(async () => undefined),
    setCache: vi.fn(async () => undefined),
    fetch: mediaStoreFetch,
    useModel: vi.fn(async (modelType: string) => {
      if (modelType === ModelType.IMAGE_DESCRIPTION) {
        return {
          title: "Lifecycle image",
          description: `description for ${mimeType}`,
          text: `image text for ${mimeType}`,
        };
      }
      if (modelType === ModelType.TRANSCRIPTION) {
        return `transcript for ${mimeType}`;
      }
      throw new Error(`unexpected model: ${modelType}`);
    }),
  } as unknown as IAgentRuntime;
}

function expectedProcessedText(mimeType: string): string {
  if (mimeType.startsWith("image/")) return `image text for ${mimeType}`;
  if (mimeType.startsWith("audio/") || mimeType.startsWith("video/"))
    return `transcript for ${mimeType}`;
  if (mimeType === "application/pdf") return "Hello PDF from lifecycle 10714";
  return bytesForMime(mimeType).toString("utf8");
}

describe("chat attachment upload -> store -> processing lifecycle (#10714)", () => {
  it("accepts, persists, serves, and processes every supported upload MIME type", async () => {
    const service = new DefaultMessageService();

    for (const mimeType of CHAT_UPLOAD_MIME_TYPES) {
      const bytes = bytesForMime(mimeType);
      const upload = {
        data: bytes.toString("base64"),
        mimeType,
        name: nameForMime(mimeType),
      };

      expect(validateChatImages([upload]), mimeType).toBeNull();

      const { attachments, compactAttachments } = await buildChatAttachments([
        upload,
      ]);
      const attachment = attachments?.[0];
      const compact = compactAttachments?.[0] as
        | (Media & { _data?: unknown; _mimeType?: unknown })
        | undefined;

      expect(attachment, mimeType).toBeDefined();
      expect(compact, mimeType).toBeDefined();
      expect(attachment?.url, mimeType).toMatch(
        new RegExp(
          `^/api/media/[a-f0-9]{64}\\.${EXPECTED_EXT_BY_MIME[mimeType]}$`,
        ),
      );
      expect(fs.existsSync(mediaPathFromUrl(attachment?.url ?? ""))).toBe(true);
      expect(attachment?.contentType).toBe(expectedContentType(mimeType));
      expect(attachment?.mimeType).toBe(mimeType);
      expect(attachment?.filename).toBe(upload.name);
      expect(attachment?.size).toBe(bytes.length);
      expect(attachment?.checksum).toMatch(/^[a-f0-9]{64}$/);

      expect(compact?._data, mimeType).toBeUndefined();
      expect(compact?._mimeType, mimeType).toBeUndefined();
      expect(compact?.mimeType).toBe(mimeType);
      expect(compact?.checksum).toBe(attachment?.checksum);

      const head = serve(attachment?.url ?? "");
      expect(head.status, mimeType).toBe(200);
      expect(head.headers["Content-Type"], mimeType).toBe(
        expectedServedMime(mimeType),
      );
      expect(head.headers["X-Content-Type-Options"], mimeType).toBe("nosniff");
      const disposition = String(head.headers["Content-Disposition"]);
      if (mimeType.startsWith("text/")) {
        expect(disposition, mimeType).toContain("attachment");
      } else {
        expect(disposition, mimeType).toBe("inline");
      }

      if (mimeType.startsWith("audio/") || mimeType.startsWith("video/")) {
        const ranged = serve(attachment?.url ?? "", {
          method: "GET",
          range: "bytes=0-2",
        });
        expect(ranged.status, mimeType).toBe(206);
        expect(String(ranged.headers["Content-Range"]), mimeType).toMatch(
          /^bytes 0-2\/\d+$/,
        );
      }

      const runtime = makeRuntime(mimeType);
      const [processed] = await service.processAttachments(runtime, [
        attachment as Media,
      ]);

      expect(processed.text, mimeType).toBe(expectedProcessedText(mimeType));
      if (mimeType.startsWith("image/")) {
        expect(processed.description, mimeType).toBe(
          `description for ${mimeType}`,
        );
        expect(runtime.useModel).toHaveBeenCalledWith(
          ModelType.IMAGE_DESCRIPTION,
          expect.objectContaining({ stream: false }),
        );
      }
      if (mimeType.startsWith("audio/") || mimeType.startsWith("video/")) {
        expect(processed.description, mimeType).toBe(
          `Transcript: transcript for ${mimeType}`,
        );
        expect(runtime.useModel).toHaveBeenCalledWith(
          ModelType.TRANSCRIPTION,
          expect.any(Buffer),
        );
      }
    }
  });
});
