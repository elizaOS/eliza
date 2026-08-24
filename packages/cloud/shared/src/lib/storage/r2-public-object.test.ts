/**
 * Unit tests for R2 public object upload and URL resolution utilities.
 *
 * Verifies public URL generation with custom and default host fallbacks, spied
 * invocation and parameter forwarding to the Worker R2 BLOB binding (including
 * binary payload, httpMetadata content-type, and customMetadata), proof of
 * awaiting the async put operation before returning the public capability handle,
 * and rejection propagation on R2 upload failure.
 */

import { describe, expect, it, vi } from "vitest";
import { publicUrlForR2Key, putPublicObject } from "./r2-public-object.js";

describe("publicUrlForR2Key", () => {
  it("uses R2_PUBLIC_HOST when set", () => {
    const env = { BLOB: null as never, R2_PUBLIC_HOST: "cdn.example.com" };
    expect(publicUrlForR2Key(env, "path/file.txt")).toBe("https://cdn.example.com/path/file.txt");
  });

  it("falls back to blob.eliza.app when R2_PUBLIC_HOST is empty or unset", () => {
    const envWithEmptyHost = { BLOB: null as never, R2_PUBLIC_HOST: "" };
    expect(publicUrlForR2Key(envWithEmptyHost, "a/b")).toBe("https://blob.eliza.app/a/b");

    const envWithoutHost = { BLOB: null as never } as never;
    expect(publicUrlForR2Key(envWithoutHost, "a/b")).toBe("https://blob.eliza.app/a/b");
  });
});

describe("putPublicObject", () => {
  it("spies exact put arguments including httpMetadata and customMetadata", async () => {
    const putSpy = vi.fn().mockResolvedValue(undefined);
    const env = { BLOB: { put: putSpy } as never, R2_PUBLIC_HOST: "cdn.example.com" };
    const body = new Uint8Array([1, 2, 3, 4]);
    const customMetadata = { uploadedBy: "user-123", purpose: "voice-clone" };

    const res = await putPublicObject(env, {
      key: "voices/sample.wav",
      body,
      contentType: "audio/wav",
      customMetadata,
    });

    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy).toHaveBeenCalledWith("voices/sample.wav", body, {
      httpMetadata: { contentType: "audio/wav" },
      customMetadata,
    });
    expect(res).toEqual({
      key: "voices/sample.wav",
      url: "https://cdn.example.com/voices/sample.wav",
    });
  });

  it("handles puts without customMetadata and falls back to default public host", async () => {
    const putSpy = vi.fn().mockResolvedValue(undefined);
    const env = { BLOB: { put: putSpy } as never };
    const body = new ArrayBuffer(8);

    const res = await putPublicObject(env, {
      key: "avatars/photo.png",
      body,
      contentType: "image/png",
    });

    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy).toHaveBeenCalledWith("avatars/photo.png", body, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: undefined,
    });
    expect(res).toEqual({
      key: "avatars/photo.png",
      url: "https://blob.eliza.app/avatars/photo.png",
    });
  });

  it("proves the async put operation is awaited before the public URL is returned", async () => {
    let putResolved = false;
    let triggerResolve!: () => void;
    const putPromise = new Promise<void>((resolve) => {
      triggerResolve = () => {
        putResolved = true;
        resolve();
      };
    });

    const putSpy = vi.fn().mockReturnValue(putPromise);
    const env = { BLOB: { put: putSpy } as never, R2_PUBLIC_HOST: "cdn.example.com" };

    let completed = false;
    const uploadPromise = putPublicObject(env, {
      key: "recordings/audio.ogg",
      body: new Uint8Array([10, 20]),
      contentType: "audio/ogg",
    }).then((val) => {
      completed = true;
      return val;
    });

    await Promise.resolve();

    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putResolved).toBe(false);
    expect(completed).toBe(false);

    triggerResolve();
    const result = await uploadPromise;

    expect(putResolved).toBe(true);
    expect(completed).toBe(true);
    expect(result).toEqual({
      key: "recordings/audio.ogg",
      url: "https://cdn.example.com/recordings/audio.ogg",
    });
  });

  it("propagates upload rejection without returning fabricated success", async () => {
    const uploadError = new Error("R2 write failure: storage quota exceeded");
    const putSpy = vi.fn().mockRejectedValue(uploadError);
    const env = { BLOB: { put: putSpy } as never, R2_PUBLIC_HOST: "cdn.example.com" };

    await expect(
      putPublicObject(env, {
        key: "failed/upload.bin",
        body: new Uint8Array([0]),
        contentType: "application/octet-stream",
      }),
    ).rejects.toThrow("R2 write failure: storage quota exceeded");

    expect(putSpy).toHaveBeenCalledTimes(1);
  });
});
