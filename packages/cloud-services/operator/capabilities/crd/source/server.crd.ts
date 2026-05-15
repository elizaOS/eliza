export const ServerCRD = {
  apiVersion: "apiextensions.k8s.io/v1",
  kind: "CustomResourceDefinition",
  metadata: {
    name: "servers.eliza.ai",
  },
  spec: {
    group: "eliza.ai",
    versions: [
      {
        name: "v1alpha1",
        served: true,
        storage: true,
        schema: {
          openAPIV3Schema: {
            type: "object",
            properties: {
              spec: {
                type: "object",
                required: ["capacity", "tier", "image"],
                properties: {
                  capacity: {
                    type: "integer",
                    minimum: 1,
                    maximum: 200,
                    description: "Maximum number of agents this server can host",
                  },
                  tier: {
                    type: "string",
                    enum: ["shared", "dedicated"],
                    description: "Server tier: shared pool or dedicated agent",
                  },
                  project: {
                    type: "string",
                    description: "Project identifier for Gateway routing (e.g. cloud, soulmate)",
                  },
                  image: {
                    type: "string",
                    description: "Container image for the agent-server",
                  },
                  maxReplicas: {
                    type: "integer",
                    minimum: 0,
                    default: 3,
                    description: "KEDA maxReplicaCount (0 = scale-to-zero only)",
                  },
                  secretRef: {
                    type: "string",
                    description: "K8s Secret name containing DATABASE_URL, REDIS_URL, etc.",
                  },
                  resources: {
                    type: "object",
                    properties: {
                      requests: {
                        type: "object",
                        properties: {
                          memory: { type: "string" },
                          cpu: { type: "string" },
                        },
                      },
                      limits: {
                        type: "object",
                        properties: {
                          memory: { type: "string" },
                          cpu: { type: "string" },
                        },
                      },
                    },
                  },
                  cooldownPeriod: {
                    type: "integer",
                    minimum: 0,
                    default: 900,
                    description: "KEDA cooldown in seconds before scale-to-zero (default 900)",
                  },
                  pollingInterval: {
                    type: "integer",
                    minimum: 5,
                    default: 30,
                    description: "KEDA polling interval in seconds (default 30)",
                  },
                  agents: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["agentId", "characterRef"],
                      properties: {
                        agentId: {
                          type: "string",
                          description: "Unique agent identifier",
                        },
                        characterRef: {
                          type: "string",
                          description: "Reference to the character configuration",
                        },
                      },
                    },
                  },
                },
              },
              status: {
                type: "object",
                properties: {
                  phase: {
                    type: "string",
                    enum: ["Pending", "Running", "ScaledDown", "Draining"],
                  },
                  readyAgents: { type: "integer" },
                  totalAgents: { type: "integer" },
                  replicas: { type: "integer" },
                  podNames: {
                    type: "array",
                    items: { type: "string" },
                  },
                  lastActivity: { type: "string", format: "date-time" },
                  observedGeneration: { type: "integer" },
                },
              },
            },
          },
        },
        subresources: {
          status: {},
        },
        additionalPrinterColumns: [
          {
            name: "Phase",
            type: "string",
            jsonPath: ".status.phase",
          },
          {
            name: "Tier",
            type: "string",
            jsonPath: ".spec.tier",
          },
          {
            name: "Project",
            type: "string",
            jsonPath: ".spec.project",
          },
          {
            name: "Agents",
            type: "integer",
            jsonPath: ".status.totalAgents",
          },
          {
            name: "Capacity",
            type: "integer",
            jsonPath: ".spec.capacity",
          },
          {
            name: "Age",
            type: "date",
            jsonPath: ".metadata.creationTimestamp",
          },
        ],
      },
    ],
    scope: "Namespaced",
    names: {
      plural: "servers",
      singular: "server",
      kind: "Server",
      shortNames: ["srv"],
    },
  },
};
