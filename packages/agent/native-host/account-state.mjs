import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
/** A credential rotation intentionally starts a fresh private memory namespace. */
export function runtimeAccountState(root, credential, profile) {
  if (profile && !/^[a-z][a-z0-9-]{0,47}$/.test(profile))
    throw new Error("Invalid runtime profile");
  const fingerprint = credential
    ? createHash("sha256").update(credential).digest("hex")
    : null;
  const account = join(
    root,
    "agent",
    "accounts",
    fingerprint ? `cloud-${fingerprint}` : "local",
  );
  return {
    fingerprint,
    state: profile ? join(account, "profiles", profile) : account,
  };
}
export async function prepareRuntimeAccountState(root, credential, profile) {
  const selected = runtimeAccountState(root, credential, profile);
  await mkdir(selected.state, { recursive: true, mode: 0o700 });
  await chmod(selected.state, 0o700);
  return selected;
}

export async function scrubRuntimeCredentialConfigs(root, credential) {
  if (!credential) return;
  const accounts = join(root, "agent", "accounts");
  let entries;
  try {
    entries = await readdir(accounts, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const scrub = (value) =>
    typeof value === "string" && value === credential
      ? undefined
      : Array.isArray(value)
        ? value.map(scrub)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).flatMap(([key, item]) => {
                const next = scrub(item);
                return next === undefined ? [] : [[key, next]];
              }),
            )
          : value;
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !/^(?:local|cloud-[0-9a-f]{64})$/.test(entry.name)
    )
      continue;
    const directories = [join(accounts, entry.name)];
    try {
      for (const profile of await readdir(
        join(accounts, entry.name, "profiles"),
        { withFileTypes: true },
      )) {
        if (
          profile.isDirectory() &&
          /^[a-z][a-z0-9-]{0,47}$/.test(profile.name)
        )
          directories.push(
            join(accounts, entry.name, "profiles", profile.name),
          );
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const directory of directories)
      for (const name of [
        "config.json",
        "launch-config.json",
        "eliza.config-overlay.json",
      ]) {
        const file = join(directory, name);
        let stat;
        try {
          stat = await lstat(file);
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
          throw new Error("Cannot safely migrate account configuration");
        const previous = JSON.parse(await readFile(file, "utf8"));
        const clean = scrub(previous);
        if (JSON.stringify(previous) === JSON.stringify(clean)) continue;
        const temporary =
          file + ".credential-migration-" + randomBytes(8).toString("hex");
        await writeFile(temporary, JSON.stringify(clean, null, 2), {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, file);
      }
  }
}
