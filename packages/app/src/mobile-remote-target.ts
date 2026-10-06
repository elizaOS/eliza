/** App-owned Android background composition; no renderer or foreground activity is required. */

import { join } from "node:path";
import {
  parseRemoteBrowserCommandPayload,
  REMOTE_AGENT_RESPONSE_LIMIT_BYTES,
} from "@elizaos/contracts";
import {
  ElizaError,
  type IAgentRuntime,
  resolveStateDir,
  Service,
} from "@elizaos/core";
import type { HttpPlugin, Route } from "@elizaos/host/protocol";
import { resolveAppAliasedEnvValue as resolveAliasedEnvValue } from "@elizaos/host/protocol";
import { dispatchBufferedRequest } from "@elizaos/plugin-native-inference/android/dispatch";
import { LoopbackRemoteTargetExecutor } from "../platforms/electrobun/src/remote-target-executor";
import { RemoteTargetDesktopService } from "../platforms/electrobun/src/remote-target-rpc";
import type { RemoteTargetCommandExecutor } from "../platforms/electrobun/src/remote-target-runner";
import { JsonFileRemoteTargetStateStore } from "../platforms/electrobun/src/remote-target-store";
import type { RemoteTargetFetch } from "../platforms/electrobun/src/remote-target-transport";
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

export async function createAndroidAgentFetch(
  runtime: IAgentRuntime,
): Promise<RemoteTargetFetch> {
  // Lazy import follows Android bridge composition and avoids an eager agent/app cycle.
  const kernel = await import("@elizaos/agent");
  return async (url, init) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    const parsed = new URL(String(url));
    // LoopbackRemoteTargetExecutor retains its canonical route/action allowlist,
    // execution correlation, response cap and uncertain-effect timeout handling.
    const dispatched = dispatchBufferedRequest(
      runtime,
      kernel.dispatchApiRoute,
      {
        path: parsed.pathname + parsed.search,
        method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: init?.body,
      },
      {
        fullApiKernel: true,
        configFileExists: kernel.configFileExists,
        loadElizaConfig: kernel.loadElizaConfig,
        saveElizaConfig: kernel.saveElizaConfig,
        hasPersistedFirstRunState: kernel.hasPersistedFirstRunState,
      },
      init?.signal ?? undefined,
    );
    const response = await new Promise<Awaited<typeof dispatched>>(
      (resolve, reject) => {
        let settled = false;
        const finish = (error: unknown, value?: Awaited<typeof dispatched>) => {
          if (settled) return;
          settled = true;
          init?.signal?.removeEventListener("abort", abort);
          if (error !== undefined) reject(error);
          else if (value !== undefined) resolve(value);
          else reject(new Error("Native dispatch returned no response"));
        };
        const abort = () =>
          finish(
            init?.signal?.reason ??
              new Error("Native dispatch cancelled; outcome uncertain"),
          );
        init?.signal?.addEventListener("abort", abort, { once: true });
        if (init?.signal?.aborted) abort();
        // Attach both handlers even after abort: late dispatch completion cannot
        // become an unhandled rejection or cause a second dispatch.
        dispatched.then(
          (value) => finish(undefined, value),
          (error) => finish(error),
        );
      },
    );
    // Dispatch may have committed an effect; an abort never triggers replay.
    if (init?.signal?.aborted) throw init.signal.reason;
    if (
      response.bodyBase64.length >
      Math.ceil(REMOTE_AGENT_RESPONSE_LIMIT_BYTES / 3) * 4
    )
      throw new ElizaError(
        "Native agent encoded response exceeds the canonical limit.",
        { code: "REMOTE_NATIVE_RESPONSE_TOO_LARGE" },
      );
    const bytes = Buffer.from(response.bodyBase64, "base64");
    if (
      bytes.length > REMOTE_AGENT_RESPONSE_LIMIT_BYTES ||
      bytes.toString("base64") !== response.bodyBase64
    )
      throw new ElizaError(
        "Native agent response exceeds the canonical limit.",
        { code: "REMOTE_NATIVE_RESPONSE_TOO_LARGE" },
      );
    return new Response(
      [204, 205, 304].includes(response.status) ? null : bytes,
      { status: response.status, headers: response.headers },
    );
  };
}

export async function createAndroidAgentExecutor(
  runtime: IAgentRuntime,
): Promise<RemoteTargetCommandExecutor> {
  return new LoopbackRemoteTargetExecutor({
    apiBase: "http://127.0.0.1",
    apiToken: resolveAliasedEnvValue("ELIZA_API_TOKEN") ?? "",
    fetchImpl: await createAndroidAgentFetch(runtime),
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
      createMobileBrowserExecutor(
        runtime,
        await createAndroidAgentExecutor(runtime),
      ),
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
