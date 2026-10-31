/**
 * Terminal capability must reflect the shell that terminal sessions
 * actually spawn (`resolveShell` in `../platform/terminal.ts`):
 * `powershell.exe` on Windows and `/bin/bash` on POSIX. A host that lacks
 * the spawned shell must not be reported as having an available terminal.
 */

import { describe, expect, it } from "vitest";
import { detectPlatformCapabilities } from "../platform/capabilities.js";

function detect(osName: "win32" | "linux", present: ReadonlySet<string>) {
  return detectPlatformCapabilities({
    osName,
    commandExists: (command) => present.has(command),
    driverName: "legacy",
    isBrowserAvailable: () => false,
    isWaylandSession: () => false,
  });
}

describe("detectPlatformCapabilities terminal", () => {
  it("reports the Windows terminal unavailable when powershell.exe is missing", () => {
    const caps = detect("win32", new Set());
    expect(caps.terminal).toEqual({
      available: false,
      tool: "none (no shell found: powershell.exe)",
    });
  });

  it("reports the Windows terminal available when powershell.exe exists", () => {
    const caps = detect("win32", new Set(["powershell.exe"]));
    expect(caps.terminal).toEqual({
      available: true,
      tool: "powershell.exe",
    });
  });

  it("reports the POSIX terminal unavailable when /bin/bash is missing", () => {
    const caps = detect("linux", new Set());
    expect(caps.terminal).toEqual({
      available: false,
      tool: "none (no shell found: /bin/bash)",
    });
  });

  it("reports the POSIX terminal available when /bin/bash exists", () => {
    const caps = detect("linux", new Set(["/bin/bash"]));
    expect(caps.terminal).toEqual({ available: true, tool: "/bin/bash" });
  });
});
