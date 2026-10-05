/** Explicit dependency preparation; never called by ordinary unit tests. */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../../../scripts/lib/test-output.ts";

const base = testOutputPath("gepa-producer");
await mkdir(base, { recursive: true });
const environment = join(base, "venv");
const bootstrapPython = process.env.GEPA_BOOTSTRAP_PYTHON ?? "python3.14";
const version = execFileSync(
  bootstrapPython,
  ["-c", "import platform; print(platform.python_version())"],
  { encoding: "utf8" },
).trim();
if (version !== "3.14.6")
  throw new Error(`GEPA setup requires Python 3.14.6, received ${version}`);
execFileSync(bootstrapPython, ["-m", "venv", environment], {
  stdio: "inherit",
});
const python = join(
  environment,
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
execFileSync(
  python,
  [
    "-m",
    "pip",
    "install",
    "--require-hashes",
    "--force-reinstall",
    "--no-deps",
    "-r",
    fileURLToPath(new URL("../gepa/requirements.txt", import.meta.url)),
  ],
  { stdio: "inherit" },
);
const receipt = execFileSync(
  python,
  [
    "-c",
    'import sys,json,importlib.metadata; print(json.dumps({"python":sys.version,"gepa":importlib.metadata.version("gepa"),"source":json.loads(importlib.metadata.distribution("gepa").read_text("direct_url.json"))},indent=2))',
  ],
  { encoding: "utf8" },
);
await writeFile(join(base, "setup-receipt.json"), receipt);
process.stdout.write(`${python}\n`);
