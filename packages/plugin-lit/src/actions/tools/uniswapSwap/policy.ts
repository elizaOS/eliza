import { BaseEthereumAddressSchema } from '@lit-protocol/aw-tool';
import { z } from 'zod';
import { ethers } from 'ethers';

/**
 * Zod schema for validating a UniswapSwap policy.
 * @type {z.ZodObject}
 */
const policySchema = z.object({
  type: z.literal('UniswapSwap'), // Policy type must be 'UniswapSwap'
  version: z.string(), // Version of the policy
  maxAmount: z.string().refine(
    (val) => {
      try {
        const bn = ethers.BigNumber.from(val);
        return !bn.isNegative(); // Ensure the amount is non-negative
      } catch {
        return false; // Invalid format
      }
    },
    { message: 'Invalid amount format. Must be a non-negative integer.' }
  ),
  allowedTokens: z.array(BaseEthereumAddressSchema), // Array of allowed token addresses
});

/**
 * Encodes a UniswapSwap policy into a packed ABI-encoded string.
 * @param {UniswapSwapPolicyType} policy - The policy to encode.
 * @returns {string} ABI-encoded string representing the policy.
 * @throws {z.ZodError} If the policy does not match the schema.
 */
function encodePolicy(policy: UniswapSwapPolicyType): string {
  // Validate the policy against the schema
  policySchema.parse(policy);

  // Encode the policy using ABI encoding
  return ethers.utils.defaultAbiCoder.encode(
    ['tuple(uint256 maxAmount, address[] allowedTokens)'],
    [
      {
        maxAmount: policy.maxAmount,
        allowedTokens: policy.allowedTokens,
      },
    ]
  );
}

/**
 * Decodes an ABI-encoded string into a UniswapSwap policy.
 * @param {string} encodedPolicy - The ABI-encoded policy string.
 * @returns {UniswapSwapPolicyType} The decoded policy object.
 * @throws {z.ZodError} If the decoded policy does not match the schema.
 */
function decodePolicy(encodedPolicy: string): UniswapSwapPolicyType {
  // Decode the ABI-encoded string
  const decoded = ethers.utils.defaultAbiCoder.decode(
    ['tuple(uint256 maxAmount, address[] allowedTokens)'],
    encodedPolicy
  )[0];

  // Construct the policy object
  const policy: UniswapSwapPolicyType = {
    type: 'UniswapSwap',
    version: '1.0.0',
    maxAmount: decoded.maxAmount.toString(),
    allowedTokens: decoded.allowedTokens,
  };

  // Validate the decoded policy against the schema
  return policySchema.parse(policy);
}

/**
 * Type representing a UniswapSwap policy.
 * @typedef {z.infer<typeof policySchema>} UniswapSwapPolicyType
 */
export type UniswapSwapPolicyType = z.infer<typeof policySchema>;

/**
 * Utility object for working with UniswapSwap policies.
 * @type {object}
 * @property {UniswapSwapPolicyType} type - Type placeholder for the policy.
 * @property {string} version - Version of the policy schema.
 * @property {z.ZodObject} schema - Zod schema for validating policies.
 * @property {function} encode - Function to encode a policy into an ABI-encoded string.
 * @property {function} decode - Function to decode an ABI-encoded string into a policy.
 */
export const UniswapSwapPolicy = {
  type: {} as UniswapSwapPolicyType, // Placeholder for the policy type
  version: '1.0.0', // Version of the policy schema
  schema: policySchema, // Zod schema for validation
  encode: encodePolicy, // Function to encode a policy
  decode: decodePolicy, // Function to decode a policy
};
