import { z } from 'zod';
import {
  type AwTool,
  type SupportedLitNetwork,
  NETWORK_CONFIGS,
  NetworkConfig,
} from '@lit-protocol/aw-tool';

import { SignEcdsaPolicy, type SignEcdsaPolicyType } from './policy';
import { IPFS_CIDS } from './ipfs';

/**
 * Parameters required for the Signing ECDSA Lit Action.
 * @property {string} pkpEthAddress - The Ethereum address of the PKP.
 * @property message - The message to sign.
 */
export interface SignEcdsaLitActionParameters {
  pkpEthAddress: string;
  message: string;
}

/**
 * Zod schema for validating `SignEcdsaLitActionParameters`.
 * Ensures that the message is a valid string.
 */
const SignEcdsaLitActionSchema = z.object({
  pkpEthAddress: z
    .string()
    .regex(
      /^0x[a-fA-F0-9]{40}$/,
      'Must be a valid Ethereum address (0x followed by 40 hexadecimal characters)'
    ),
  message: z.string(),
});

/**
 * Descriptions of each parameter for the Signing ECDSA Lit Action.
 * These descriptions are designed to be consumed by LLMs (Language Learning Models) to understand the required parameters.
 */
const SignEcdsaLitActionParameterDescriptions = {
  pkpEthAddress:
    'The Ethereum address of the PKP that will be used to sign the message.',
  message: 'The message you want to sign.',
} as const;

/**
 * Validates the parameters for the Signing ECDSA Lit Action.
 * @param params - The parameters to validate.
 * @returns `true` if the parameters are valid, or an array of errors if invalid.
 */
const validateSignEcdsaParameters = (
  params: unknown
): true | Array<{ param: string; error: string }> => {
  const result = SignEcdsaLitActionSchema.safeParse(params);
  if (result.success) {
    return true;
  }

  // Map validation errors to a more user-friendly format
  return result.error.issues.map((issue) => ({
    param: issue.path[0] as string,
    error: issue.message,
  }));
};

/**
 * Creates a network-specific SignEcdsa tool.
 * @param network - The supported Lit network (e.g., `datil-dev`, `datil-test`, `datil`).
 * @param config - The network configuration.
 * @returns A configured `AwTool` instance for the Signing ECDSA Lit Action.
 */
const createNetworkTool = (
  network: SupportedLitNetwork,
  config: NetworkConfig
): AwTool<SignEcdsaLitActionParameters, SignEcdsaPolicyType> => ({
  name: 'SignEcdsa',
  description: `A Lit Action that signs a message with an allowlist of message prefixes.`,
  ipfsCid: IPFS_CIDS[network].tool,
  defaultPolicyIpfsCid: IPFS_CIDS[network].defaultPolicy,
  parameters: {
    type: {} as SignEcdsaLitActionParameters,
    schema: SignEcdsaLitActionSchema,
    descriptions: SignEcdsaLitActionParameterDescriptions,
    validate: validateSignEcdsaParameters,
  },
  policy: SignEcdsaPolicy,
});

/**
 * Exports network-specific SignEcdsa tools.
 * Each tool is configured for a specific Lit network (e.g., `datil-dev`, `datil-test`, `datil`).
 */
export const SignEcdsa = Object.entries(NETWORK_CONFIGS).reduce(
  (acc, [network, config]) => ({
    ...acc,
    [network]: createNetworkTool(network as SupportedLitNetwork, config),
  }),
  {} as Record<
    SupportedLitNetwork,
    AwTool<SignEcdsaLitActionParameters, SignEcdsaPolicyType>
  >
);
