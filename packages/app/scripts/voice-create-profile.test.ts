import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { readCatalog, VoiceProfileCatalogError } from "./voice-create-profile";

function withVoiceDir(catalogContents: string | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-profile-"));
  if (catalogContents !== null) {
    fs.mkdirSync(path.join(dir, "profiles"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "profiles", "catalog.json"),
      catalogContents,
    );
  }
  return dir;
}

describe("voice-create-profile readCatalog", () => {
  test("missing catalog defaults to the 'same' profile", async () => {
    const dir = withVoiceDir(null);
    try {
      expect(await readCatalog(dir)).toEqual({
        version: 1,
        defaultProfileId: "same",
        profiles: [],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("backfills a missing defaultProfileId with 'same' and keeps profiles", async () => {
    const profile = {
      id: "alice",
      displayName: "Alice",
      instruct: "",
      active: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const dir = withVoiceDir(
      JSON.stringify({ version: 1, profiles: [profile] }),
    );
    try {
      const catalog = await readCatalog(dir);
      expect(catalog.defaultProfileId).toBe("same");
      expect(catalog.profiles).toEqual([profile]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupt catalog throws instead of returning an empty catalog", async () => {
    const dir = withVoiceDir('{"version":1,"profiles":[{"id":"alice"');
    try {
      await expect(readCatalog(dir)).rejects.toBeInstanceOf(
        VoiceProfileCatalogError,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-object catalog or non-array profiles throws", async () => {
    for (const contents of ["[]", '{"profiles":{}}']) {
      const dir = withVoiceDir(contents);
      try {
        await expect(readCatalog(dir)).rejects.toBeInstanceOf(
          VoiceProfileCatalogError,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
