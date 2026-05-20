import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginRoot = fileURLToPath(new URL("../..", import.meta.url));
const describeLive =
  process.env.RUN_LIVE_NATIVE_ACP === "1" ? describe : describe.skip;

describeLive("Native ACP smoke (live, gated by RUN_LIVE_NATIVE_ACP=1)", () => {
  it(
    "completes a tiny prompt through a native ACP adapter",
    () => {
      const result = spawnSync(
        process.execPath,
        ["tests/e2e/live-native-acp-smoke.mjs"],
        {
          cwd: pluginRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            ELIZA_ACP_TRANSPORT: process.env.ELIZA_ACP_TRANSPORT ?? "native",
          },
          timeout: Number(
            process.env.LIVE_NATIVE_ACP_TEST_TIMEOUT_MS ?? 180_000,
          ),
        },
      );

      const output = [
        result.stdout,
        result.stderr,
        result.error?.stack ?? result.error?.message,
      ]
        .filter(Boolean)
        .join("\n");

      expect(result.status, output).toBe(0);
      expect(output, output).toMatch(/NATIVE ACP SMOKE (PASSED|SKIPPED)/);
    },
    Number(process.env.LIVE_NATIVE_ACP_TEST_TIMEOUT_MS ?? 180_000),
  );
});
