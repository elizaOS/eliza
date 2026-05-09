import { logger } from '@elizaos/core';
import type {
  CredentialProvider,
  CredentialResolutionResult,
  MissingConnection,
  WorkflowCredentialStoreApi,
  WorkflowDefinition,
  WorkflowPluginConfig,
} from '../types/index';

interface CredentialApiClient {
  createCredential(credential: {
    name: string;
    type: string;
    data: Record<string, unknown>;
  }): Promise<{ id: string }>;
}

/**
 * Resolve and inject credentials into workflow.
 *
 * Resolution chain (first match wins):
 *   1. Credential store DB — cached mappings from previous resolutions
 *   2. Static config — character.settings.workflows.credentials
 *   3. External provider — registered CredentialProvider service (e.g. cloud OAuth)
 *   4. Missing — reported for manual configuration in workflows
 */
export async function resolveCredentials(
  workflow: WorkflowDefinition,
  userId: string,
  config: WorkflowPluginConfig,
  credStore: WorkflowCredentialStoreApi | null,
  credProvider: CredentialProvider | null,
  apiClient: CredentialApiClient | null,
  tagName: string
): Promise<CredentialResolutionResult> {
  const requiredCredTypes = extractRequiredCredentialTypes(workflow);

  if (requiredCredTypes.size === 0) {
    return {
      workflow,
      missingConnections: [],
      injectedCredentials: new Map(),
    };
  }

  const injectedCredentials = new Map<string, string>();
  const missingConnections: MissingConnection[] = [];

  for (const credType of requiredCredTypes) {
    const credId = await resolveOneCredential(
      credType,
      userId,
      config,
      credStore,
      credProvider,
      apiClient,
      missingConnections,
      tagName
    );

    if (credId) {
      injectedCredentials.set(credType, credId);
    }
  }

  const resolvedWorkflow = injectCredentialIds(workflow, injectedCredentials);

  return {
    workflow: resolvedWorkflow,
    missingConnections,
    injectedCredentials,
  };
}

async function resolveOneCredential(
  credType: string,
  userId: string,
  config: WorkflowPluginConfig,
  credStore: WorkflowCredentialStoreApi | null,
  credProvider: CredentialProvider | null,
  apiClient: CredentialApiClient | null,
  missingConnections: MissingConnection[],
  tagName: string
): Promise<string | null> {
  // 1. Credential store DB
  const cachedId = await credStore?.get(userId, credType);
  if (cachedId) {
    logger.debug(
      { src: 'plugin:workflow:utils:credentials' },
      `Resolved ${credType} from credential store`
    );
    return cachedId;
  }

  // 2. Static config
  if (config.credentials) {
    const configId = findCredentialId(config.credentials, credType);
    if (configId) {
      return configId;
    }
  }

  // 3. External provider
  if (credProvider) {
    try {
      const result = await credProvider.resolve(userId, credType);

      if (result?.status === 'credential_data') {
        if (!apiClient) {
          logger.error(
            { src: 'plugin:workflow:utils:credentials' },
            `Received credential_data for ${credType} but no apiClient available`
          );
          missingConnections.push({ credType });
          return null;
        }
        const credName = `${credType}_${tagName}`;
        const workflowsCred = await apiClient.createCredential({
          name: credName,
          type: credType,
          data: result.data,
        });
        try {
          await credStore?.set(userId, credType, workflowsCred.id);
        } catch (cacheError) {
          logger.warn(
            { src: 'plugin:workflow:utils:credentials' },
            `Failed to cache credential mapping for ${credType} (credential still usable): ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`
          );
        }
        logger.info(
          { src: 'plugin:workflow:utils:credentials' },
          `Created workflows credential for ${credType}: ${workflowsCred.id}`
        );
        return workflowsCred.id;
      }

      if (result?.status === 'needs_auth') {
        missingConnections.push({ credType, authUrl: result.authUrl });
        return null;
      }
    } catch (error) {
      logger.error(
        { src: 'plugin:workflow:utils:credentials' },
        `Credential provider failed for ${credType}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 4. Missing
  missingConnections.push({ credType });
  return null;
}

/**
 * Look up a credential ID from config, tolerating naming mismatches
 * (e.g. LLM generates "gmailOAuth2Api" but config has "gmailOAuth2", or vice-versa).
 */
function findCredentialId(credentials: Record<string, string>, credType: string): string | null {
  if (credentials[credType]) {
    return credentials[credType];
  }

  // Fuzzy: try without "Api" suffix (e.g. "gmailOAuth2Api" → "gmailOAuth2")
  const withoutApi = credType.replace(/Api$/, '');
  if (withoutApi !== credType && credentials[withoutApi]) {
    logger.debug(
      { src: 'plugin:workflow:utils:credentials' },
      `Fuzzy credential match: "${credType}" → "${withoutApi}" (removed Api suffix)`
    );
    return credentials[withoutApi];
  }

  // Fuzzy: try with "Api" suffix (e.g. "gmailOAuth2" → "gmailOAuth2Api")
  const withApi = `${credType}Api`;
  if (credentials[withApi]) {
    logger.debug(
      { src: 'plugin:workflow:utils:credentials' },
      `Fuzzy credential match: "${credType}" → "${withApi}" (added Api suffix)`
    );
    return credentials[withApi];
  }

  return null;
}

function extractRequiredCredentialTypes(workflow: WorkflowDefinition): Set<string> {
  const credTypes = new Set<string>();

  for (const node of workflow.nodes) {
    if (node.credentials) {
      for (const credType of Object.keys(node.credentials)) {
        credTypes.add(credType);
      }
    }
  }

  return credTypes;
}

function injectCredentialIds(
  workflow: WorkflowDefinition,
  credentialMap: Map<string, string>
): WorkflowDefinition {
  const injected = { ...workflow };
  injected.nodes = workflow.nodes.map((node) => {
    if (!node.credentials) {
      return node;
    }

    const updatedCredentials: typeof node.credentials = {};

    for (const [credType, credRef] of Object.entries(node.credentials)) {
      const credId = credentialMap.get(credType);

      if (credId) {
        updatedCredentials[credType] = {
          id: credId,
          name: credRef.name,
        };
      } else {
        updatedCredentials[credType] = credRef;
      }
    }

    return {
      ...node,
      credentials: updatedCredentials,
    };
  });

  return injected;
}
