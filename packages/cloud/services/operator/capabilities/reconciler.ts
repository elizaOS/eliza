/** Applies Server resources and routing state, then records the successfully observed generation. */
import { K8s, Log } from "pepr";
import { applyResources } from "./controller/generators";
import { Server } from "./crd/generated/server-v1alpha1";
import { getPreviousAgentIds } from "./previous-agents";
import {
  cleanupServer,
  removeAgentServer,
  setAgentServer,
  setServerState,
} from "./redis";

export async function reconciler(instance: Server) {
  const name = instance.metadata?.name;
  const ns = instance.metadata?.namespace ?? "eliza-agents";
  const generation = instance.metadata?.generation ?? 0;
  const observed = instance.status?.observedGeneration ?? 0;

  if (!name) {
    Log.warn("Server CR missing metadata.name, skipping");
    return;
  }

  // Skip deleted custom resources because the finalizer owns release work
  if (instance.metadata?.deletionTimestamp) {
    Log.debug(`Server ${name}: being deleted, skipping reconcile`);
    return;
  }

  if (observed >= generation && generation > 0) {
    Log.debug(`Server ${name}: generation ${generation} already reconciled`);
    return;
  }

  Log.info(`Reconciling Server ${name} (gen ${generation})`);

  await applyResources(instance);
  Log.info(`Server ${name}: K8s resources applied`);

  const url = `http://${name}.${ns}.svc:3000`;
  await setServerState(name, "pending", url);

  const agents = instance.spec.agents ?? [];
  const currentAgentIds = agents.map((a) => a.agentId.toLowerCase());
  for (const agent of agents) {
    await setAgentServer(agent.agentId.toLowerCase(), name);
  }

  const previousAgentIds = getPreviousAgentIds(instance);
  const removedAgents = previousAgentIds.filter(
    (id) => !currentAgentIds.includes(id),
  );
  for (const agentId of removedAgents) {
    await removeAgentServer(agentId);
    Log.info(`Server ${name}: removed agent mapping ${agentId}`);
  }

  // Persist current agent IDs so the next reconcile can detect removals
  await K8s(Server).Apply(
    {
      apiVersion: "eliza.ai/v1alpha1",
      kind: "Server",
      metadata: {
        name,
        namespace: ns,
        annotations: {
          "eliza.ai/previous-agents": JSON.stringify(currentAgentIds),
        },
      },
      spec: instance.spec,
    },
    { force: true },
  );

  await patchServerStatus(name, ns, {
    phase: "Pending",
    readyAgents: 0,
    totalAgents: agents.length,
    replicas: 0,
    podNames: [],
    lastActivity: new Date().toISOString(),
    observedGeneration: generation,
  });

  Log.info(`Server ${name}: reconciliation complete`);
}

export async function finalizer(instance: Server) {
  const name = instance.metadata?.name;
  if (!name) return;

  Log.info(`Finalizing Server ${name}: cleaning up Redis`);

  const agentIds =
    instance.spec?.agents?.map((a) => a.agentId.toLowerCase()) ?? [];
  await cleanupServer(name, agentIds);

  Log.info(`Server ${name}: Redis cleanup complete`);
}

export async function patchServerStatus(
  name: string,
  ns: string,
  status: Server["status"],
) {
  await K8s(Server).PatchStatus({
    metadata: { name, namespace: ns },
    status,
  });
}
