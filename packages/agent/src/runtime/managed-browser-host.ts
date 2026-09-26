/** Owner-bound remote browser composition for the dedicated CLI host. */
import {
  ElizaError,
  type HttpPlugin,
  type IAgentRuntime,
  registerHttpPluginRoutes,
} from "@elizaos/core";
import { resetHonoMountCache } from "../api/hono-mount.ts";

/** Provisioning supplies owner identity; it never grants a browser profile. */
export async function initializeManagedBrowserHost(
  runtime: IAgentRuntime,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const ownerId = env.ELIZA_RUNTIME_OWNER_ID?.trim();
  if (!ownerId) return;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(ownerId))
    throw new ElizaError("Managed browser owner identity is invalid.", {
      code: "REMOTE_BROWSER_OWNER_INVALID",
    });
  const [{ BrowserService, browserPlugin }, remoteHost] = await Promise.all([
    import("@elizaos/plugin-browser"),
    import("@elizaos/remote-control-host"),
  ]);
  if (!runtime.getService("browser")) {
    // The ordinary constructor initializes the target registry. Local start()
    // additionally boots native/workspace/Stagehand targets, which a managed
    // remote host must not launch. Only a persisted or explicit owner grant
    // may register a target here, through the existing controller.
    class RemoteBrowserService extends BrowserService {
      static override async start(
        host: IAgentRuntime,
      ): Promise<RemoteBrowserService> {
        return new RemoteBrowserService(host);
      }
    }
    const plugin: HttpPlugin = {
      ...browserPlugin,
      preflight: undefined,
      services: [RemoteBrowserService],
      routes: [],
    };
    await runtime.registerPlugin(plugin);
    await runtime.getServiceLoadPromise("browser");
  }
  registerHttpPluginRoutes(
    runtime,
    remoteHost.createRemoteBrowserControllerPlugin(ownerId),
  );
  resetHonoMountCache();
  await remoteHost.restoreRemoteBrowserController(runtime, ownerId);
}
