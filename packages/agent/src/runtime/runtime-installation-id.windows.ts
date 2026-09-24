/**
 * Stores Windows installation identity in the current user's OS credential set.
 * The configured absolute state path names the installation independently of
 * replaceable filesystem contents. A protected cross-session mutex serializes
 * first creation; no passphrase, plaintext file, or ephemeral fallback is used.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { ElizaError, type UUID } from "@elizaos/core";
import { osKeychainMasterKey } from "@elizaos/auth/vault/master-key";

const SERVICE = "eliza.runtime-installation-identity.v1";
// Windows PowerShell 5.1 supplies the .NET Framework mutex ACL APIs. The child
// holds the mutex until stdin closes, including when the owning process dies.
const LOCK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($null -eq $sid) { throw 'Current user SID unavailable' }
$security = [System.Security.AccessControl.MutexSecurity]::new()
$security.SetAccessRuleProtection($true, $false)
$security.SetOwner($sid)
foreach ($principal in @($sid, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
  $security.AddAccessRule([System.Security.AccessControl.MutexAccessRule]::new(
    $principal, [System.Security.AccessControl.MutexRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow))
}
$created = $false
$name = 'Global\eliza-runtime-id-' + $sid.Value + '-' + $env:ELIZA_RUNTIME_ID_LOCK_ACCOUNT
$mutex = [System.Threading.Mutex]::new($false, $name, [ref]$created, $security)
$held = $false
try {
  $actual = $mutex.GetAccessControl()
  if (-not $actual.AreAccessRulesProtected) { throw 'Installation identity mutex ACL is not protected' }
  if ($actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {
    throw 'Installation identity mutex owner mismatch'
  }
  foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
        ($rule.IdentityReference.Value -ne $sid.Value -and $rule.IdentityReference.Value -ne 'S-1-5-18')) {
      throw 'Installation identity mutex has an unexpected principal'
    }
  }
  try { $held = $mutex.WaitOne(30000) }
  catch [System.Threading.AbandonedMutexException] {
    # The OS transfers ownership; the credential must still pass normal read validation.
    $held = $true
  }
  if (-not $held) { throw 'Installation identity mutex timed out' }
  [Console]::Out.WriteLine('LOCKED')
  [void][Console]::In.ReadLine()
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
`;

export async function loadWindowsRuntimeInstallationId(
  stateDirectory: string,
): Promise<UUID> {
  const account = createHash("sha256")
    .update(path.resolve(stateDirectory))
    .digest("hex");
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new ElizaError(
      "Windows SystemRoot must identify the trusted OS installation.",
      {
        code: "RUNTIME_INSTALLATION_ID_SECURE_STORAGE_UNAVAILABLE",
      },
    );
  }
  const child = spawn(
    path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(LOCK_SCRIPT, "utf16le").toString("base64"),
    ],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ELIZA_RUNTIME_ID_LOCK_ACCOUNT: account },
    },
  );
  let stderr = "";
  let inputError: Error | undefined;
  child.stdin.on("error", (error: Error) => {
    inputError = error;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const finished = new Promise<Error | undefined>((resolve) => {
    child.once("error", resolve);
    child.once("close", (code, signal) =>
      resolve(
        code === 0
          ? undefined
          : new Error(
              `Windows identity mutex failed (${code ?? signal}): ${stderr}`,
            ),
      ),
    );
  });
  const ready = new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (!output.includes("\n")) return;
      if (output.trim() === "LOCKED") resolve();
      else reject(new Error("Unexpected Windows identity mutex response"));
    });
  });
  const timeout = setTimeout(() => child.kill(), 45_000);
  try {
    await Promise.race([
      ready,
      finished.then((error) => {
        throw (
          error ?? new Error("Windows identity mutex exited before admission")
        );
      }),
    ]);
    const key = await osKeychainMasterKey({ service: SERVICE, account }).load();
    const bytes = Buffer.from(key.subarray(0, 16));
    key.fill(0);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    const identity =
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as UUID;
    child.stdin.end();
    const error = await finished;
    if (error) throw error;
    if (inputError) throw inputError;
    return identity;
  } catch (cause) {
    // error-policy:J2 Secure-store or lock failure never becomes a new transient identity.
    throw new ElizaError(
      "Windows runtime identity requires accessible OS credential storage and its protected mutex.",
      {
        code: "RUNTIME_INSTALLATION_ID_SECURE_STORAGE_UNAVAILABLE",
        cause,
        context: { stateDirectory: path.resolve(stateDirectory) },
      },
    );
  } finally {
    child.stdin.end();
    await finished;
    clearTimeout(timeout);
  }
}
