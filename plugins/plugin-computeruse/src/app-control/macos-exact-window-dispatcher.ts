/** Invokes the optional direct-only helper after explicit route selection and a successful capability probe. */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type {
  AppExactWindowDispatchResult,
  AppExactWindowPointerDispatcher,
} from "./types.js";

const ROUTE = "experimental_direct_exact_window" as const;
const HELPER_BASENAME = "computeruse-exact-window-helper";
const HELPER_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

interface HelperResponse<T> {
  ok: boolean;
  result?: T;
  error?: { code?: string; message?: string };
}

interface ProbeResult {
  route: typeof ROUTE;
  available: boolean;
  minimumMacOSMet: boolean;
  missingSymbols: string[];
  defaultEnabled: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProbeResult(value: unknown): value is ProbeResult {
  return (
    isRecord(value) &&
    value.route === ROUTE &&
    typeof value.available === "boolean" &&
    typeof value.minimumMacOSMet === "boolean" &&
    Array.isArray(value.missingSymbols) &&
    value.missingSymbols.every((symbol) => typeof symbol === "string") &&
    value.defaultEnabled === false
  );
}

function isFinitePoint(value: unknown): value is { x: number; y: number } {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y)
  );
}

function isFiniteBounds(
  value: unknown,
): value is { x: number; y: number; width: number; height: number } {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y) &&
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    value.width > 0 &&
    typeof value.height === "number" &&
    Number.isFinite(value.height) &&
    value.height > 0
  );
}

export function parseExperimentalExactWindowDispatchResult(
  value: unknown,
): AppExactWindowDispatchResult | null {
  if (
    !isRecord(value) ||
    typeof value.success !== "boolean" ||
    value.route !== ROUTE ||
    typeof value.observationId !== "string" ||
    typeof value.targetPid !== "number" ||
    !Number.isSafeInteger(value.targetPid) ||
    typeof value.targetWindowId !== "number" ||
    !Number.isSafeInteger(value.targetWindowId) ||
    !isFiniteBounds(value.targetWindowBounds) ||
    !isFinitePoint(value.pointerBefore) ||
    !isFinitePoint(value.pointerAfter)
  ) {
    return null;
  }
  return {
    success: value.success,
    route: value.route,
    observationId: value.observationId,
    targetPid: value.targetPid,
    targetWindowId: value.targetWindowId,
    targetWindowBounds: value.targetWindowBounds,
    pointerBefore: value.pointerBefore,
    pointerAfter: value.pointerAfter,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

export interface ExperimentalExactWindowDispatcherDependencies {
  resolveHelper: () => string | null;
  invokeHelper: (
    helper: string,
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

export function resolveExperimentalExactWindowHelper(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd: string = process.cwd(),
): string | null {
  if (
    platform !== "darwin" ||
    env.ELIZA_BUILD_VARIANT?.trim().toLowerCase() === "store" ||
    env.ELIZA_COMPUTERUSE_EXPERIMENTAL_EXACT_WINDOW !== "1"
  ) {
    return null;
  }
  const candidate =
    env.ELIZA_DESKTOP_PACKAGED_RUNTIME === "1"
      ? path.resolve(cwd, "..", HELPER_BASENAME)
      : env.ELIZA_COMPUTERUSE_EXACT_WINDOW_HELPER_PATH?.trim();
  if (!candidate || !path.isAbsolute(candidate)) return null;
  if (path.basename(candidate) !== HELPER_BASENAME || !existsSync(candidate)) {
    return null;
  }
  const stats = statSync(candidate);
  return stats.isFile() && (stats.mode & 0o111) !== 0 ? candidate : null;
}

async function invokeHelper<T>(
  helper: string,
  request: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const child = spawn(helper, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
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
      finish(new Error("Experimental exact-window helper call cancelled"));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Experimental exact-window helper timed out"));
    }, HELPER_TIMEOUT_MS);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(
          new Error("Experimental exact-window helper output exceeded 1 MiB"),
        );
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(
          new Error("Experimental exact-window helper output exceeded 1 MiB"),
        );
        return;
      }
      stderr.push(chunk);
    });
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
                "Experimental exact-window helper refused",
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
              ? `Experimental exact-window helper exited ${code}: ${diagnostic || "no diagnostic"}`
              : error instanceof Error
                ? error.message
                : "Experimental exact-window helper returned invalid JSON",
          ),
        );
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export class MacosExperimentalExactWindowDispatcher
  implements AppExactWindowPointerDispatcher
{
  constructor(
    private readonly dependencies: ExperimentalExactWindowDispatcherDependencies = {
      resolveHelper: () => resolveExperimentalExactWindowHelper(),
      invokeHelper,
    },
  ) {}

  available(): boolean {
    return this.dependencies.resolveHelper() !== null;
  }

  async dispatch(
    input: Parameters<AppExactWindowPointerDispatcher["dispatch"]>[0],
    signal?: AbortSignal,
  ): Promise<AppExactWindowDispatchResult> {
    const helper = this.dependencies.resolveHelper();
    if (!helper) {
      throw new Error(
        "Experimental exact-window route is disabled or unavailable in this distribution",
      );
    }
    const probe = await this.dependencies.invokeHelper(
      helper,
      { command: "probe" },
      signal,
    );
    if (
      !isProbeResult(probe) ||
      !probe.available ||
      !probe.minimumMacOSMet ||
      probe.defaultEnabled !== false ||
      probe.missingSymbols.length > 0
    ) {
      throw new Error(
        "Experimental exact-window helper failed its runtime capability probe",
      );
    }
    const targetBounds = input.element.bounds;
    const windowBounds = input.state.screenshotBounds;
    if (!targetBounds || !windowBounds) {
      throw new Error(
        "Experimental exact-window route requires exact target and window bounds",
      );
    }
    const screenPoint = {
      x: targetBounds.x + targetBounds.width / 2,
      y: targetBounds.y + targetBounds.height / 2,
    };
    const result = await this.dependencies.invokeHelper(
      helper,
      {
        command: "dispatch",
        experimental: true,
        route: ROUTE,
        observationId: input.state.stateId,
        action: input.request.kind,
        pid: input.app.pid,
        windowId: input.expectedWindowId,
        screenPoint,
        windowPoint: {
          x: screenPoint.x - windowBounds.x,
          y: screenPoint.y - windowBounds.y,
        },
        expectedWindowBounds: windowBounds,
        expectedElement: {
          locator: [...input.element.locator],
          role: input.element.role,
          subrole: input.element.subrole ?? null,
          label: input.element.label ?? null,
          value: input.element.value ?? null,
          description: input.element.description ?? null,
          bounds: targetBounds,
          actions: [...input.element.actions],
          enabled: input.element.enabled,
          focused: input.element.focused,
          selected: input.element.selected ?? null,
          secure: input.element.secure,
        },
        direction: input.request.direction,
        amount: input.request.amount,
      },
      signal,
    );
    const parsedResult = parseExperimentalExactWindowDispatchResult(result);
    if (!parsedResult) {
      throw new Error(
        "Experimental exact-window helper returned an invalid dispatch receipt",
      );
    }
    return parsedResult;
  }
}
