import { describe, expect, it } from "vitest";
import { normalizeTerminalCommand } from "./terminal-command.ts";

describe("normalizeTerminalCommand", () => {
  it("passes through plain commands", () => {
    expect(normalizeTerminalCommand("ls -la")).toBe("ls -la");
    expect(normalizeTerminalCommand("  echo hi  ")).toBe("echo hi");
  });

  it("wraps CDATA scripts in a base64 shell invocation", () => {
    const out = normalizeTerminalCommand("<![CDATA[echo hello]]>");
    expect(out).toMatch(
      /^bash -lc "\$\(printf %s [A-Za-z0-9+/=]+ \| base64 -d\)"$/,
    );
  });

  it("round-trips the original script via base64", () => {
    const script = "echo hello && ls";
    const out = normalizeTerminalCommand(`<![CDATA[${script}]]>`);
    const b64 = out.match(/printf %s ([A-Za-z0-9+/=]+) \|/)?.[1];
    expect(Buffer.from(b64 ?? "", "base64").toString("utf8")).toBe(script);
  });

  it("returns empty for empty CDATA", () => {
    expect(normalizeTerminalCommand("<![CDATA[  ]]>")).toBe("");
  });

  it("does not match partial CDATA", () => {
    expect(normalizeTerminalCommand("<![CDATA[echo")).toBe("<![CDATA[echo");
  });
});
