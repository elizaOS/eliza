/**
 * Docker sandbox backend.
 *
 * Spawns a Docker container with X11 + xdotool + scrot pre-installed (the
 * caller must build or pull such an image — default name `cua/linux:latest`)
 * and proxies every CUA op through `docker exec` against an in-container
 * helper. The helper is a self-contained Python script that this backend
 * `docker cp`s into the running container at `start()`.
 *
 * Why a helper instead of running each op as its own xdotool/scrot shell?
 *   - Single entry point makes the wire format consistent across all ops.
 *   - Saves us from re-encoding key/modifier mappings per call.
 *   - Lets Phase 2 swap the transport (virtio-serial) without touching ops.
 *
 * The image MUST satisfy:
 *   - python3 on PATH
 *   - xdotool, scrot installed
 *   - an X session reachable on $DISPLAY (or Xvfb running)
 *   - bash on PATH
 *
 * We do NOT ship the image. The default name `cua/linux:latest` is a
 * convention only; operators bring their own.
 */

import {
  type ChildProcessWithoutNullStreams,
  spawn,
} from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SandboxBackendUnavailableError,
  SandboxInvocationError,
  type SandboxBackend,
  type SandboxOp,
} from "./types.js";

export interface DockerBackendOptions {
  /** Container image (default `cua/linux:latest`). */
  image: string;
  /** Extra `docker run` args (mounts, networks, ...). Optional. */
  runArgs?: string[];
  /** Env vars exposed inside the container. */
  env?: Record<string, string>;
  /** Override the Docker CLI binary (default `docker`). */
  dockerBinary?: string;
  /**
   * Override the helper transport. Tests inject a stub that bypasses the
   * actual `docker exec` spawn. Production code does not pass this.
   */
  spawnExec?: (
    binary: string,
    args: string[],
  ) => ChildProcessWithoutNullStreams;
  /**
   * Override the synchronous shell-out used for `docker run`/`docker rm`/
   * `docker cp`. Tests inject a stub.
   */
  runShell?: (
    binary: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
}

const DEFAULT_IMAGE = "cua/linux:latest";

/**
 * In-container Python helper. Speaks one JSON envelope per stdin line, emits
 * one JSON response per stdout line. Kept inline as a string so the backend
 * can `docker cp` it without packaging concerns.
 */
const HELPER_SCRIPT = `#!/usr/bin/env python3
"""
plugin-computeruse Docker sandbox helper.
One JSON op per stdin line, one JSON response per stdout line.
Errors return {"ok": false, "error": "..."}.
"""
import base64
import json
import os
import subprocess
import sys
import tempfile

def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)

def screenshot(region):
    fd, path = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        if region:
            geom = "%dx%d+%d+%d" % (region["width"], region["height"], region["x"], region["y"])
            r = run(["scrot", "-a", geom, path, "-o"])
        else:
            r = run(["scrot", path, "-o"])
        if r.returncode != 0:
            return {"ok": False, "error": r.stderr.strip() or "scrot failed"}
        with open(path, "rb") as f:
            data = base64.b64encode(f.read()).decode("ascii")
        return {"ok": True, "result": {"base64Png": data}}
    finally:
        try: os.unlink(path)
        except OSError: pass

def mouse_move(x, y):
    r = run(["xdotool", "mousemove", str(x), str(y)])
    return {"ok": r.returncode == 0, "error": r.stderr.strip() or None}

def mouse_click(x, y, button=1, repeat=1):
    r = run(["xdotool", "mousemove", str(x), str(y), "click", "--repeat", str(repeat), str(button)])
    return {"ok": r.returncode == 0, "error": r.stderr.strip() or None}

def mouse_drag(x1, y1, x2, y2):
    r = run([
        "xdotool", "mousemove", str(x1), str(y1),
        "mousedown", "1",
        "mousemove", str(x2), str(y2),
        "mouseup", "1",
    ])
    return {"ok": r.returncode == 0, "error": r.stderr.strip() or None}

def mouse_scroll(x, y, direction, amount):
    button = {"up": 4, "down": 5, "left": 6, "right": 7}.get(direction, 5)
    r = run(["xdotool", "mousemove", str(x), str(y), "click", "--repeat", str(amount), str(button)])
    return {"ok": r.returncode == 0, "error": r.stderr.strip() or None}

def keyboard_type(text):
    r = run(["xdotool", "type", "--", text])
    return {"ok": r.returncode == 0, "error": r.stderr.strip() or None}

def keyboard_key(key):
    r = run(["xdotool", "key", "--", key])
    return {"ok": r.returncode == 0, "error": r.stderr.strip() or None}

def list_windows():
    r = run(["xdotool", "search", "--name", ""])
    if r.returncode != 0:
        return {"ok": False, "error": r.stderr.strip() or "xdotool search failed"}
    out = []
    for line in r.stdout.splitlines():
        wid = line.strip()
        if not wid: continue
        n = run(["xdotool", "getwindowname", wid])
        title = n.stdout.strip() if n.returncode == 0 else ""
        out.append({"id": wid, "title": title, "app": title})
    return {"ok": True, "result": {"windows": out}}

def focus_window(wid):
    r = run(["xdotool", "windowactivate", wid])
    return {"ok": r.returncode == 0, "error": r.stderr.strip() or None}

def list_processes():
    r = run(["ps", "-eo", "pid=,comm="])
    if r.returncode != 0:
        return {"ok": False, "error": r.stderr.strip() or "ps failed"}
    procs = []
    for line in r.stdout.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2: continue
        try:
            procs.append({"pid": int(parts[0]), "name": parts[1]})
        except ValueError:
            pass
    return {"ok": True, "result": {"processes": procs}}

def run_command(cmd, cwd=None, timeout=None):
    try:
        r = subprocess.run(["/bin/bash", "-c", cmd], capture_output=True, text=True, cwd=cwd, timeout=timeout)
        return {"ok": True, "result": {
            "success": r.returncode == 0,
            "output": (r.stdout + ("\\n" + r.stderr if r.stderr else ""))[:5000],
            "exitCode": r.returncode,
            "exit_code": r.returncode,
            "cwd": cwd or os.getcwd(),
        }}
    except subprocess.TimeoutExpired:
        return {"ok": True, "result": {"success": False, "output": "", "exitCode": -1, "exit_code": -1, "error": "timeout"}}

def read_file(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return {"ok": True, "result": {"success": True, "path": path, "content": f.read()[:10000]}}
    except OSError as e:
        return {"ok": True, "result": {"success": False, "error": str(e)}}

def write_file(path, content):
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return {"ok": True, "result": {"success": True, "path": path, "message": "File written."}}
    except OSError as e:
        return {"ok": True, "result": {"success": False, "error": str(e)}}

def dispatch(op):
    kind = op.get("kind")
    if kind == "screenshot":   return screenshot(op.get("region"))
    if kind == "mouse_move":   return mouse_move(op["x"], op["y"])
    if kind == "mouse_click":  return mouse_click(op["x"], op["y"], 1, 1)
    if kind == "mouse_double_click": return mouse_click(op["x"], op["y"], 1, 2)
    if kind == "mouse_right_click":  return mouse_click(op["x"], op["y"], 3, 1)
    if kind == "mouse_drag":   return mouse_drag(op["x1"], op["y1"], op["x2"], op["y2"])
    if kind == "mouse_scroll": return mouse_scroll(op["x"], op["y"], op["direction"], op.get("amount", 3))
    if kind == "keyboard_type":     return keyboard_type(op["text"])
    if kind == "keyboard_key_press":return keyboard_key(op["key"])
    if kind == "keyboard_hotkey":   return keyboard_key(op["combo"])
    if kind == "list_windows":  return list_windows()
    if kind == "focus_window":  return focus_window(op["window_id"])
    if kind == "list_processes":return list_processes()
    if kind == "run_command":   return run_command(op["command"], op.get("cwd"), op.get("timeout_seconds"))
    if kind == "read_file":     return read_file(op["path"])
    if kind == "write_file":    return write_file(op["path"], op["content"])
    return {"ok": False, "error": "unknown op: %s" % kind}

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try:
            op = json.loads(line)
            resp = dispatch(op)
        except Exception as e:
            resp = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
        sys.stdout.write(json.dumps(resp) + "\\n")
        sys.stdout.flush()

if __name__ == "__main__":
    main()
`;

const HELPER_PATH = "/tmp/computeruse-sandbox-helper.py";

/**
 * Run a one-shot CLI command (docker run / cp / rm). Used by `start()` and
 * `stop()`. Tests can inject `runShell` to skip the real spawn.
 */
async function defaultRunShell(
  binary: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

export class DockerBackend implements SandboxBackend {
  readonly name = "docker";
  private containerId: string | null = null;
  private helper: ChildProcessWithoutNullStreams | null = null;
  private pending: {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    op: SandboxOp["kind"];
  }[] = [];
  private stdoutBuffer = "";
  private readonly image: string;
  private readonly runArgs: string[];
  private readonly env: Record<string, string>;
  private readonly dockerBinary: string;
  private readonly spawnExec: NonNullable<DockerBackendOptions["spawnExec"]>;
  private readonly runShell: NonNullable<DockerBackendOptions["runShell"]>;

  constructor(options: DockerBackendOptions = { image: DEFAULT_IMAGE }) {
    this.image = options.image || DEFAULT_IMAGE;
    this.runArgs = options.runArgs ?? [];
    this.env = options.env ?? {};
    this.dockerBinary = options.dockerBinary ?? "docker";
    this.spawnExec =
      options.spawnExec ??
      ((binary, args) =>
        spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] }));
    this.runShell = options.runShell ?? defaultRunShell;
  }

  async start(): Promise<void> {
    if (this.containerId) return;

    const envFlags = Object.entries(this.env).flatMap(([k, v]) => [
      "-e",
      `${k}=${v}`,
    ]);
    const runResult = await this.runShell(this.dockerBinary, [
      "run",
      "-d",
      "--rm",
      ...envFlags,
      ...this.runArgs,
      this.image,
      "sleep",
      "infinity",
    ]);
    if (runResult.code !== 0) {
      throw new SandboxBackendUnavailableError(
        `docker run failed (code ${runResult.code}): ${runResult.stderr.trim() || runResult.stdout.trim()}`,
        "docker",
      );
    }
    this.containerId = runResult.stdout.trim();
    if (!this.containerId) {
      throw new SandboxBackendUnavailableError(
        "docker run returned no container id",
        "docker",
      );
    }

    const tmp = await mkdtemp(join(tmpdir(), "cua-helper-"));
    const helperHostPath = join(tmp, "helper.py");
    try {
      await writeFile(helperHostPath, HELPER_SCRIPT, { encoding: "utf8" });
      const cpResult = await this.runShell(this.dockerBinary, [
        "cp",
        helperHostPath,
        `${this.containerId}:${HELPER_PATH}`,
      ]);
      if (cpResult.code !== 0) {
        throw new SandboxBackendUnavailableError(
          `docker cp helper failed: ${cpResult.stderr.trim()}`,
          "docker",
        );
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }

    this.helper = this.spawnExec(this.dockerBinary, [
      "exec",
      "-i",
      this.containerId,
      "python3",
      HELPER_PATH,
    ]);
    this.helper.stdout.on("data", (chunk) => this.handleStdout(String(chunk)));
    this.helper.stderr.on("data", () => {
      // Helper stderr is informational; suppress to keep the wire silent.
    });
    this.helper.once("close", (code) => this.handleHelperExit(code));
  }

  async stop(): Promise<void> {
    if (this.helper) {
      try {
        this.helper.stdin.end();
      } catch {
        // ignore
      }
      this.helper = null;
    }
    const id = this.containerId;
    this.containerId = null;
    if (id) {
      await this.runShell(this.dockerBinary, ["rm", "-f", id]);
    }
    while (this.pending.length > 0) {
      const next = this.pending.shift();
      next?.reject(new Error("Sandbox stopped before response."));
    }
  }

  async invoke<TResult>(op: SandboxOp): Promise<TResult> {
    if (!this.helper || !this.containerId) {
      throw new SandboxInvocationError(
        "Docker backend not started.",
        op.kind,
      );
    }
    return new Promise<TResult>((resolve, reject) => {
      this.pending.push({
        resolve: resolve as (value: unknown) => void,
        reject,
        op: op.kind,
      });
      this.helper?.stdin.write(`${JSON.stringify(op)}\n`);
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let nl = this.stdoutBuffer.indexOf("\n");
    while (nl >= 0) {
      const line = this.stdoutBuffer.slice(0, nl);
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      nl = this.stdoutBuffer.indexOf("\n");
      const next = this.pending.shift();
      if (!next) continue;
      let parsed: { ok: boolean; result?: unknown; error?: string };
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        next.reject(
          new SandboxInvocationError(
            `Helper produced unparseable JSON for ${next.op}: ${err instanceof Error ? err.message : String(err)}`,
            next.op,
          ),
        );
        continue;
      }
      if (parsed.ok) {
        next.resolve(parsed.result);
      } else {
        next.reject(
          new SandboxInvocationError(
            parsed.error ?? `Helper rejected ${next.op}.`,
            next.op,
          ),
        );
      }
    }
  }

  private handleHelperExit(code: number | null): void {
    while (this.pending.length > 0) {
      const next = this.pending.shift();
      next?.reject(
        new SandboxInvocationError(
          `Helper exited (code ${code ?? "null"}) before responding.`,
          next.op,
        ),
      );
    }
  }
}
