import { describe, expect, it } from "vitest";
import { buildPairingCodeCommandInfo } from "./pairing-command";

describe("buildPairingCodeCommandInfo", () => {
  it("builds the VPS command from a remote IP URL", () => {
    expect(
      buildPairingCodeCommandInfo("http://147.93.44.246:2138").sshCommand,
    ).toBe(
      'ssh user@147.93.44.246 "curl -s http://127.0.0.1:2138/api/auth/pair-code"',
    );
  });

  it("uses the domain as an editable SSH target and defaults the local agent port", () => {
    const info = buildPairingCodeCommandInfo("https://bot.nubs.site");

    expect(info.serverCommand).toBe(
      "curl -s http://127.0.0.1:2138/api/auth/pair-code",
    );
    expect(info.sshCommand).toBe(
      'ssh user@bot.nubs.site "curl -s http://127.0.0.1:2138/api/auth/pair-code"',
    );
    expect(info.usesDefaultPort).toBe(true);
  });

  it("uses an explicit domain port when present", () => {
    expect(buildPairingCodeCommandInfo("bot.nubs.site:3000").sshCommand).toBe(
      'ssh user@bot.nubs.site "curl -s http://127.0.0.1:3000/api/auth/pair-code"',
    );
  });

  it("does not SSH for loopback targets", () => {
    const info = buildPairingCodeCommandInfo("http://localhost:2138");

    expect(info.isLoopback).toBe(true);
    expect(info.sshCommand).toBeNull();
    expect(info.serverCommand).toBe(
      "curl -s http://127.0.0.1:2138/api/auth/pair-code",
    );
  });
});
