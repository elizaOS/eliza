import { describe, expect, it } from "vitest";
import {
  CHAT_UPLOAD_ACCEPT,
  chatUploadKind,
  createImageThumbnail,
  isSupportedChatUpload,
} from "./image-attachment";

const file = (type: string): File => ({ type }) as File;
const sizedFile = (type: string, size: number): File =>
  ({ type, size }) as File;

describe("chatUploadKind", () => {
  it("maps MIME types to attachment kinds", () => {
    expect(chatUploadKind("image/png")).toBe("image");
    expect(chatUploadKind("audio/mpeg")).toBe("audio");
    expect(chatUploadKind("video/mp4")).toBe("video");
    expect(chatUploadKind("application/pdf")).toBe("document");
    expect(chatUploadKind("text/plain")).toBe("document");
  });
});

describe("isSupportedChatUpload", () => {
  it("accepts images, audio, video, pdf, and text", () => {
    expect(isSupportedChatUpload(file("image/jpeg"))).toBe(true);
    expect(isSupportedChatUpload(file("audio/wav"))).toBe(true);
    expect(isSupportedChatUpload(file("video/webm"))).toBe(true);
    expect(isSupportedChatUpload(file("application/pdf"))).toBe(true);
    expect(isSupportedChatUpload(file("text/csv"))).toBe(true);
  });

  it("rejects unsupported types", () => {
    expect(isSupportedChatUpload(file("application/zip"))).toBe(false);
    expect(isSupportedChatUpload(file(""))).toBe(false);
  });
});

describe("CHAT_UPLOAD_ACCEPT", () => {
  it("covers each supported family", () => {
    expect(CHAT_UPLOAD_ACCEPT).toContain("image/*");
    expect(CHAT_UPLOAD_ACCEPT).toContain("audio/*");
    expect(CHAT_UPLOAD_ACCEPT).toContain("video/*");
    expect(CHAT_UPLOAD_ACCEPT).toContain("application/pdf");
  });
});

describe("createImageThumbnail (guards)", () => {
  it("returns null for non-raster / unthumbnailable types", async () => {
    expect(
      await createImageThumbnail(sizedFile("text/plain", 1_000_000)),
    ).toBeNull();
    expect(
      await createImageThumbnail(sizedFile("application/pdf", 1_000_000)),
    ).toBeNull();
    expect(
      await createImageThumbnail(sizedFile("image/gif", 1_000_000)),
    ).toBeNull();
    expect(
      await createImageThumbnail(sizedFile("image/svg+xml", 1_000_000)),
    ).toBeNull();
  });

  it("returns null for images below the size threshold", async () => {
    expect(await createImageThumbnail(sizedFile("image/png", 1024))).toBeNull();
  });
});
