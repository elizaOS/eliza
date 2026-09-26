/**
 * Persists the local vault root before the identity process can create encrypted
 * records. Atomic publication prevents failed setup or concurrent starts from
 * replacing the password that unlocks an existing database.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ElizaError } from "@elizaos/core";

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function readPassword(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" &&
        metadata.uid !== process.getuid())
    ) {
      throw new ElizaError(
        "Local login password must be an owner-only regular file",
        {
          code: "LOGIN_PASSWORD_FILE_UNSAFE",
          context: { path },
        },
      );
    }
    const password = readFileSync(descriptor, "utf8").trim();
    if (!password) {
      throw new ElizaError(
        "Local login password file is empty; restore it before starting",
        {
          code: "LOGIN_PASSWORD_FILE_INVALID",
          context: { path },
        },
      );
    }
    return password;
  } finally {
    closeSync(descriptor);
  }
}

export function loadOrCreateLoginMasterPassword(
  dataDir: string,
  supplied?: string,
  allowCreate = true,
): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(dataDir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ElizaError("Local login data must use a real directory", {
      code: "LOGIN_PASSWORD_DIRECTORY_UNSAFE",
      context: { path: dataDir },
    });
  }
  chmodSync(dataDir, 0o700);
  const path = join(dataDir, ".master-password");
  const match = (password: string) => {
    if (supplied !== undefined && supplied !== password) {
      throw new ElizaError(
        "Configured login password does not match the persisted vault root",
        {
          code: "LOGIN_PASSWORD_CONFLICT",
          context: { path },
        },
      );
    }
    return password;
  };
  try {
    return match(readPassword(path));
  } catch (error) {
    // error-policy:J3 only an absent password file permits first-time creation.
    if (!hasCode(error, "ENOENT")) throw error;
  }
  if (!allowCreate) {
    throw new ElizaError(
      "Existing login credentials lack their vault password; restore the original password before restarting",
      {
        code: "LOGIN_PASSWORD_MISSING",
        context: { path },
      },
    );
  }
  const password = supplied ?? randomBytes(32).toString("hex");
  if (!password || password.trim() !== password || /[\r\n]/.test(password)) {
    throw new ElizaError(
      "Local login password must be a nonempty single-line value without surrounding whitespace",
      {
        code: "LOGIN_PASSWORD_INVALID",
      },
    );
  }
  const temporary = join(
    dataDir,
    `.master-password-${randomBytes(16).toString("hex")}`,
  );
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    try {
      writeFileSync(descriptor, `${password}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      linkSync(temporary, path);
    } catch (error) {
      // error-policy:J3 a concurrent creator owns the canonical file; validate its complete value.
      if (!hasCode(error, "EEXIST")) throw error;
    }
    return match(readPassword(path));
  } finally {
    unlinkSync(temporary);
  }
}
