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

  it("round-trips CDATA content correctly through base64 encoding", () => {
    const originalScript = "set -e\necho hello";
    const command = normalizeTerminalCommand(`<![CDATA[${originalScript}]]>`);

    const match = command.match(
      /^bash -lc "\$\(printf %s ([A-Za-z0-9+/=]+) \| base64 -d\)"$/,
    );
    expect(match).not.toBeNull();
    const decoded = Buffer.from(match?.[1] ?? "", "base64").toString("utf8");
    expect(decoded).toBe(originalScript);
  });

  it("round-trips scripts containing shell metacharacters without corruption", () => {
    const originalScript =
      "echo \"hello world\"\nfoo=$(cat /etc/hosts)\nls $HOME | grep 'bar'";
    const command = normalizeTerminalCommand(`<![CDATA[${originalScript}]]>`);

    const match = command.match(
      /^bash -lc "\$\(printf %s ([A-Za-z0-9+/=]+) \| base64 -d\)"$/,
    );
    expect(match).not.toBeNull();
    const decoded = Buffer.from(match?.[1] ?? "", "base64").toString("utf8");
    expect(decoded).toBe(originalScript);
  });

  it("returns empty string for blank CDATA content", () => {
    expect(normalizeTerminalCommand("<![CDATA[   ]]>")).toBe("");
  });
});
