// Electrobun lifecycle hooks execute a Bun file path, not a shell command.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { build } from "vite";

if (process.platform === "linux") {
  execFileSync(
    "bash",
    ["native/build-raw-writer.sh", resolve("native/build/linux-raw-writer")],
    { stdio: "inherit" },
  );
}

await build();
