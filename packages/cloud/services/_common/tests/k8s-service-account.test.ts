/** Projected credentials rotate by replacing files while the gateway stays alive. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readServiceAccountCaCert,
  readServiceAccountToken,
  ServiceAccountCredentialError,
} from "../src/k8s-service-account";

const directories: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "cloud-service-account-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

for (const read of [readServiceAccountToken, readServiceAccountCaCert]) {
  test(`${read.name} observes creation, atomic replacement and removal`, () => {
    const dir = directory();
    const path = join(dir, "credential");
    expect(read(path)).toBeNull();
    writeFileSync(path, "first\n");
    expect(read(path)).toBe("first");
    const replacement = join(dir, "replacement");
    writeFileSync(replacement, "second\n");
    renameSync(replacement, path);
    expect(read(path)).toBe("second");
    rmSync(path);
    expect(read(path)).toBeNull();
    writeFileSync(path, "\n");
    expect(read(path)).toBeNull();
  });

  test(`${read.name} reports an unreadable credential instead of treating it as absent`, () => {
    expect(() => read(directory())).toThrow(ServiceAccountCredentialError);
  });
}
