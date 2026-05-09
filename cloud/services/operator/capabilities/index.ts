import { a, Capability, K8s, Log } from "pepr";
import { applyResources } from "./controller/generators";
import { Server, type ServerPhase } from "./crd/generated/server-v1alpha1";
import { validator } from "./crd/validator";
import { finalizer, patchServerStatus, reconciler } from "./reconciler";
import { setServerState } from "./redis";
import "./crd/register";

export const ServerController = new Capability({
  name: "server-controller",
  description: "Manages ElizaOS Server resources",
  namespaces: ["eliza-agents"],
});

const { When } = ServerController;

When(Server).IsCreatedOrUpdated().InNamespace("eliza-agents").Validate(validator);

When(Server)
  .IsCreatedOrUpdated()
  .InNamespace("eliza-agents")
  .Reconcile(async (instance) => {
    await reconciler(instance);
  })
  .Finalize(async (instance) => {
    await finalizer(instance);
    if (instance.metadata?.name) lastPhase.delete(instance.metadata.name);
  });

const lastPhase = new Map<string, string>();

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === status;
}

When(a.Deployment)
  .IsUpdated()
  .InNamespace("eliza-agents")
  .WithLabel("eliza.ai/managed-by", "server-operator")
  .Watch(async (deploy) => {
    const serverName = deploy.metadata?.labels?.["eliza.ai/server"];
    if (!serverName) return;

    const replicas = deploy.status?.replicas ?? 0;
    const ready = deploy.status?.readyReplicas ?? 0;
    const ns = deploy.metadata?.namespace ?? "eliza-agents";

    let phase: ServerPhase;
    if (replicas === 0) phase = "ScaledDown";
    else if (ready > 0) phase = "Running";
    else phase = "Pending";

    if (lastPhase.get(serverName) === phase) return;
    lastPhase.set(serverName, phase);

    Log.info(`Server ${serverName}: phase → ${phase} (replicas=${replicas}, ready=${ready})`);

    const url = `http://${serverName}.${ns}.svc:3000`;
    await setServerState(serverName, phase.toLowerCase(), url);

    await patchServerStatus(serverName, ns, {
      phase,
      replicas: ready,
      lastActivity: new Date().toISOString(),
    });
  });

// Self-healing: re-deploy Deployments if deleted externally
When(a.Deployment)
  .IsDeleted()
  .InNamespace("eliza-agents")
  .WithLabel("eliza.ai/managed-by", "server-operator")
  .Watch(async (deploy) => {
    const serverName = deploy.metadata?.labels?.["eliza.ai/server"];
    if (!serverName) return;

    try {
      const server = await K8s(Server).InNamespace("eliza-agents").Get(serverName);
      // Skip if CR is being deleted (ownerReferences cascade is expected)
      if (server.metadata?.deletionTimestamp) return;
      Log.info(`Deployment ${serverName} deleted externally, re-reconciling`);
      await applyResources(server);
    } catch (err: unknown) {
      if (hasStatus(err, 404)) return; // CR deleted, nothing to re-reconcile
      Log.error(err, `Failed to re-reconcile Server ${serverName}`);
    }
  });

// Self-healing: re-deploy Services if deleted externally
When(a.Service)
  .IsDeleted()
  .InNamespace("eliza-agents")
  .WithLabel("eliza.ai/managed-by", "server-operator")
  .Watch(async (svc) => {
    const serverName = svc.metadata?.labels?.["eliza.ai/server"];
    if (!serverName) return;

    try {
      const server = await K8s(Server).InNamespace("eliza-agents").Get(serverName);
      // Skip if CR is being deleted (ownerReferences cascade is expected)
      if (server.metadata?.deletionTimestamp) return;
      Log.info(`Service ${serverName} deleted externally, re-reconciling`);
      await applyResources(server);
    } catch (err: unknown) {
      if (hasStatus(err, 404)) return; // CR deleted, nothing to re-reconcile
      Log.error(err, `Failed to re-reconcile Server ${serverName}`);
    }
  });
