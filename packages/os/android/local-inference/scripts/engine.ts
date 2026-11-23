// spec/os/build/androidHost.md, "An os module comes from the closed list once, whole or as a subset of its main or androidTest sources, with the os modules it needs"
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The local-inference module directory these producer scripts belong to. */
export const moduleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The engine pin and toolchain of `engine.lock.json`. */
export const engineLock = JSON.parse(readFileSync(path.join(moduleDir, "engine.lock.json"), "utf8")) as {
  engine: { repository: string; commit: string; ffiInclude: string; library: string };
  toolchain: { ndk: string; cmake: string };
};

/**
 * The consumer's checkout of the pinned elizaOS/llama.cpp fork, named by ELIZA_INFERENCE_ENGINE_DIR;
 * refused when it is absent or at another commit than `engine.lock.json` pins.
 * @throws {Error}
 */
export function engineDir(): string {
  const named = process.env.ELIZA_INFERENCE_ENGINE_DIR;
  if (!named) throw new Error("set ELIZA_INFERENCE_ENGINE_DIR to a checkout of the pinned engine (engine.lock.json)");
  const dir = path.resolve(named);
  if (!existsSync(path.join(dir, "tools/omnivoice/CMakeLists.txt"))) throw new Error(`no engine checkout at ${dir}`);
  const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== engineLock.engine.commit) throw new Error(`engine checkout is at ${head}; engine.lock.json pins ${engineLock.engine.commit}`);
  return dir;
}
