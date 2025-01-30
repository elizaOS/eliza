import { z } from 'zod';
import { ethers } from 'ethers';

/**
 * Schema for validating a SignEcdsa policy.
 * Ensures the policy has the correct structure and valid values.
 */
const policySchema = z.object({
  /** The type of policy, must be `SignEcdsa`. */
  type: z.literal('SignEcdsa'),

  /** The version of the policy. */
  version: z.string(),

  /** An array of allowed message prefixes. */
  allowedPrefixes: z.array(z.string()),
});

/**
 * Encodes a SignEcdsa policy into a format suitable for on-chain storage.
 * @param policy - The SignEcdsa policy to encode.
 * @returns The encoded policy as a hex string.
 * @throws If the policy does not conform to the schema.
 */
function encodePolicy(policy: SignEcdsaPolicyType): string {
  // Validate the policy against the schema
  policySchema.parse(policy);

  // Encode the policy using ABI encoding
  return ethers.utils.defaultAbiCoder.encode(
    ['tuple(string[] allowedPrefixes)'],
    [
      {
        allowedPrefixes: policy.allowedPrefixes,
      },
    ]
  );
}

/**
 * Decodes a SignEcdsa policy from its on-chain encoded format.
 * @param encodedPolicy - The encoded policy as a hex string.
 * @returns The decoded SignEcdsa policy.
 * @throws If the encoded policy is invalid or does not conform to the schema.
 */
function decodePolicy(encodedPolicy: string): SignEcdsaPolicyType {
  // Decode the policy using ABI decoding
  const decoded = ethers.utils.defaultAbiCoder.decode(
    ['tuple(string[] allowedPrefixes)'],
    encodedPolicy
  )[0];

  // Construct the policy object
  const policy: SignEcdsaPolicyType = {
    type: 'SignEcdsa',
    version: '1.0.0',
    allowedPrefixes: decoded.allowedPrefixes,
  };

  // Validate the decoded policy against the schema
  return policySchema.parse(policy);
}

/**
 * Represents the type of a SignEcdsa policy, inferred from the schema.
 */
export type SignEcdsaPolicyType = z.infer<typeof policySchema>;

/**
 * Utility object for working with SignEcdsa policies.
 * Includes the schema, encoding, and decoding functions.
 */
export const SignEcdsaPolicy = {
  /** The type of the policy. */
  type: {} as SignEcdsaPolicyType,

  /** The version of the policy. */
  version: '1.0.0',

  /** The schema for validating SignEcdsa policies. */
  schema: policySchema,

  /** Encodes a SignEcdsa policy into a format suitable for on-chain storage. */
  encode: encodePolicy,

  /** Decodes a SignEcdsa policy from its on-chain encoded format. */
  decode: decodePolicy,
};
