import { BaseEthereumAddressSchema } from '@lit-protocol/aw-tool';
import { z } from 'zod';
import { ethers } from 'ethers';

/**
 * Schema for validating an ERC20 transfer policy.
 * @type {z.ZodObject}
 */
const policySchema = z.object({
  type: z.literal('ERC20Transfer'), // Policy type must be 'ERC20Transfer'
  version: z.string(), // Version of the policy
  erc20Decimals: z.string().refine(
    (val) => {
      try {
        const bn = ethers.BigNumber.from(val);
        return !bn.isNegative() && bn.lte(255); // Ensure the amount is non-negative and does not exceed uint8
      } catch {
        return false; // Invalid format
      }
    },
    {
      message:
        'Invalid amount format. Must be a non-negative integer and not exceed 255.',
    }
  ), // Number of decimals for the ERC20 token
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
  allowedRecipients: z.array(BaseEthereumAddressSchema), // Array of allowed recipient addresses
});

/**
 * Encodes an ERC20 transfer policy into a packed ABI-encoded string.
 * @param {ERC20TransferPolicyType} policy - The policy to encode.
 * @returns {string} ABI-encoded string representing the policy.
 * @throws {z.ZodError} If the policy does not match the schema.
 */
function encodePolicy(policy: ERC20TransferPolicyType): string {
  // Validate the policy against the schema
  policySchema.parse(policy);

  // Encode the policy using ABI encoding
  return ethers.utils.defaultAbiCoder.encode(
    [
      'tuple(uint8 erc20Decimals, uint256 maxAmount, address[] allowedTokens, address[] allowedRecipients)',
    ],
    [
      {
        erc20Decimals: policy.erc20Decimals,
        maxAmount: ethers.utils
          .parseUnits(policy.maxAmount, policy.erc20Decimals)
          .toString(),
        allowedTokens: policy.allowedTokens,
        allowedRecipients: policy.allowedRecipients,
      },
    ]
  );
}

/**
 * Decodes an ABI-encoded string into an ERC20 transfer policy.
 * @param {string} encodedPolicy - The ABI-encoded policy string.
 * @returns {ERC20TransferPolicyType} The decoded policy object.
 * @throws {z.ZodError} If the decoded policy does not match the schema.
 */
function decodePolicy(encodedPolicy: string): ERC20TransferPolicyType {
  // Decode the ABI-encoded string
  const decoded = ethers.utils.defaultAbiCoder.decode(
    [
      'tuple(uint8 erc20Decimals, uint256 maxAmount, address[] allowedTokens, address[] allowedRecipients)',
    ],
    encodedPolicy
  )[0];

  // Construct the policy object
  const policy: ERC20TransferPolicyType = {
    type: 'ERC20Transfer',
    version: '1.0.0',
    erc20Decimals: decoded.erc20Decimals.toString(),
    maxAmount: decoded.maxAmount.toString(),
    allowedTokens: decoded.allowedTokens,
    allowedRecipients: decoded.allowedRecipients,
  };

  // Validate the decoded policy against the schema
  return policySchema.parse(policy);
}

/**
 * Type representing an ERC20 transfer policy.
 * @typedef {z.infer<typeof policySchema>} ERC20TransferPolicyType
 */
export type ERC20TransferPolicyType = z.infer<typeof policySchema>;

/**
 * Utility object for working with ERC20 transfer policies.
 * @type {object}
 * @property {ERC20TransferPolicyType} type - Type placeholder for the policy.
 * @property {string} version - Version of the policy schema.
 * @property {z.ZodObject} schema - Zod schema for validating policies.
 * @property {function} encode - Function to encode a policy into an ABI-encoded string.
 * @property {function} decode - Function to decode an ABI-encoded string into a policy.
 */
export const ERC20TransferPolicy = {
  type: {} as ERC20TransferPolicyType, // Placeholder for the policy type
  version: '1.0.0', // Version of the policy schema
  schema: policySchema, // Zod schema for validation
  encode: encodePolicy, // Function to encode a policy
  decode: decodePolicy, // Function to decode a policy
};
