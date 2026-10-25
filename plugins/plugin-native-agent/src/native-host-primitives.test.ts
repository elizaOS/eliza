import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

test("native host persistence and lifecycle survive process death and stale callbacks", () => {
  execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../scripts/test-native-host.mjs", import.meta.url),
      ),
    ],
    { stdio: "inherit", timeout: 120000 },
  );
}, 130000);
