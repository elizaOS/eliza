import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildChatAttachments } from "./server-helpers.ts";

const previousStateDir = process.env.ELIZA_STATE_DIR;
let stateDir: string;

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-attachment-ids-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = previousStateDir;
});

describe("buildChatAttachments", () => {
  it("gives uploads from separate messages distinct content-addressed ids", async () => {
    const upload = (text: string, name: string) =>
      buildChatAttachments([
        {
          data: Buffer.from(text).toString("base64"),
          mimeType: "image/png",
          name,
        },
      ]);
    const first = (await upload("first image bytes", "first.png"))
      .compactAttachments?.[0];
    const second = (await upload("second image bytes", "second.png"))
      .compactAttachments?.[0];

    expect(first?.id).toBe(first?.checksum);
    expect(second?.id).toBe(second?.checksum);
    expect(first?.id).not.toBe(second?.id);
  });
});
