/**
 * Real verification of the warm PowerShell host (#9581 follow-up).
 * Gated: runs only on Windows (the host is win32-only; everywhere else
 * `psHostAvailable()` is false and callers use their one-shot path).
 *
 * Proves the host:
 *   - starts and runs commands (text round-trips through stdin/stdout framing),
 *   - is fast once warm (the whole point — no per-call cold `powershell.exe`),
 *   - surfaces script errors as rejections (so callers fall back), and
 *   - stays usable after an error.
 *
 * See `src/platform/ps-host.ts`. Evidence: the cold-vs-warm latency table is in
 * the PR; here we assert correctness + a generous warm-latency ceiling.
 */

import { platform } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import {
  disposePsHost,
  psHostAvailable,
  runPsHost,
  shutdownPsHost,
  warmPsHost,
} from "../platform/ps-host.js";

const RUN = platform() === "win32";

describe("ps-host (warm PowerShell host, Windows)", () => {
  afterAll(() => {
    shutdownPsHost();
  });

  it.skipIf(!RUN)("is reported available on win32", () => {
    expect(psHostAvailable()).toBe(true);
  });

  it.skipIf(!RUN)(
    "runs a command and round-trips its stdout",
    async () => {
      await warmPsHost();
      const out = await runPsHost("Write-Output 'pshost-ok'", 30_000);
      expect(out).toContain("pshost-ok");
    },
    60_000,
  );

  it.skipIf(!RUN)(
    "round-trips UTF-8 via base64-in / text-out",
    async () => {
      const text = "héllo 世界 — ps-host";
      const b64 = Buffer.from(text, "utf-8").toString("base64");
      const out = await runPsHost(
        `[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')))`,
        30_000,
      );
      expect(out).toBe(text);
    },
    60_000,
  );

  it.skipIf(!RUN)(
    "is fast once warm (no per-call cold spawn)",
    async () => {
      await warmPsHost();
      // 5 sequential calls; once warm each should be well under a second even on
      // a Defender-heavy host. A cold spawn alone is ~10-16s, so this ceiling
      // can only pass through the persistent host.
      const start = Date.now();
      for (let i = 0; i < 5; i++) {
        await runPsHost("Write-Output (2 + 2)", 30_000);
      }
      const perCall = (Date.now() - start) / 5;
      expect(perCall).toBeLessThan(2_000);
    },
    60_000,
  );

  it.skipIf(!RUN)(
    "rejects on script error and stays usable afterward",
    async () => {
      await warmPsHost();
      await expect(runPsHost("throw 'boom'", 30_000)).rejects.toThrow();
      const out = await runPsHost("Write-Output 'still-alive'", 30_000);
      expect(out).toContain("still-alive");
    },
    60_000,
  );

  it.skipIf(!RUN)(
    "disposePsHost latches spawning off until re-warmed",
    async () => {
      await warmPsHost();
      // After an owner dispose, a fresh call must NOT resurrect the host (so a
      // late fire-and-forget continuation can't leak a process post-stop). The
      // caller sees a rejection and falls back to a one-shot spawn.
      disposePsHost();
      await expect(runPsHost("Write-Output 'nope'", 30_000)).rejects.toThrow();
      // An explicit warm re-enables a fresh session.
      await warmPsHost();
      const out = await runPsHost("Write-Output 're-enabled'", 30_000);
      expect(out).toContain("re-enabled");
    },
    60_000,
  );
});
