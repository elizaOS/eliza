import { mkdir, access, appendFile as append, readFile as read, readdir, rm, stat, unlink, writeFile as write } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

type FileOperation = "read" | "write" | "delete";

interface PathValidationResult {
  allowed: boolean;
  reason?: string;
}

const CREDENTIAL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^\/\.ssh\/(?:id_|.*\.pem$|authorized_keys$|config$)/i, label: "SSH key/config" },
  { pattern: /^\/\.gnupg\//i, label: "GPG keyring" },
  { pattern: /^\/\.aws\/credentials$/i, label: "AWS credentials" },
  { pattern: /^\/\.aws\/sso\/cache\//i, label: "AWS SSO cache" },
  { pattern: /^\/\.azure\/accessTokens\.json$/i, label: "Azure access tokens" },
  { pattern: /^\/\.azure\/msal_token_cache/i, label: "Azure MSAL token cache" },
  { pattern: /^\/\.config\/gcloud\/credentials\.db$/i, label: "GCP credentials" },
  { pattern: /^\/\.config\/gcloud\/application_default_credentials\.json$/i, label: "GCP default credentials" },
  { pattern: /^\/\.docker\/config\.json$/i, label: "Docker credentials" },
  { pattern: /^\/\.kube\/config$/i, label: "Kubernetes config" },
  { pattern: /^\/\.netrc$/i, label: "netrc credentials" },
  { pattern: /^\/\.npmrc$/i, label: "npm credentials" },
  { pattern: /^\/\.git-credentials$/i, label: "Git stored credentials" },
  { pattern: /^\/Library\/Keychains\//i, label: "macOS Keychain" },
  { pattern: /^\/Library\/Cookies\//i, label: "macOS browser cookies" },
  { pattern: /\/(?:Google\/Chrome|Microsoft\\?\/Edge|BraveSoftware\/Brave-Browser)\/.*\/(?:Login Data|Cookies)$/i, label: "browser credential store" },
  { pattern: /\/\.mozilla\/firefox\/.*\/(?:logins\.json|key[34]\.db|cookies\.sqlite)$/i, label: "Firefox credential/cookie store" },
  { pattern: /\/AppData\/(?:Roaming|Local)\/Microsoft\/Credentials\//i, label: "Windows Credential Store" },
  { pattern: /\/AppData\/Local\/Microsoft\/Vault\//i, label: "Windows Credential Vault" },
];

const SYSTEM_DIR_PATTERNS_WIN32: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^[A-Z]:\/Windows\//i, label: "Windows system directory" },
  { pattern: /^[A-Z]:\/Program Files/i, label: "Program Files directory" },
  { pattern: /^[A-Z]:\/ProgramData\//i, label: "ProgramData directory" },
  { pattern: /^[A-Z]:\/\$Recycle\.Bin\//i, label: "Recycle Bin" },
  { pattern: /^[A-Z]:\/boot\//i, label: "boot directory" },
  { pattern: /^[A-Z]:\/Recovery\//i, label: "Recovery directory" },
  { pattern: /^[A-Z]:\/System Volume Information\//i, label: "System Volume Information" },
  { pattern: /^[A-Z]:\/\$WinREAgent\//i, label: "Windows Recovery Agent" },
  { pattern: /^[A-Z]:\/PROGRA~[1-4]\//i, label: "Program Files (8.3 short name)" },
];

const SYSTEM_DIR_PATTERNS_UNIX: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^\/boot\//i, label: "boot directory" },
  { pattern: /^\/sbin\//i, label: "system binary directory" },
  { pattern: /^\/usr\/sbin\//i, label: "system admin binary directory" },
  { pattern: /^\/usr\/lib\//i, label: "system library directory" },
  { pattern: /^\/etc\/(?:shadow|sudoers|pam\.d|master\.passwd)/, label: "system auth config" },
  { pattern: /^\/System\//, label: "macOS System directory" },
  { pattern: /^\/Library\/SystemMigration/, label: "macOS System Migration" },
  { pattern: /^\/private\/var\/db\/dslocal/, label: "macOS Directory Services" },
  { pattern: /^\/dev\//, label: "device node" },
  { pattern: /^\/proc\//, label: "proc filesystem" },
  { pattern: /^\/sys\//, label: "sys filesystem" },
];

function normalisePath(filePath: string): string {
  let resolved = resolve(filePath);
  if (process.platform === "win32" && /~\d/.test(resolved)) {
    try {
      const expanded = realpathSync.native(resolved);
      if (expanded !== resolved) {
        resolved = expanded;
      }
    } catch {
      // Path may not exist yet.
    }
  }
  return resolved.replace(/\\/g, "/");
}

function validateFilePath(filePath: string, operation: FileOperation): PathValidationResult {
  if (!filePath || typeof filePath !== "string") {
    return { allowed: false, reason: "No file path provided." };
  }

  if (filePath.includes("\0")) {
    return { allowed: false, reason: "Path contains null bytes (possible injection attack)." };
  }

  const resolved = normalisePath(filePath);

  if (resolved.startsWith("//")) {
    return { allowed: false, reason: "Network (UNC) paths are blocked. The agent can only access local files." };
  }

  const home = (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME)?.replace(/\\/g, "/") ?? "";
  const relToHome = home && resolved.startsWith(`${home}/`) ? resolved.slice(home.length) : null;
  if (relToHome) {
    for (const { pattern, label } of CREDENTIAL_PATTERNS) {
      if (pattern.test(relToHome)) {
        return {
          allowed: false,
          reason: `Blocked: "${basename(resolved)}" is a ${label} file. For security, the agent cannot directly access credential files.`,
        };
      }
    }
  }

  if (operation === "write" || operation === "delete") {
    const patterns = process.platform === "win32" ? SYSTEM_DIR_PATTERNS_WIN32 : SYSTEM_DIR_PATTERNS_UNIX;
    for (const { pattern, label } of patterns) {
      if (pattern.test(resolved)) {
        return {
          allowed: false,
          reason: `Blocked: cannot ${operation} in ${label} (${dirname(resolved)}). Modifying system directories could destabilise the OS.`,
        };
      }
    }

    if (/^[A-Z]:\/?$/i.test(resolved) || resolved === "/") {
      return { allowed: false, reason: `Blocked: cannot ${operation} the filesystem root.` };
    }
  }

  return { allowed: true };
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function readFile(params: { path: string; encoding?: string }): Promise<Record<string, unknown>> {
  const check = validateFilePath(params.path, "read");
  if (!check.allowed) {
    return { success: false, error: check.reason };
  }

  try {
    const content = await read(params.path, { encoding: (params.encoding || "utf-8") as BufferEncoding });
    return {
      success: true,
      path: params.path,
      content: String(content).slice(0, 10000),
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function writeFile(params: { path: string; content: string }): Promise<Record<string, unknown>> {
  const check = validateFilePath(params.path, "write");
  if (!check.allowed) {
    return { success: false, error: check.reason };
  }

  try {
    await ensureParentDirectory(params.path);
    await write(params.path, params.content, "utf-8");
    return { success: true, path: params.path, message: "File written" };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function editFile(params: { path: string; old_text: string; new_text: string }): Promise<Record<string, unknown>> {
  const check = validateFilePath(params.path, "write");
  if (!check.allowed) {
    return { success: false, error: check.reason };
  }

  try {
    const content = await read(params.path, "utf-8");
    if (!content.includes(params.old_text)) {
      return { success: false, error: "Old text not found in file" };
    }
    const next = content.replace(params.old_text, params.new_text);
    await write(params.path, next, "utf-8");
    return { success: true, path: params.path, message: "File edited" };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function appendFile(params: { path: string; content: string }): Promise<Record<string, unknown>> {
  const check = validateFilePath(params.path, "write");
  if (!check.allowed) {
    return { success: false, error: check.reason };
  }

  try {
    await ensureParentDirectory(params.path);
    await append(params.path, params.content, "utf-8");
    return { success: true, path: params.path, message: "Content appended" };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function deleteFile(params: { path: string }): Promise<Record<string, unknown>> {
  const check = validateFilePath(params.path, "delete");
  if (!check.allowed) {
    return { success: false, error: check.reason };
  }

  try {
    await unlink(params.path);
    return { success: true, path: params.path, message: "File deleted" };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function fileExists(params: { path: string }): Promise<Record<string, unknown>> {
  const check = validateFilePath(params.path, "read");
  if (!check.allowed) {
    return { success: false, error: check.reason };
  }

  try {
    await access(params.path);
    const fileStat = await stat(params.path);
    return {
      success: true,
      exists: true,
      is_file: fileStat.isFile(),
      is_directory: fileStat.isDirectory(),
      size: fileStat.size,
    };
  } catch {
    return { success: true, exists: false };
  }
}

export async function listDirectory(params: { path: string }): Promise<Record<string, unknown>> {
  const check = validateFilePath(params.path, "read");
  if (!check.allowed) {
    return { success: false, error: check.reason };
  }

  try {
    const entries = await readdir(params.path, { withFileTypes: true });
    const items = entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
      path: join(params.path, entry.name),
    }));
    return { success: true, path: params.path, items, count: items.length };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function deleteDirectory(params: { path: string }): Promise<Record<string, unknown>> {
  const check = validateFilePath(params.path, "delete");
  if (!check.allowed) {
    return { success: false, error: check.reason };
  }

  try {
    await rm(params.path, { recursive: true, force: true });
    return { success: true, path: params.path, message: "Directory deleted" };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export const fileUpload = writeFile;
export const fileDownload = readFile;
export const fileListDownloads = listDirectory;
