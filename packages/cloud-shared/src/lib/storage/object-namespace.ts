export const ObjectNamespaces = {
  ConversationMessageBodies: "conversation-message-bodies",
  ConversationMessageApiPayloads: "conversation-message-api",
  JobPayloads: "job-payloads",
  ContainerDeployLogs: "container-deploy-logs",
  GenerationArtifacts: "generation-artifacts",
  AgentEventBodies: "agent-event-bodies",
  PhoneMessagePayloads: "phone-message-payloads",
  TwilioInboundPayloads: "twilio-inbound-payloads",
  SeoPayloads: "seo-payloads",
  VertexTuningPayloads: "vertex-tuning-payloads",
  AgentSandboxBackups: "agent-sandbox-backups",
} as const;

export type ObjectNamespace = (typeof ObjectNamespaces)[keyof typeof ObjectNamespaces];
