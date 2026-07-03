/**
 * Parent-runtime wiring for the sub-agent credential bridge (#10317).
 *
 * Instantiates one `CredentialTunnelService` per parent runtime, builds the
 * bridge adapter, and registers it under BOTH well-known service names so:
 *   - the orchestrator's bridge routes resolve `SubAgentCredentialBridgeAdapter`
 *     (no more `503 no_adapter`), and
 *   - the core DECLARE/TUNNEL actions resolve `SubAgentCredentialBridge`.
 * It also registers `subAgentCredentialsPlugin` (the DECLARE/TUNNEL/AWAIT/
 * RETRIEVE actions) on the parent.
 *
 * GATING: parent (non-sandboxed) runtimes only. The bridge is meaningful only
 * where the orchestrator can spawn coding sub-agents, which is exactly where
 * the ACP subprocess service is registered. A sandboxed child runtime has no
 * ACP service, resolves no adapter, and degrades to the existing
 * "service unavailable" path.
 *
 * SECURITY: the scoped bearer token and credential values never leave the
 * tunnel service. The dispatch seam here returns identifiers only.
 */

import {
  type AgentRuntime,
  createSensitiveRequestDispatchRegistry,
  type IAgentRuntime,
  logger,
  SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE,
  type SensitiveRequestDispatchRegistry,
  Service,
  SUB_AGENT_CREDENTIAL_BRIDGE_ADAPTER_SERVICE,
  SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
  SUB_AGENT_CREDENTIAL_PARENT_CAPABILITY_SERVICE,
  subAgentCredentialsPlugin,
} from "@elizaos/core";
import {
  createCredentialTunnelService,
  createSubAgentCredentialBridgeAdapter,
} from "../services/credential-tunnel-service.js";

const BRIDGE_ACTIONS_MARKER_SERVICE = "SubAgentCredentialBridgeActions";

function isDispatchRegistry(
  value: unknown,
): value is SensitiveRequestDispatchRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { get?: unknown }).get === "function" &&
    typeof (value as { list?: unknown }).list === "function"
  );
}

/**
 * Register a ready singleton object as a runtime service under `serviceTypeName`
 * and force-start it so the synchronous `getService(name)` resolves it
 * immediately. The instance's own methods are projected onto a thin `Service`
 * subclass so callers that expect `Service & T` get a real Service instance.
 */
async function registerSingletonRuntimeService(
  runtime: IAgentRuntime,
  serviceTypeName: string,
  instance: object,
  capabilityDescription: string,
): Promise<void> {
  const cap = capabilityDescription;
  class SingletonRuntimeService extends Service {
    static serviceType = serviceTypeName;
    capabilityDescription = cap;
    async stop(): Promise<void> {}
    static async start(rt: IAgentRuntime): Promise<Service> {
      return Object.assign(new SingletonRuntimeService(rt), instance);
    }
  }
  await runtime.registerService(SingletonRuntimeService);
  // registerService is lazy; force the start so a synchronous getService() in a
  // loopback route sees the instance without awaiting.
  await runtime.getServiceLoadPromise(serviceTypeName);
}

/**
 * Wire the credential bridge onto a parent runtime. No-op (and safe to call
 * repeatedly across hot-reloads) on child/sandboxed runtimes or when already
 * registered.
 */
export async function registerSubAgentCredentialBridge(
  runtime: AgentRuntime,
): Promise<void> {
  // Parent gate: only runtimes that can host coding sub-agents.
  if (!runtime.hasService(SUB_AGENT_CREDENTIAL_PARENT_CAPABILITY_SERVICE))
    return;

  // Idempotent for service registration. In the normal app-core boot tail,
  // registerSubAgentCredentialBridgeAdapter runs first and installs these
  // services from the sensitive-request registry. This wiring step still owns
  // action-plugin registration below, so do not return early here.
  if (!runtime.hasService(SUB_AGENT_CREDENTIAL_BRIDGE_ADAPTER_SERVICE)) {
    const maybeDispatch = runtime.getService(
      SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE,
    );
    const dispatch = isDispatchRegistry(maybeDispatch)
      ? maybeDispatch
      : createSensitiveRequestDispatchRegistry();
    const adapter = createSubAgentCredentialBridgeAdapter({
      tunnel: createCredentialTunnelService(),
      dispatch,
      runtime,
    });

    await registerSingletonRuntimeService(
      runtime,
      SUB_AGENT_CREDENTIAL_BRIDGE_ADAPTER_SERVICE,
      adapter,
      "Sub-agent credential bridge adapter: scoped one-shot credential tunneling for coding sub-agents.",
    );
    await registerSingletonRuntimeService(
      runtime,
      SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
      adapter,
      "Sub-agent credential bridge: declare a one-shot scope and tunnel a credential to a child session.",
    );
  }

  // DECLARE/TUNNEL/AWAIT/RETRIEVE actions — parent runtime only. (AWAIT/RETRIEVE
  // resolve the decision-bus / results-client services, which are not wired
  // here and degrade cleanly to "service unavailable".)
  if (!runtime.hasService(BRIDGE_ACTIONS_MARKER_SERVICE)) {
    await runtime.registerPlugin(subAgentCredentialsPlugin);
    await registerSingletonRuntimeService(
      runtime,
      BRIDGE_ACTIONS_MARKER_SERVICE,
      {},
      "Sub-agent credential bridge action registration marker.",
    );
  }

  logger.info(
    "[sub-agent-credentials] credential bridge + actions registered on parent runtime",
  );
}
