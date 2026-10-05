/**
 * Mobile React stub e2e. iOS bundles alias `react`/`react-dom` to Proxy-backed
 * CommonJS stubs. Bun lowers `import * as React` by copying the stub's own
 * property names onto a namespace object, so Proxy traps alone left
 * `React.useState` undefined. A separate Bun process bundles and runs a real
 * namespace-importing entry against the shipped stubs for both iOS targets.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "fixtures", "mobile-react-stub-bundle-child.ts");
const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function runChild(workDir: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn("bun", [CHILD, workDir], {
        cwd: path.join(HERE, ".."),
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`mobile stub bundle child timed out\n${stderr}`));
      }, 60_000);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("error", reject);
      child.once("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    },
  );
}

it("bundled namespace imports of the mobile React stubs expose named exports", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "eliza-mobile-react-"));
  directories.push(workDir);
  const { status, stdout, stderr } = await runChild(workDir);
  expect(status, stderr).toBe(0);
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("STUB_RESULT="));
  expect(line, stdout).toBeDefined();
  const results = JSON.parse(line?.slice("STUB_RESULT=".length) ?? "{}");
  for (const target of ["bun", "browser"]) {
    const result = results[target];
    expect(result.reactKeys).toEqual(
      expect.arrayContaining([
        "Fragment",
        "createElement",
        "useEffect",
        "useState",
      ]),
    );
    expect(result.reactDomKeys).toEqual(
      expect.arrayContaining(["createPortal", "createRoot", "flushSync"]),
    );
    expect(result).toMatchObject({
      state: "initial",
      namedUseState: "function",
      createElement: "function",
      fragment: "symbol",
      version: "0.0.0-mobile-stub",
      createPortal: "function",
      createRoot: "function",
    });
  }
});
