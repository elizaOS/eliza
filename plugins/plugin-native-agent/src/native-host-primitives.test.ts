import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

// The harness compiles and runs 24 JVM contracts, including process-death cases.
// Its deadline owns the entire child group; allow that supervisor to reap it
// before the outer process or Vitest deadline can interrupt cleanup.
const harnessDeadlineMs = 300_000;

test(
  "native host persistence and lifecycle survive process death and stale callbacks",
  () => {
    execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../../../packages/scripts/run-with-deadline.ts",
            import.meta.url,
          ),
        ),
        String(harnessDeadlineMs),
        "--",
        process.execPath,
        fileURLToPath(
          new URL("../scripts/test-native-host.mjs", import.meta.url),
        ),
      ],
      { stdio: "inherit", timeout: harnessDeadlineMs + 20_000 },
    );
  },
  harnessDeadlineMs + 30_000,
);
