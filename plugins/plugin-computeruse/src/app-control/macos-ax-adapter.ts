/** Invokes the packaged macOS AX helper through a bounded JSON protocol without requesting permissions. */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AppActionRequest,
  AppControlAdapter,
  AppDescriptor,
  NativeAppActionResult,
  NativeAppElement,
  NativeAppSnapshot,
} from "./types.js";

const HELPER_TIMEOUT_MS = 10_000;
const MAX_HELPER_OUTPUT_BYTES = 32 * 1024 * 1024;

interface HelperResponse<T> {
  ok: boolean;
  result?: T;
  error?: { code?: string; message?: string };
}

function helperCandidates(): string[] {
  const candidates = [
    fileURLToPath(new URL("./native/macos-ax-helper", import.meta.url)),
    fileURLToPath(
      new URL("../../dist/native/macos-ax-helper", import.meta.url),
    ),
    fileURLToPath(new URL("../../native/macos-ax-helper", import.meta.url)),
    fileURLToPath(new URL("../native/macos-ax-helper", import.meta.url)),
  ];
  const override = process.env.ELIZA_COMPUTERUSE_MACOS_AX_HELPER?.trim();
  return override ? [override, ...candidates] : candidates;
}

export function resolveMacosAxHelper(): string | null {
  if (process.platform !== "darwin") return null;
  return helperCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

async function invokeHelper<T>(
  helper: string,
  request: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const child = spawn(helper, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(new Error("macOS AX helper call cancelled"));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("macOS AX helper exceeded its 10 second boundary"));
    }, HELPER_TIMEOUT_MS);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_HELPER_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("macOS AX helper response exceeded 32 MiB"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      try {
        const response = JSON.parse(
          Buffer.concat(stdout).toString("utf8"),
        ) as HelperResponse<T>;
        if (!response.ok || response.result === undefined) {
          finish(
            new Error(
              response.error?.message ??
                response.error?.code ??
                "macOS AX helper returned an unknown failure",
            ),
          );
          return;
        }
        finish(undefined, response.result);
      } catch (error) {
        // error-policy:J3 helper output is an untrusted native-process boundary.
        const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
        finish(
          new Error(
            code !== 0
              ? `macOS AX helper failed with exit ${code}: ${diagnostic || "no structured diagnostic"}`
              : error instanceof Error
                ? error.message
                : "macOS AX helper returned invalid JSON",
          ),
        );
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export class MacosAxAdapter implements AppControlAdapter {
  readonly name = "macos-ax-helper";

  available(): boolean {
    return resolveMacosAxHelper() !== null;
  }

  async listApps(signal?: AbortSignal): Promise<AppDescriptor[]> {
    return invokeHelper<AppDescriptor[]>(
      this.requireHelper(),
      {
        command: "list_apps",
      },
      signal,
    );
  }

  async snapshot(
    app: string,
    signal?: AbortSignal,
  ): Promise<NativeAppSnapshot> {
    return invokeHelper<NativeAppSnapshot>(
      this.requireHelper(),
      {
        command: "get_app_state",
        app,
      },
      signal,
    );
  }

  async perform(
    app: AppDescriptor,
    element: NativeAppElement | undefined,
    request: AppActionRequest,
    signal?: AbortSignal,
  ): Promise<NativeAppActionResult> {
    return invokeHelper<NativeAppActionResult>(
      this.requireHelper(),
      {
        command: "perform",
        app: app.id,
        action: request.kind,
        ...(element
          ? {
              locator: element.locator,
              expected: {
                role: element.role,
                label: element.label,
                bounds: element.bounds,
              },
            }
          : {}),
        ...(request.text !== undefined ? { text: request.text } : {}),
        ...(request.key !== undefined ? { key: request.key } : {}),
        ...(request.modifiers ? { modifiers: request.modifiers } : {}),
        ...(request.direction ? { direction: request.direction } : {}),
        ...(request.amount !== undefined ? { amount: request.amount } : {}),
        ...(request.format ? { format: request.format } : {}),
        ...(request.secondaryAction
          ? { secondaryAction: request.secondaryAction }
          : {}),
      },
      signal,
    );
  }

  private requireHelper(): string {
    const helper = resolveMacosAxHelper();
    if (!helper) {
      throw new Error(
        "Packaged macOS AX helper is unavailable; rebuild plugin-computeruse on macOS",
      );
    }
    return helper;
  }
}
