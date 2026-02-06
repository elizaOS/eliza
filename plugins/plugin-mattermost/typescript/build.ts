import { spawn } from "node:child_process";

const tsc = spawn("npx", ["tsc", "-p", "tsconfig.json"], {
  stdio: "inherit",
  shell: true,
});

tsc.on("close", (code) => {
  process.exit(code ?? 0);
});
