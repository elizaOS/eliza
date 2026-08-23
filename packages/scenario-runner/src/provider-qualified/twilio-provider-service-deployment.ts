/**
 * Assembles role-isolated provider-service deployments for the Twilio release
 * canaries. Deployment-owned loaders retain TLS, HSM, credential, runtime, and
 * storage authority; this module selects exactly one role and never resolves a
 * collaborator belonging to another process.
 */

import type { ServerOptions } from "node:https";
import type {
  ProviderServiceAudit,
  ProviderServiceDeploymentAdapters,
  ProviderServiceDeploymentFactoryInput,
} from "./provider-service-entrypoint.ts";
import type {
  ProviderSecretBrokerAdapter,
  ProviderSemanticJudgeServiceAdapter,
  ProviderServiceEd25519Signer,
} from "./provider-service-host.ts";
import {
  createPluginPhoneTwilioCleanupBoundary,
  createPluginPhoneTwilioDispatchBoundary,
  createTwilioCleanupServiceAdapter,
  createTwilioControllerServiceAdapter,
  createTwilioObserverServiceAdapter,
  type TwilioAuthorizedMaterialResolver,
  type TwilioCleanupProviderBoundary,
  type TwilioCleanupRegistry,
  type TwilioCredentialBoundary,
  type TwilioDeployedRuntimeBoundary,
  type TwilioObserverBoundary,
  type TwilioProductionDispatchBoundary,
} from "./twilio-provider-service-adapters.ts";

interface TwilioDeploymentBase {
  tls: ServerOptions;
  responseSigner: ProviderServiceEd25519Signer;
  audit: ProviderServiceAudit;
}

export interface TwilioControllerDeploymentCollaborators {
  materials: TwilioAuthorizedMaterialResolver;
  credential: TwilioCredentialBoundary;
  sendTwilioSms: TwilioProductionDispatchBoundary["sendSms"];
  sendTwilioVoiceCall: TwilioProductionDispatchBoundary["sendVoiceCall"];
  deployed: TwilioDeployedRuntimeBoundary;
  cleanupRegistry: TwilioCleanupRegistry;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface TwilioObserverDeploymentCollaborators {
  materials: TwilioAuthorizedMaterialResolver;
  credential: TwilioCredentialBoundary;
  boundary: TwilioObserverBoundary;
  evidenceSigner: ProviderServiceEd25519Signer;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface TwilioCleanupDeploymentCollaborators {
  registry: TwilioCleanupRegistry;
  credential: TwilioCredentialBoundary;
  cleanupTwilioProviderResource: TwilioCleanupProviderBoundary["cleanupResource"];
  now?: () => Date;
}

export interface TwilioSemanticJudgeDeploymentCollaborators {
  adapter: ProviderSemanticJudgeServiceAdapter;
  evidenceSigner: ProviderServiceEd25519Signer;
}

export interface TwilioProviderServiceDeploymentLoaders {
  base(
    input: ProviderServiceDeploymentFactoryInput,
  ): Promise<TwilioDeploymentBase>;
  controller?(
    input: ProviderServiceDeploymentFactoryInput,
  ): Promise<TwilioControllerDeploymentCollaborators>;
  observer?(
    input: ProviderServiceDeploymentFactoryInput,
  ): Promise<TwilioObserverDeploymentCollaborators>;
  semanticJudge?(
    input: ProviderServiceDeploymentFactoryInput,
  ): Promise<TwilioSemanticJudgeDeploymentCollaborators>;
  cleanup?(
    input: ProviderServiceDeploymentFactoryInput,
  ): Promise<TwilioCleanupDeploymentCollaborators>;
  secretBroker?(
    input: ProviderServiceDeploymentFactoryInput,
  ): Promise<ProviderSecretBrokerAdapter>;
}

function fail(message: string): never {
  throw new Error(`Twilio provider service deployment refused: ${message}`);
}

function requireRoleConfig(input: ProviderServiceDeploymentFactoryInput): void {
  if (input.roleConfig.role !== input.role) {
    fail("role configuration does not match the selected process role");
  }
  if (
    input.role === "controller" &&
    (input.roleConfig.role !== "controller" ||
      input.roleConfig.controllerFamilies.length !== 1 ||
      input.roleConfig.controllerFamilies[0] !== "twilio")
  ) {
    fail("controller process must enable only the Twilio family");
  }
}

function requireLoader<T>(
  loader:
    | ((input: ProviderServiceDeploymentFactoryInput) => Promise<T>)
    | undefined,
  role: string,
): (input: ProviderServiceDeploymentFactoryInput) => Promise<T> {
  if (!loader) fail(`${role} collaborator loader is unavailable`);
  return loader;
}

/**
 * Produce the content-pinned deployment factory exported by a deployment-owned
 * bundle. Only the selected role loader runs, keeping cross-role secrets and
 * signers out of the process even when one build supports every service role.
 */
export function createTwilioProviderCanaryServiceDeploymentFactory(
  loaders: TwilioProviderServiceDeploymentLoaders,
): (
  input: ProviderServiceDeploymentFactoryInput,
) => Promise<ProviderServiceDeploymentAdapters> {
  return async (input) => {
    requireRoleConfig(input);
    const base = await loaders.base(input);
    switch (input.role) {
      case "controller": {
        const collaborators = await requireLoader(
          loaders.controller,
          input.role,
        )(input);
        return Object.freeze({
          ...base,
          role: input.role,
          controllerAdapters: Object.freeze({
            twilio: createTwilioControllerServiceAdapter({
              materials: collaborators.materials,
              credential: collaborators.credential,
              service: createPluginPhoneTwilioDispatchBoundary({
                sendTwilioSms: collaborators.sendTwilioSms,
                sendTwilioVoiceCall: collaborators.sendTwilioVoiceCall,
              }),
              deployed: collaborators.deployed,
              cleanupRegistry: collaborators.cleanupRegistry,
              ...(collaborators.fetchImpl
                ? { fetchImpl: collaborators.fetchImpl }
                : {}),
              ...(collaborators.now ? { now: collaborators.now } : {}),
            }),
          }),
        });
      }
      case "observer": {
        const collaborators = await requireLoader(
          loaders.observer,
          input.role,
        )(input);
        return Object.freeze({
          ...base,
          role: input.role,
          observerAdapter: createTwilioObserverServiceAdapter({
            materials: collaborators.materials,
            credential: collaborators.credential,
            boundary: collaborators.boundary,
            ...(collaborators.fetchImpl
              ? { fetchImpl: collaborators.fetchImpl }
              : {}),
            ...(collaborators.now ? { now: collaborators.now } : {}),
          }),
          evidenceSigner: collaborators.evidenceSigner,
        });
      }
      case "semantic-judge": {
        const collaborators = await requireLoader(
          loaders.semanticJudge,
          input.role,
        )(input);
        return Object.freeze({
          ...base,
          role: input.role,
          semanticJudgeAdapter: collaborators.adapter,
          evidenceSigner: collaborators.evidenceSigner,
        });
      }
      case "cleanup": {
        const collaborators = await requireLoader(
          loaders.cleanup,
          input.role,
        )(input);
        return Object.freeze({
          ...base,
          role: input.role,
          cleanupAdapter: createTwilioCleanupServiceAdapter({
            registry: collaborators.registry,
            credential: collaborators.credential,
            service: createPluginPhoneTwilioCleanupBoundary({
              cleanupTwilioProviderResource:
                collaborators.cleanupTwilioProviderResource,
            }),
            ...(collaborators.now ? { now: collaborators.now } : {}),
          }),
        });
      }
      case "secret-broker": {
        const adapter = await requireLoader(
          loaders.secretBroker,
          input.role,
        )(input);
        return Object.freeze({
          ...base,
          role: input.role,
          secretBrokerAdapter: adapter,
        });
      }
    }
  };
}
