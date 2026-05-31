import { describe, expect, it } from "vitest";
import { normalizeTerminalCommand } from "./terminal-command.ts";

describe("normalizeTerminalCommand", () => {
  it("leaves ordinary single-line commands unchanged", () => {
    expect(normalizeTerminalCommand("  echo hello-world  ")).toBe(
      "echo hello-world",
    );
  });

  it("unwraps CDATA shell scripts into a single-line bash command", () => {
    const command = normalizeTerminalCommand("<![CDATA[set -e\necho hello]]>");

    expect(command).toMatch(
      /^bash -lc "\$\(printf %s [A-Za-z0-9+/=]+ \| base64 -d\)"$/,
    );
    expect(command).not.toContain("<![CDATA[");
    expect(command).not.toContain("\n");
  });
});
