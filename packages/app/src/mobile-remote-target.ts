/** App-owned Android background composition; no renderer or foreground activity is required. */

import { request as requestHttp } from "node:http";
import { join } from "node:path";
import {
  ElizaError,
  type IAgentRuntime,
  resolveStateDir,
  Service,
} from "@elizaos/core";
import type { HttpPlugin, Route } from "@elizaos/shared/api/http-plugin";
import { REMOTE_AGENT_RESPONSE_LIMIT_BYTES } from "@elizaos/shared/contracts/remote-agent-request";
import { parseRemoteBrowserCommandPayload } from "@elizaos/shared/contracts/remote-control";
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
    apiToken: process.env.ELIZA_API_TOKEN ?? "",
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
        const parsed = new URL(String(url));
        const request = requestHttp(
          {
            socketPath: `\0${socketName}`,
            path: parsed.pathname + parsed.search,
            method: init?.method,
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            signal: init?.signal ?? undefined,
          },
          (response) => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers))
              if (value !== undefined)
                headers.set(
                  name,
                  Array.isArray(value) ? value.join(", ") : value,
                );
            const chunks = response[Symbol.asyncIterator]();
            const body = new ReadableStream<Uint8Array>({
              async pull(controller) {
                const chunk = await chunks.next();
                if (chunk.done) controller.close();
                else
                  controller.enqueue(
                    Buffer.isBuffer(chunk.value)
                      ? chunk.value
                      : Buffer.from(chunk.value),
                  );
              },
              cancel() {
                response.destroy();
              },
            });
            resolve(
              new Response(
                [204, 205, 304].includes(response.statusCode ?? 502)
                  ? null
                  : body,
                { status: response.statusCode ?? 502, headers },
              ),
            );
          },
        );
        request.once("error", reject);
        request.end(init?.body);
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
