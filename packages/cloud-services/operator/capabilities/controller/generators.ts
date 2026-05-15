import { GenericKind, RegisterKind } from "kubernetes-fluent-client";
import { K8s, kind } from "pepr";
import { Server } from "../crd/generated/server-v1alpha1";

const MANAGED_BY = "server-operator";

// KEDA ScaledObject type for KFC
export class ScaledObject extends GenericKind {}
RegisterKind(ScaledObject, {
  group: "keda.sh",
  version: "v1alpha1",
  kind: "ScaledObject",
  plural: "scaledobjects",
});

function ownerRef(server: Server) {
  return [
    {
      apiVersion: "eliza.ai/v1alpha1",
      kind: "Server",
      name: server.metadata!.name!,
      uid: server.metadata!.uid!,
      controller: true,
      blockOwnerDeletion: true,
    },
  ];
}

function labels(server: Server) {
  const l: Record<string, string> = {
    "eliza.ai/managed-by": MANAGED_BY,
    "eliza.ai/server": server.metadata!.name!,
    "eliza.ai/tier": server.spec.tier,
  };
  if (server.spec.project) {
    l["eliza.ai/project"] = server.spec.project;
  }
  return l;
}

function getRedisAddress(): string {
  const explicitAddress = process.env.REDIS_ADDRESS?.trim();
  if (explicitAddress) {
    return explicitAddress;
  }

  const redisUrl = process.env.REDIS_URL?.trim();
  if (redisUrl) {
    try {
      return new URL(redisUrl).host;
    } catch {
      return redisUrl.replace(/^rediss?:\/\//, "");
    }
  }

  return "redis.eliza-infra.svc:6379";
}

export function generateDeployment(server: Server) {
  const name = server.metadata!.name!;
  const ns = server.metadata!.namespace ?? "eliza-agents";

  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name,
      namespace: ns,
      labels: labels(server),
      ownerReferences: ownerRef(server),
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: { "eliza.ai/server": name },
      },
      template: {
        metadata: {
          labels: labels(server),
        },
        spec: {
          containers: [
            {
              name: "agent-server",
              image: server.spec.image,
              imagePullPolicy: "Always",
              ports: [{ containerPort: 3000, name: "http" }],
              envFrom: [
                {
                  secretRef: {
                    name: server.spec.secretRef || "eliza-agent-secrets",
                  },
                },
              ],
              env: [
                { name: "SERVER_NAME", value: name },
                { name: "CAPACITY", value: String(server.spec.capacity) },
                { name: "TIER", value: server.spec.tier },
                {
                  name: "POD_NAME",
                  valueFrom: {
                    fieldRef: { fieldPath: "metadata.name" },
                  },
                },
                {
                  name: "POD_NAMESPACE",
                  valueFrom: {
                    fieldRef: { fieldPath: "metadata.namespace" },
                  },
                },
                ...(server.spec.agents?.[0]
                  ? [
                      {
                        name: "AGENT_ID",
                        value: server.spec.agents[0].agentId,
                      },
                      {
                        name: "CHARACTER_REF",
                        value: server.spec.agents[0].characterRef,
                      },
                    ]
                  : []),
              ],
              resources: server.spec.resources ?? {
                requests: { memory: "512Mi", cpu: "250m" },
                limits: { memory: "2Gi", cpu: "2000m" },
              },
              livenessProbe: {
                httpGet: { path: "/health", port: 3000 },
                initialDelaySeconds: 2,
                periodSeconds: 5,
              },
              readinessProbe: {
                httpGet: { path: "/ready", port: 3000 },
                initialDelaySeconds: 1,
                periodSeconds: 2,
              },
            },
          ],
          terminationGracePeriodSeconds: 60,
        },
      },
    },
  };
}

export function generateService(server: Server) {
  const name = server.metadata!.name!;
  const ns = server.metadata!.namespace ?? "eliza-agents";

  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name,
      namespace: ns,
      labels: labels(server),
      ownerReferences: ownerRef(server),
    },
    spec: {
      clusterIP: "None",
      ports: [{ port: 3000, targetPort: 3000, protocol: "TCP", name: "http" }],
      selector: { "eliza.ai/server": name },
    },
  };
}

export function generateScaledObject(server: Server) {
  const name = server.metadata!.name!;
  const ns = server.metadata!.namespace ?? "eliza-agents";

  return {
    apiVersion: "keda.sh/v1alpha1",
    kind: "ScaledObject",
    metadata: {
      name,
      namespace: ns,
      labels: labels(server),
      ownerReferences: ownerRef(server),
    },
    spec: {
      scaleTargetRef: { name },
      minReplicaCount: 0,
      maxReplicaCount: server.spec.maxReplicas ?? 3,
      cooldownPeriod: server.spec.cooldownPeriod ?? 900,
      pollingInterval: server.spec.pollingInterval ?? 30,
      advanced: {
        horizontalPodAutoscalerConfig: {
          behavior: {
            scaleDown: {
              stabilizationWindowSeconds: 300,
              policies: [{ type: "Pods", value: 1, periodSeconds: 60 }],
            },
          },
        },
      },
      triggers: [
        {
          type: "redis",
          metadata: {
            address: getRedisAddress(),
            listName: `keda:${name}:activity`,
            listLength: "1",
          },
        },
        {
          type: "cpu",
          metricType: "Utilization",
          metadata: {
            value: "70",
          },
        },
      ],
    },
  };
}

export async function applyResources(server: Server) {
  await K8s(kind.Deployment).Apply(generateDeployment(server), {
    force: true,
  });
  await K8s(kind.Service).Apply(generateService(server), { force: true });
  await K8s(ScaledObject).Apply(generateScaledObject(server), { force: true });
}
