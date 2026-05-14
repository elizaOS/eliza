/**
 * Real integration tests for terminal command execution.
 */
import { describe, expect, it } from "vitest";
import {
  checkDangerousCommand,
  sanitizeChildEnv,
} from "../platform/security.js";
import {
  closeTerminal,
  connectTerminal,
  executeTerminal,
  readTerminal,
  resizeTerminal,
  sendInputTerminal,
} from "../platform/terminal.js";

async function waitForTerminalOutput(
  sessionId: string,
  pattern: RegExp,
): Promise<string> {
  const deadline = Date.now() + 5000;
  let output = "";
  while (Date.now() < deadline) {
    output += readTerminal(sessionId).output ?? "";
    if (pattern.test(output)) {
      return output;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return output;
}

describe("terminal execution (real)", () => {
  it("executes a simple command", async () => {
    const result = await executeTerminal({ command: "echo hello" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
    expect(result.exitCode).toBe(0);
  });

  it("captures stderr on failure", async () => {
    const result = await executeTerminal({
      command: "ls /nonexistent_path_xyz",
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it("respects cwd", async () => {
    const result = await executeTerminal({ command: "pwd", cwd: "/tmp" });
    expect(result.success).toBe(true);
    // /tmp may resolve to /private/tmp on macOS
    expect(result.output).toMatch(/\/tmp/);
  });

  it("creates and uses terminal sessions", async () => {
    const session = await connectTerminal("/tmp");
    expect(session.success).toBe(true);
    expect(session.sessionId).toBeDefined();

    const exec = await executeTerminal({
      command: "echo session-test",
      sessionId: session.sessionId,
    });
    expect(exec.success).toBe(true);
    expect(exec.output).toContain("session-test");

    const close = await closeTerminal(session.sessionId);
    expect(close.success).toBe(true);
  });

  it("supports interactive session input and resize", async () => {
    const session = await connectTerminal({
      cwd: "/tmp",
      cols: 100,
      rows: 30,
    });
    expect(session.success).toBe(true);
    expect(session.sessionId).toBeDefined();
    expect(session.cols).toBe(100);
    expect(session.rows).toBe(30);

    const sessionId = session.sessionId as string;
    const resize = resizeTerminal({ sessionId, cols: 120, rows: 32 });
    expect(resize.success).toBe(true);
    expect(resize.cols).toBe(120);
    expect(resize.rows).toBe(32);

    const input = sendInputTerminal({
      sessionId,
      text: "printf 'interactive-terminal-parity\\n'\n",
    });
    expect(input.success).toBe(true);

    const output = await waitForTerminalOutput(
      sessionId,
      /interactive-terminal-parity/,
    );
    expect(output).toContain("interactive-terminal-parity");

    const close = closeTerminal(sessionId);
    expect(close.success).toBe(true);
  });

  it("handles command timeout", async () => {
    const result = await executeTerminal({
      command: "sleep 10",
      timeoutSeconds: 1,
    });
    expect(result.success).toBe(false);
  }, 15000);

  it("truncates long output", async () => {
    // Generate a lot of output
    const result = await executeTerminal({
      command:
        'for i in $(seq 1 10000); do echo "line $i padding text to make it longer"; done',
    });
    // Output should be present but may be truncated
    expect(result.output).toBeDefined();
    if (result.output && result.output.length > 5000) {
      // The terminal module truncates to 5000
      expect(result.output.length).toBeLessThanOrEqual(5100); // some slack for truncation message
    }
  }, 15000);
});

describe("dangerous command detection", () => {
  it("blocks rm -rf /", () => {
    const result = checkDangerousCommand("rm -rf /");
    expect(result.blocked).toBe(true);
  });

  it("blocks fork bombs", () => {
    const result = checkDangerousCommand(":(){ :|:& };:");
    expect(result.blocked).toBe(true);
  });

  it("blocks mkfs", () => {
    const result = checkDangerousCommand("mkfs.ext4 /dev/sda1");
    expect(result.blocked).toBe(true);
  });

  it("blocks dd to disk", () => {
    const result = checkDangerousCommand("dd if=/dev/zero of=/dev/sda");
    expect(result.blocked).toBe(true);
  });

  it("allows safe commands", () => {
    expect(checkDangerousCommand("ls -la").blocked).toBe(false);
    expect(checkDangerousCommand("echo hello").blocked).toBe(false);
    expect(checkDangerousCommand("git status").blocked).toBe(false);
    expect(checkDangerousCommand("cat /etc/hostname").blocked).toBe(false);
  });
});

describe("env sanitization", () => {
  it("strips known sensitive variables", () => {
    const original = process.env.INTERNAL_API_KEY;
    process.env.INTERNAL_API_KEY = "secret123";

    const sanitized = sanitizeChildEnv();
    expect(sanitized.INTERNAL_API_KEY).toBeUndefined();

    // Restore
    if (original === undefined) {
      delete process.env.INTERNAL_API_KEY;
    } else {
      process.env.INTERNAL_API_KEY = original;
    }
  });

  it("preserves safe variables", () => {
    const sanitized = sanitizeChildEnv();
    expect(sanitized.PATH).toBeDefined();
    expect(sanitized.HOME).toBeDefined();
  });
});
