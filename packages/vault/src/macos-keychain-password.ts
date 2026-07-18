/**
 * Writes macOS Keychain passwords through the system security tool's terminal
 * prompts without placing secret material in process arguments or environment
 * variables. Expect owns the pseudo-terminal because the security tool refuses
 * piped prompt input, while Node retains bounded lifecycle and error reporting.
 */

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 10_000;
const EXPECT_EXIT_BEFORE_PROMPT = 70;
const EXPECT_TIMEOUT_ENV = "ELIZA_KEYCHAIN_EXPECT_TIMEOUT_MS";
const EXPECT_SECURITY_ENV = "ELIZA_KEYCHAIN_EXPECT_SECURITY_PATH";
const EXPECT_SERVICE_ENV = "ELIZA_KEYCHAIN_EXPECT_SERVICE";
const EXPECT_ACCOUNT_ENV = "ELIZA_KEYCHAIN_EXPECT_ACCOUNT";

const SECURITY_PASSWORD_EXPECT_SCRIPT = String.raw`
foreach required_name {${EXPECT_TIMEOUT_ENV} ${EXPECT_SECURITY_ENV} ${EXPECT_SERVICE_ENV} ${EXPECT_ACCOUNT_ENV}} {
  if {![info exists env($required_name)]} {
    puts stderr "missing expect configuration: $required_name"
    exit 64
  }
}

set timeout_ms $env(${EXPECT_TIMEOUT_ENV})
set security_path $env(${EXPECT_SECURITY_ENV})
set service $env(${EXPECT_SERVICE_ENV})
set account $env(${EXPECT_ACCOUNT_ENV})

if {![string is integer -strict $timeout_ms] || $timeout_ms < 1} {
  puts stderr "invalid security prompt timeout"
  exit 64
}

set timeout [expr {int(ceil(double($timeout_ms) / 1000.0))}]
fconfigure stdin -encoding utf-8 -translation lf
if {[gets stdin password] < 0} {
  puts stderr "missing keychain password on expect stdin"
  exit 65
}

log_user 0
set transcript ""
set password_prompt "password data for new item: "
set retype_prompt "retype password for new item: "

proc emit_transcript {transcript} {
  if {[string length $transcript] > 0} {
    puts -nonewline stderr $transcript
  }
}

proc fail_timeout {stage transcript} {
  catch {close}
  puts stderr "security prompt timed out while waiting for $stage"
  emit_transcript $transcript
  exit 124
}

proc fail_early_eof {stage transcript} {
  set result [wait]
  emit_transcript $transcript
  puts stderr "security exited before $stage (status [lindex $result 3])"
  exit ${EXPECT_EXIT_BEFORE_PROMPT}
}

spawn $security_path add-generic-password -s $service -a $account -U -w
expect {
  -exact $password_prompt {
    append transcript $expect_out(buffer)
  }
  timeout {
    fail_timeout "password data prompt" $transcript
  }
  eof {
    append transcript $expect_out(buffer)
    fail_early_eof "password data prompt" $transcript
  }
}
send -- "$password\r"

expect {
  -exact $retype_prompt {
    append transcript $expect_out(buffer)
  }
  timeout {
    fail_timeout "retype password prompt" $transcript
  }
  eof {
    append transcript $expect_out(buffer)
    fail_early_eof "retype password prompt" $transcript
  }
}
send -- "$password\r"

expect {
  eof {
    append transcript $expect_out(buffer)
    set result [wait]
    set os_error [lindex $result 2]
    set status [lindex $result 3]
    if {$os_error == 0 && $status == 0} {
      exit 0
    }
    emit_transcript $transcript
    puts stderr "security failed (status $status)"
    if {$os_error == 0 && $status > 0 && $status < 256} {
      exit $status
    }
    exit 125
  }
  timeout {
    fail_timeout "security command completion" $transcript
  }
}
`;

export interface MacOSKeychainPasswordWriteOptions {
  /** Total prompt deadline before expect terminates the security command. */
  readonly timeoutMs?: number;
  /** Test seam for exercising the protocol without the host Keychain. */
  readonly securityExecutable?: string;
  /** Test seam for deterministic process-boundary tests. */
  readonly expectExecutable?: string;
}

export class MacOSKeychainPasswordWriteError extends Error {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    message: string,
    details: {
      readonly code?: number | null;
      readonly signal?: NodeJS.Signals | null;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = "MacOSKeychainPasswordWriteError";
    this.code = details.code ?? null;
    this.signal = details.signal ?? null;
    this.stdout = details.stdout ?? "";
    this.stderr = details.stderr ?? "";
  }
}

function redactSecret(value: string, password: string): string {
  return value.split(password).join("[REDACTED]");
}

/**
 * Adds or updates a generic-password item through the two exact prompts emitted
 * by `/usr/bin/security`. The password crosses the Node/expect boundary once on
 * stdin; expect replays it only into the child pseudo-terminal.
 */
export function writeMacOSKeychainPassword(
  service: string,
  account: string,
  password: string,
  options: MacOSKeychainPasswordWriteOptions = {},
): Promise<void> {
  if (password.length === 0 || /[\r\n]/u.test(password)) {
    throw new MacOSKeychainPasswordWriteError(
      "macOS Keychain passwords must be a non-empty single line",
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new MacOSKeychainPasswordWriteError(
      "macOS Keychain prompt timeout must be a positive integer",
    );
  }

  const expectExecutable = options.expectExecutable ?? "/usr/bin/expect";
  const securityExecutable = options.securityExecutable ?? "/usr/bin/security";

  return new Promise((resolve, reject) => {
    const child = spawn(
      expectExecutable,
      ["-c", SECURITY_PASSWORD_EXPECT_SCRIPT],
      {
        env: {
          ...process.env,
          [EXPECT_TIMEOUT_ENV]: String(timeoutMs),
          [EXPECT_SECURITY_ENV]: securityExecutable,
          [EXPECT_SERVICE_ENV]: service,
          [EXPECT_ACCOUNT_ENV]: account,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const hardDeadline = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs + 1_500);
    hardDeadline.unref();

    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardDeadline);
      reject(
        new MacOSKeychainPasswordWriteError(
          `failed to start macOS Keychain prompt helper: ${cause.message}`,
          { cause },
        ),
      );
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardDeadline);
      if (code === 0) {
        resolve();
        return;
      }

      const safeStdout = redactSecret(stdout, password);
      const safeStderr = redactSecret(stderr, password);
      const diagnostic = (safeStderr.trim() || safeStdout.trim()).slice(
        0,
        4_000,
      );
      reject(
        new MacOSKeychainPasswordWriteError(
          diagnostic ||
            `macOS Keychain prompt helper exited ${code ?? "without a code"}${
              signal ? ` (${signal})` : ""
            }`,
          { code, signal, stdout: safeStdout, stderr: safeStderr },
        ),
      );
    });

    // error-policy:J5 unhandled-rejection suppression — expect process failures
    // are observed by the error/close handlers above, which preserve diagnostics.
    child.stdin.on("error", () => {});
    child.stdin.end(`${password}\n`, "utf8");
  });
}
