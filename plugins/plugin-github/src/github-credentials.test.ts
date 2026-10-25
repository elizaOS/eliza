import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  getCredentialFilePath,
  loadCredentials,
  saveCredentials,
} from "./github-credentials";

let directory: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});
it("distinguishes missing records from corrupt saved state", async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "github-record-"));
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  expect(await loadCredentials()).toBe(null);
  await mkdir(path.dirname(getCredentialFilePath()), { recursive: true });
  await writeFile(getCredentialFilePath(), "not json");
  await expect(loadCredentials()).rejects.toMatchObject({
    code: "GITHUB_CREDENTIAL_RECORD_INVALID",
  });
  await writeFile(getCredentialFilePath(), "{}");
  await expect(loadCredentials()).rejects.toMatchObject({
    code: "GITHUB_CREDENTIAL_RECORD_INVALID",
  });
  const record = {
    token: "fixture",
    username: "fixture",
    scopes: [],
    savedAt: 1,
  };
  await saveCredentials(record);
  expect(await loadCredentials()).toEqual(record);
});
