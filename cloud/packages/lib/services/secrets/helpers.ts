import type { SecretEnvironment, SecretProjectType } from "@/db/schemas/secrets";
import { secretsService } from "./secrets";

export interface SecretContext {
  organizationId: string;
  projectId?: string;
  projectType?: SecretProjectType;
  environment?: SecretEnvironment;
}

export interface AgentSecretContext {
  organizationId: string;
  characterId: string;
}

export interface McpSecretContext {
  organizationId: string;
  mcpId: string;
}

export interface WorkflowSecretContext {
  organizationId: string;
  workflowId: string;
}

export interface ContainerSecretContext {
  organizationId: string;
  containerId?: string;
}

export interface SandboxSecretContext {
  organizationId: string;
  appId?: string;
}

export async function loadSecrets(ctx: SecretContext): Promise<Record<string, string>> {
  assertSecretsConfigured();

  const orgSecrets = await secretsService.getDecrypted({
    organizationId: ctx.organizationId,
    environment: ctx.environment,
  });

  if (!ctx.projectId) return orgSecrets;

  const projectSecrets = await secretsService.getDecrypted({
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
    projectType: ctx.projectType,
    environment: ctx.environment,
  });

  return { ...orgSecrets, ...projectSecrets };
}

export function loadAgentSecrets(ctx: AgentSecretContext) {
  return loadSecrets({
    organizationId: ctx.organizationId,
    projectId: ctx.characterId,
    projectType: "character",
  });
}

export function loadMcpSecrets(ctx: McpSecretContext) {
  return loadSecrets({
    organizationId: ctx.organizationId,
    projectId: ctx.mcpId,
    projectType: "mcp",
  });
}

export function loadWorkflowSecrets(ctx: WorkflowSecretContext) {
  return loadSecrets({
    organizationId: ctx.organizationId,
    projectId: ctx.workflowId,
    projectType: "workflow",
  });
}

export function loadContainerSecrets(ctx: ContainerSecretContext) {
  return loadSecrets({
    organizationId: ctx.organizationId,
    projectId: ctx.containerId,
    projectType: ctx.containerId ? "container" : undefined,
  });
}

export function loadSandboxSecrets(ctx: SandboxSecretContext) {
  return loadSecrets({
    organizationId: ctx.organizationId,
    projectId: ctx.appId,
    projectType: ctx.appId ? "app" : undefined,
  });
}

export function loadOrgSecrets(organizationId: string) {
  return loadSecrets({ organizationId });
}

export function isSecretsConfigured(): boolean {
  return secretsService.isConfigured;
}

export function assertSecretsConfigured(): void {
  if (!secretsService.isConfigured) throw new SecretsNotConfiguredError();
}

export class SecretsNotConfiguredError extends Error {
  constructor() {
    super("Secrets service is not configured. Set SECRETS_MASTER_KEY or configure AWS KMS.");
    this.name = "SecretsNotConfiguredError";
  }
}
