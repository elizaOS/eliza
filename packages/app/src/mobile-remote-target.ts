/** App-owned Android background composition; no renderer or foreground activity is required. */

import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { join } from "node:path";
import {
  ElizaError,
  type IAgentRuntime,
  resolveStateDir,
  Service,
} from "@elizaos/core";
import type { HttpPlugin, Route } from "@elizaos/core/api/http-plugin";
import { resolveAliasedEnvValue } from "@elizaos/core/config/boot-config-store";
import { REMOTE_AGENT_RESPONSE_LIMIT_BYTES } from "@elizaos/core/contracts/remote-agent-request";
import { parseRemoteBrowserCommandPayload } from "@elizaos/core/contracts/remote-control";
import { LoopbackRemoteTargetExecutor } from "../platforms/electrobun/src/remote-target-executor";
import { RemoteTargetDesktopService } from "../platforms/electrobun/src/remote-target-rpc";
import type { RemoteTargetCommandExecutor } from "../platforms/electrobun/src/remote-target-runner";
import { JsonFileRemoteTargetStateStore } from "../platforms/electrobun/src/remote-target-store";
import { RemoteTargetVault } from "../platforms/electrobun/src/remote-target-vault";
import { createAndroidPlatformSecureStore } from "./security/secure-store-android";

export function createMobileBrowserExecutor(
  runtime: IAgentRuntime,
  agentExecutor?: RemoteTargetCommandExecutor,
): RemoteTargetCommandExecutor {
  return {
    async execute(input) {
      if (input.action !== "browser.command")
        return agentExecutor
          ? agentExecutor.execute(input)
          : {
              status: "rejected",
              errorCode: "REMOTE_CAPABILITY_UNSUPPORTED",
            };
      const payload = parseRemoteBrowserCommandPayload(input.payload);
      const browser = runtime.getService("browser");
      if (
        !browser ||
        !("executeNativeDeviceCommand" in browser) ||
        typeof browser.executeNativeDeviceCommand !== "function"
      )
        return { status: "rejected", errorCode: "BROWSER_UNAVAILABLE" };
      // The signed runner records dispatch before calling us. Exceptions remain uncertain, never replayed.
      const result: unknown = await browser.executeNativeDeviceCommand(
        payload.command,
        payload.profileId,
      );
      const body = JSON.stringify(result);
      if (Buffer.byteLength(body, "utf8") > REMOTE_AGENT_RESPONSE_LIMIT_BYTES)
        return {
          status: "rejected",
          errorCode: "REMOTE_LOCAL_RESPONSE_TOO_LARGE",
        };
      return {
        status: "completed",
        result: {
          status: 200,
          body,
          headers: { "content-type": "application/json" },
        },
      };
    },
  };
}

export function createAndroidAgentExecutor(
  input = {
    apiToken: resolveAliasedEnvValue("ELIZA_API_TOKEN") ?? "",
    socketName: process.env.ELIZA_LOCAL_AGENT_SOCKET,
  },
): RemoteTargetCommandExecutor {
  const { apiToken, socketName } = input;
  if (!socketName || !/^[a-zA-Z0-9_.-]+$/.test(socketName))
    throw new ElizaError(
      "The Android app's local agent socket is unavailable.",
      { code: "REMOTE_LOCAL_SOCKET_UNAVAILABLE" },
    );
  return new LoopbackRemoteTargetExecutor({
    apiBase: "http://127.0.0.1",
    apiToken,
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(init.signal.reason);
          return;
        }
        const id = randomUUID();
        const parsed = new URL(String(url));
        const socket = connect({ path: `\0${socketName}` });
        let pending = Buffer.alloc(0);
        let settled = false;
        const finish = (error?: Error, response?: Response) => {
          if (settled) return;
          settled = true;
          init?.signal?.removeEventListener("abort", abort);
          socket.destroy();
          if (error) reject(error);
          else if (response) resolve(response);
          else
            reject(
              new ElizaError("Native agent receipt is missing.", {
                code: "REMOTE_NATIVE_RECEIPT_INVALID",
              }),
            );
        };
        const abort = () =>
          finish(
            new ElizaError(
              "Native agent request was cancelled; its effect may already have started.",
              { code: "REMOTE_NATIVE_CANCELLED" },
            ),
          );
        init?.signal?.addEventListener("abort", abort, { once: true });
        socket.once("error", (error) => finish(error));
        socket.once("close", () =>
          finish(
            new ElizaError("Native agent disconnected before its receipt.", {
              code: "REMOTE_NATIVE_DISCONNECTED",
            }),
          ),
        );
        socket.once("connect", () =>
          socket.write(
            JSON.stringify({
              id,
              method: "http_request",
              payload: {
                path: parsed.pathname + parsed.search,
                method: init?.method,
                headers: Object.fromEntries(
                  new Headers(init?.headers).entries(),
                ),
                body: init?.body,
              },
            }) + "\n",
          ),
        );
        socket.on("data", (chunk) => {
          pending = Buffer.concat([
            pending,
            typeof chunk === "string" ? Buffer.from(chunk) : chunk,
          ]);
          if (pending.length > 4 * 1024 * 1024) {
            finish(
              new ElizaError(
                "Native agent response exceeds the frame limit; no partial response is returned.",
                { code: "REMOTE_NATIVE_RESPONSE_TOO_LARGE" },
              ),
            );
            return;
          }
          const newline = pending.indexOf(10);
          if (newline < 0) return;
          try {
            const frame = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                pending.subarray(0, newline),
              ),
            );
            if (
              frame.id !== id ||
              frame.ok !== true ||
              !frame.result ||
              typeof frame.result !== "object"
            )
              throw new Error("Invalid native agent receipt");
            const result = frame.result;
            if (
              !Number.isInteger(result.status) ||
              result.status < 200 ||
              result.status > 599 ||
              !result.headers ||
              typeof result.headers !== "object" ||
              Object.values(result.headers).some(
                (value) => typeof value !== "string",
              )
            )
              throw new Error("Invalid native agent response");
            let bytes: Uint8Array<ArrayBuffer>;
            if (
              result.bodyEncoding === "base64" &&
              typeof result.bodyBase64 === "string"
            ) {
              const decoded = Buffer.from(result.bodyBase64, "base64");
              if (decoded.toString("base64") !== result.bodyBase64)
                throw new Error("Invalid native body encoding");
              bytes = decoded;
            } else if (typeof result.body === "string")
              bytes = new TextEncoder().encode(result.body);
            else throw new Error("Missing native response body");
            finish(
              undefined,
              new Response(
                [204, 205, 304].includes(result.status) ? null : bytes,
                { status: result.status, headers: result.headers },
              ),
            );
          } catch {
            // error-policy:J1 Reject malformed native receipts without exposing response data or retrying effects.
            finish(
              new ElizaError(
                "Native agent returned an invalid response receipt.",
                { code: "REMOTE_NATIVE_RECEIPT_INVALID" },
              ),
            );
          }
        });
      }),
  });
}

export class MobileRemoteTargetService extends Service {
  static override serviceType = "mobile-remote-target";
  override capabilityDescription =
    "Receives explicitly paired, signed browser commands in the Android background runtime.";
  readonly target: RemoteTargetDesktopService;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime)
      throw new ElizaError(
        "Android remote receiver requires an agent runtime.",
        { code: "REMOTE_RUNTIME_REQUIRED" },
      );
    this.target = new RemoteTargetDesktopService(
      new RemoteTargetVault(
        createAndroidPlatformSecureStore(),
        `remote-target:${runtime.agentId}`,
      ),
      new JsonFileRemoteTargetStateStore(
        join(resolveStateDir(), "remote-target", `${runtime.agentId}.json`),
      ),
    );
  }

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<MobileRemoteTargetService> {
    const service = new MobileRemoteTargetService(runtime);
    await service.target.configureBackgroundExecutor(
      createMobileBrowserExecutor(runtime, createAndroidAgentExecutor()),
    );
    try {
      await service.target.resumeEligibleBackground();
    } catch (error) {
      // error-policy:J1 Keep enrollment/status available; never replace unavailable credentials or replay authority.
      runtime.reportError("remote-target.android-resume", error);
    }
    return service;
  }

  override async stop(): Promise<void> {
    await this.target.stop();
  }
}

const operations = [
  "identity",
  "status",
  "enroll",
  "pairing",
  "pairing-status",
  "confirm",
  "activate",
  "compensate",
  "commit",
  "start",
  "stop",
  "revoke",
  "finalize-revoke",
] as const;
const routes: Route[] = operations.map((operation) => ({
  type: ["identity", "status"].includes(operation) ? "GET" : "POST",
  path: `/api/remote-target/${operation}`,
  rawPath: true,
  modes: ["local", "local-only"],
  modeReason:
    "Enrollment and browser grants belong to the authenticated local Android agent.",
  routeHandler: async ({ runtime, body, isTrustedLocal, inProcess }) => {
    if (!isTrustedLocal && !inProcess)
      return {
        status: 403,
        body: { error: "Local device authorization is required." },
      };
    const service = runtime.getService<MobileRemoteTargetService>(
      MobileRemoteTargetService.serviceType,
    );
    if (!service)
      return {
        status: 503,
        body: { error: "Android remote receiver is unavailable." },
      };
    const target = service.target;
    if (operation === "confirm" || operation === "activate") {
      const params =
        body && typeof body === "object"
          ? (body as Record<string, unknown>)
          : {};
      if (params.browserProfileId !== undefined) {
        const browser = runtime.getService("browser");
        const connected: unknown =
          browser &&
          "getNativeDeviceStatus" in browser &&
          typeof browser.getNativeDeviceStatus === "function"
            ? browser.getNativeDeviceStatus()
            : null;
        if (
          !connected ||
          typeof connected !== "object" ||
          !("profileId" in connected) ||
          connected.profileId !== params.browserProfileId
        )
          throw new ElizaError(
            "Browser authorization requires the exact connected profile.",
            { code: "BROWSER_PROFILE_MISMATCH" },
          );
      }
    }
    let result: unknown;
    switch (operation) {
      case "identity":
        result = await target.getIdentity();
        break;
      case "status":
        result = await target.status();
        break;
      case "enroll": {
        if (!body || typeof body !== "object" || Array.isArray(body))
          return {
            status: 400,
            body: { error: "Enrollment parameters are required." },
          };
        if ("managedNetwork" in body && body.managedNetwork === true)
          return {
            status: 400,
            body: { error: "Android uses the authenticated relay transport." },
          };
        result = await target.enroll({
          ...body,
          platform: "android",
          managedNetwork: false,
        });
        break;
      }
      case "pairing":
        result = await target.createPairingChallenge();
        break;
      case "pairing-status":
        result = await target.readPairingChallenge(body);
        break;
      case "confirm":
        result = await target.confirmPairing(body);
        break;
      case "activate":
        result = await target.activate(body);
        break;
      case "compensate":
        result = await target.compensateActivation(body);
        break;
      case "commit":
        result = await target.commitActivation(body);
        break;
      case "start":
        result = await target.start();
        break;
      case "stop":
        result = await target.stop();
        break;
      case "revoke":
        result = await target.revoke(body);
        break;
      case "finalize-revoke":
        result = await target.finalizeHostRevoke(body);
        break;
    }
    return { status: 200, body: result };
  },
}));

export const mobileRemoteTargetPlugin: HttpPlugin = {
  name: "mobile-remote-target",
  description: "Android app-owned signed remote browser receiver.",
  services: [MobileRemoteTargetService],
  routes,
};
