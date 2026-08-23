/**
 * Verifies personal media ingress crosses the authenticated fetch boundary and
 * canonical file service with exact hash and readback checks before attachment creation.
 */
import crypto from "node:crypto";
import type { Media } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonalMediaMetadata } from "../src/types";

const fetchVerifiedPersonalMedia = vi.hoisted(() => vi.fn());
vi.mock("../src/baileys/media", () => ({ fetchVerifiedPersonalMedia }));

import { WhatsAppConnectorService } from "../src/runtime-service";

const bytes = Buffer.from("verified personal attachment");
const hash = crypto.createHash("sha256").update(bytes).digest("hex");
const metadata: PersonalMediaMetadata = {
  kind: "document",
  url: "https://media.whatsapp.net/file.enc",
  mediaKey: new Uint8Array(32),
  fileSha256: new Uint8Array(32),
  fileEncSha256: new Uint8Array(32),
  fileLength: bytes.length,
  mimeType: "application/pdf",
  fileName: "evidence.pdf",
};

function harness(readback: Buffer | null = bytes) {
  const storage = {
    store: vi.fn(async () => ({
      hash,
      fileName: `${hash}.pdf`,
      url: `/api/media/${hash}.pdf`,
      mimeType: "application/pdf",
      size: bytes.length,
    })),
    read: vi.fn(async () => readback),
  };
  const service = Object.create(
    WhatsAppConnectorService.prototype,
  ) as WhatsAppConnectorService;
  Object.assign(service as object, {
    runtime: { getService: vi.fn(() => storage) },
    defaultAccountId: "default",
    configs: new Map([
      ["default", { accountId: "default", transport: "baileys", authDir: "/tmp/auth" }],
    ]),
  });
  const ingest = (
    service as unknown as {
      ingestPersonalMedia: (accountId: string, value: PersonalMediaMetadata) => Promise<Media>;
    }
  ).ingestPersonalMedia.bind(service);
  return { ingest, storage };
}

beforeEach(() => {
  fetchVerifiedPersonalMedia.mockReset();
  fetchVerifiedPersonalMedia.mockResolvedValue({
    bytes,
    mimeType: "application/pdf",
    fileName: "evidence.pdf",
  });
});

describe("personal WhatsApp canonical media ingress", () => {
  it("stores and reads back exact verified bytes under their SHA-256 handle", async () => {
    const { ingest, storage } = harness();
    const attachment = await ingest("default", metadata);

    expect(fetchVerifiedPersonalMedia).toHaveBeenCalledWith(metadata, 50 * 1024 * 1024);
    expect(storage.store).toHaveBeenCalledWith(bytes, "application/pdf");
    expect(storage.read).toHaveBeenCalledWith(`${hash}.pdf`);
    expect(attachment).toEqual({
      id: hash,
      url: `/api/media/${hash}.pdf`,
      source: "whatsapp",
      contentType: "document",
      mimeType: "application/pdf",
      size: bytes.length,
      checksum: hash,
      filename: "evidence.pdf",
    });
  });

  it("performs no store I/O when guarded provider fetch fails", async () => {
    const { ingest, storage } = harness();
    fetchVerifiedPersonalMedia.mockRejectedValueOnce(new Error("SSRF denied"));
    await expect(ingest("default", metadata)).rejects.toThrow("SSRF denied");
    expect(storage.store).not.toHaveBeenCalled();
    expect(storage.read).not.toHaveBeenCalled();
  });

  it("fails visibly when canonical readback differs", async () => {
    const { ingest, storage } = harness(Buffer.from("corrupt"));
    await expect(ingest("default", metadata)).rejects.toMatchObject({
      code: "WHATSAPP_MEDIA_STORE_READBACK_MISMATCH",
    });
    expect(storage.store).toHaveBeenCalledTimes(1);
  });
});
