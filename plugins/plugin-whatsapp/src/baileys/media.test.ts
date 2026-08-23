/**
 * Exercises personal WhatsApp media authentication through the real crypto and
 * core guarded-fetch contracts with deterministic pinned transport doubles.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { nodePinnedFetch } from "@elizaos/core";
import { getMediaKeys } from "@whiskeysockets/baileys";
import { describe, expect, it, vi } from "vitest";
import type { PersonalMediaMetadata } from "../types";
import { fetchVerifiedPersonalMedia } from "./media";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

async function encryptedFixture(
  plaintext: Buffer,
  kind: PersonalMediaMetadata["kind"] = "image",
  mimeType = "image/png"
): Promise<{ metadata: PersonalMediaMetadata; encrypted: Buffer }> {
  const mediaKey = crypto.randomBytes(32);
  const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, kind);
  const cipher = crypto.createCipheriv("aes-256-cbc", cipherKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = crypto
    .createHmac("sha256", macKey)
    .update(iv)
    .update(ciphertext)
    .digest()
    .subarray(0, 10);
  const encrypted = Buffer.concat([ciphertext, mac]);
  return {
    encrypted,
    metadata: {
      kind,
      url: "https://media.whatsapp.net/media.enc",
      mediaKey,
      fileSha256: crypto.createHash("sha256").update(plaintext).digest(),
      fileEncSha256: crypto.createHash("sha256").update(encrypted).digest(),
      fileLength: plaintext.length,
      mimeType,
    },
  };
}

function guardedOptions(encrypted: Buffer) {
  return {
    lookupFn: vi.fn(async () => [{ address: "127.0.0.1", family: 4 as const }]),
    pinnedFetchImpl: vi.fn(
      async () =>
        new Response(encrypted, {
          headers: {
            "content-length": String(encrypted.length),
            "content-type": "application/octet-stream",
          },
        })
    ),
    ssrfPolicy: { allowedHostnames: ["media.whatsapp.net"] },
  };
}

describe("personal Baileys media ingress", () => {
  it("decrypts authenticated bytes through the DNS-pinned guard", async () => {
    const fixture = await encryptedFixture(PNG);
    const options = guardedOptions(fixture.encrypted);
    const result = await fetchVerifiedPersonalMedia(fixture.metadata, PNG.length, options);

    expect(result.bytes).toEqual(PNG);
    expect(result.mimeType).toBe("image/png");
    expect(options.lookupFn).toHaveBeenCalledWith("media.whatsapp.net", { all: true });
    expect(options.pinnedFetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses the metadata URL host for a direct-path CDN fallback", async () => {
    const fixture = await encryptedFixture(PNG);
    fixture.metadata.url = "https://media-cdg4-1.cdn.fbcdn.net/original.enc";
    fixture.metadata.directPath = "/whatsapp/new.enc";
    const options = {
      ...guardedOptions(fixture.encrypted),
      ssrfPolicy: { allowedHostnames: ["media-cdg4-1.cdn.fbcdn.net"] },
    };

    const result = await fetchVerifiedPersonalMedia(fixture.metadata, PNG.length, options);

    expect(result.bytes).toEqual(PNG);
    expect(options.lookupFn).toHaveBeenCalledWith("media-cdg4-1.cdn.fbcdn.net", { all: true });
    expect(options.pinnedFetchImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.objectContaining({
          hostname: "media-cdg4-1.cdn.fbcdn.net",
          pathname: "/whatsapp/new.enc",
        }),
      })
    );
  });

  it("blocks private resolution before provider transport I/O", async () => {
    const fixture = await encryptedFixture(PNG);
    const pinnedFetchImpl = vi.fn(async () => new Response(fixture.encrypted));
    await expect(
      fetchVerifiedPersonalMedia(fixture.metadata, PNG.length, {
        lookupFn: async () => [{ address: "127.0.0.1", family: 4 }],
        pinnedFetchImpl,
      })
    ).rejects.toThrow();
    expect(pinnedFetchImpl).not.toHaveBeenCalled();
  });

  it("keeps certificate verification enabled on the real pinned HTTPS transport", async () => {
    const fixture = await encryptedFixture(PNG);
    const tlsRoot = await mkdtemp(path.join(tmpdir(), "whatsapp-media-tls-"));
    const keyPath = path.join(tlsRoot, "key.pem");
    const certPath = path.join(tlsRoot, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-subj",
        "/CN=media.whatsapp.net",
        "-days",
        "1",
      ],
      { stdio: "ignore" }
    );
    let requests = 0;
    const server = createServer(
      { key: await readFile(keyPath), cert: await readFile(certPath) },
      (_request, response) => {
        requests += 1;
        response.end(fixture.encrypted);
      }
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    fixture.metadata.url = `https://media.whatsapp.net:${port}/media.enc`;
    try {
      await expect(
        fetchVerifiedPersonalMedia(fixture.metadata, PNG.length, {
          lookupFn: async () => [{ address: "127.0.0.1", family: 4 }],
          pinnedFetchImpl: nodePinnedFetch,
          ssrfPolicy: { allowedHostnames: ["media.whatsapp.net"] },
        })
      ).rejects.toMatchObject({ code: "WHATSAPP_PERSONAL_MEDIA_FETCH_FAILED" });
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await rm(tlsRoot, { recursive: true });
    }
  });

  it("rejects declared oversize before DNS or provider transport I/O", async () => {
    const fixture = await encryptedFixture(PNG);
    const options = guardedOptions(fixture.encrypted);
    await expect(
      fetchVerifiedPersonalMedia(fixture.metadata, PNG.length - 1, options)
    ).rejects.toMatchObject({
      code: "WHATSAPP_PERSONAL_MEDIA_SIZE_DENIED",
      severity: "ephemeral",
    });
    expect(options.lookupFn).not.toHaveBeenCalled();
    expect(options.pinnedFetchImpl).not.toHaveBeenCalled();
  });

  it("rejects redirects and encoded responses", async () => {
    const fixture = await encryptedFixture(PNG);
    const lookupFn = async () => [{ address: "127.0.0.1", family: 4 as const }];
    const policy = { allowedHostnames: ["media.whatsapp.net"] };
    await expect(
      fetchVerifiedPersonalMedia(fixture.metadata, PNG.length, {
        lookupFn,
        ssrfPolicy: policy,
        pinnedFetchImpl: async () =>
          new Response(null, { status: 302, headers: { location: "https://evil.example/media" } }),
      })
    ).rejects.toThrow();
    await expect(
      fetchVerifiedPersonalMedia(fixture.metadata, PNG.length, {
        lookupFn,
        ssrfPolicy: policy,
        pinnedFetchImpl: async () =>
          new Response(fixture.encrypted, { headers: { "content-encoding": "gzip" } }),
      })
    ).rejects.toMatchObject({ code: "WHATSAPP_PERSONAL_MEDIA_FETCH_FAILED" });
  });

  it("rejects corrupt ciphertext and plaintext type confusion", async () => {
    const fixture = await encryptedFixture(PNG);
    const corrupt = Buffer.from(fixture.encrypted);
    corrupt[0] ^= 0xff;
    await expect(
      fetchVerifiedPersonalMedia(fixture.metadata, PNG.length, guardedOptions(corrupt))
    ).rejects.toMatchObject({ code: "WHATSAPP_PERSONAL_MEDIA_ENCRYPTED_HASH_MISMATCH" });

    const pdfFixture = await encryptedFixture(
      Buffer.from("%PDF-1.7\nnot an image"),
      "image",
      "image/png"
    );
    await expect(
      fetchVerifiedPersonalMedia(
        pdfFixture.metadata,
        pdfFixture.metadata.fileLength,
        guardedOptions(pdfFixture.encrypted)
      )
    ).rejects.toMatchObject({ code: "WHATSAPP_PERSONAL_MEDIA_CONTENT_TYPE_MISMATCH" });
  });
});
