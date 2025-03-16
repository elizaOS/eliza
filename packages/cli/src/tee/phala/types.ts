import { z } from 'zod';

const dockerConfigSchema = z.object({
  password: z.string(),
  registry: z.string().nullable(),
  username: z.string(),
});

/**
 * Schema for composing a manifest file configuration.
 * * @type {import("zod").ZodObject<{
 * docker_compose_file: import("zod").ZodString;
 * docker_config: import("zod").ZodObject<{
 * ...
 * }>;
 * features: import("zod").ZodArray<import("zod").ZodString>;
 * kms_enabled: import("zod").ZodBoolean;
 * manifest_version: import("zod").ZodNumber;
 * name: import("zod").ZodString;
 * public_logs: import("zod").ZodBoolean;
 * public_sysinfo: import("zod").ZodBoolean;
 * runner: import("zod").ZodString;
 * salt: import("zod").ZodNullable<import("zod").ZodString>;
 * tproxy_enabled: import("zod").ZodBoolean;
 * version: import("zod").ZodString;
 * }>
 */
const composeFileSchema = z.object({
  docker_compose_file: z.string(),
  docker_config: dockerConfigSchema,
  features: z.array(z.string()),
  kms_enabled: z.boolean(),
  manifest_version: z.number(),
  name: z.string(),
  public_logs: z.boolean(),
  public_sysinfo: z.boolean(),
  runner: z.string(),
  salt: z.string().nullable(),
  tproxy_enabled: z.boolean(),
  version: z.string(),
});

const configurationSchema = z.object({
  name: z.string(),
  image: z.string(),
  compose_file: composeFileSchema,
  vcpu: z.number(),
  memory: z.number(),
  disk_size: z.number(),
  ports: z.array(z.any()),
});

/**
 * Represents a hosted schema object.
 *
 * @type {import("zod").ZodObject<{
 *   id: import("zod").ZodString;
 *   name: import("zod").ZodString;
 *   status: import("zod").ZodString;
 *   uptime: import("zod").ZodString;
 *   app_url: import("zod").ZodString;
 *   app_id: import("zod").ZodString;
 *   instance_id: import("zod").ZodString;
 *   configuration: import("zod").ZodObject<{
 *     // Define properties for the configuration schema.
 *   }>;
 *   exited_at: import("zod").ZodString;
 *   boot_progress: import("zod").ZodString;
 *   boot_error: import("zod").ZodString;
 *   shutdown_progress: import("zod").ZodString;
 *   image_version: import("zod").ZodString;
 * }>;
 */
const hostedSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  uptime: z.string(),
  app_url: z.string(),
  app_id: z.string(),
  instance_id: z.string(),
  configuration: configurationSchema,
  exited_at: z.string(),
  boot_progress: z.string(),
  boot_error: z.string(),
  shutdown_progress: z.string(),
  image_version: z.string(),
});

const managedUserSchema = z.object({
  id: z.number(),
  username: z.string(),
});

const nodeSchema = z.object({
  id: z.number(),
  name: z.string(),
});

/**
 * Schema definition for a CVM instance.
 *
 * @type {import("zod").ZodObject<{
 *   hosted: typeof hostedSchema,
 *   name: typeof z.string,
 *   managed_user: typeof managedUserSchema,
 *   node: typeof nodeSchema,
 *   listed: typeof z.boolean,
 *   status: typeof z.string,
 *   in_progress: typeof z.boolean,
 *   dapp_dashboard_url: typeof z.string,
 *   syslog_endpoint: typeof z.string,
 *   allow_upgrade: typeof z.boolean
 * }>
 */
const cvmInstanceSchema = z.object({
  hosted: hostedSchema,
  name: z.string(),
  managed_user: managedUserSchema,
  node: nodeSchema,
  listed: z.boolean(),
  status: z.string(),
  in_progress: z.boolean(),
  dapp_dashboard_url: z.string(),
  syslog_endpoint: z.string(),
  allow_upgrade: z.boolean(),
});

const createCvmResponseSchema = z.object({
  app_id: z.string(),
  app_url: z.string(),
});

const getPubkeyFromCvmResponseSchema = z.object({
  app_env_encrypt_pubkey: z.string(),
  app_id_salt: z.string(),
});

const getCvmByAppIdResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  app_id: z.string(),
  app_url: z.string(),
  encrypted_env_pubkey: z.string(),
  status: z.string(),
});

const getUserInfoResponseSchema = z.object({
  id: z.string(),
  username: z.string(),
});

const getCvmsByUserIdResponseSchema = z.array(cvmInstanceSchema);

const upgradeCvmResponseSchema = z.object({
  detail: z.string(),
});

const encryptedEnvItemSchema = z.object({
  key: z.string(),
  value: z.string(),
});

// Type exports
/**
 * Type definition for the Docker configuration, inferred from the dockerConfigSchema.
 */
export type DockerConfig = z.infer<typeof dockerConfigSchema>;
/**
 * Type definition for the result of inferring the composeFileSchema
 */
export type ComposeFile = z.infer<typeof composeFileSchema>;
/**
 * Represents the inferred type of the configuration schema.
 */
export type Configuration = z.infer<typeof configurationSchema>;
/**
 * Type definition for the inferred type of 'hostedSchema'
 */
export type Hosted = z.infer<typeof hostedSchema>;
/**
 * Type definition for a ManagedUser object, inferred from the managedUserSchema.
 */
export type ManagedUser = z.infer<typeof managedUserSchema>;
/**
 * Type definition for Node based on the inferred type from nodeSchema
 */
export type Node = z.infer<typeof nodeSchema>;
/**
 * Type definition for CvmInstance based on cvmInstanceSchema
 */
export type CvmInstance = z.infer<typeof cvmInstanceSchema>;
/**
 * Type definition for the response of creating a CVM.
 */
export type CreateCvmResponse = z.infer<typeof createCvmResponseSchema>;
/**
 * The type of the response object obtained by inferring the schema for getting public key from CVM.
 */

export type GetPubkeyFromCvmResponse = z.infer<typeof getPubkeyFromCvmResponseSchema>;
/**
 * Type definition for the response of getting CVM by App ID
 */
export type GetCvmByAppIdResponse = z.infer<typeof getCvmByAppIdResponseSchema>;
/**
 * Type definition for the response object returned by the getUserInfo endpoint.
 */
export type GetUserInfoResponse = z.infer<typeof getUserInfoResponseSchema>;
/**
 * Type definition for the response of the function `getCvmsByUserIdResponse`
 */
export type GetCvmsByUserIdResponse = z.infer<typeof getCvmsByUserIdResponseSchema>;
/**
 * Represents the type of response returned when upgrading a CVM (Cloud Virtual Machine).
 */
export type UpgradeCvmResponse = z.infer<typeof upgradeCvmResponseSchema>;
/**
 * Type definition for an item in an encrypted environment.
 */
export type EncryptedEnvItem = z.infer<typeof encryptedEnvItemSchema>;

// Schema exports
/**
 * Collection of schemas used for different data structures.
 *
 * @type {{
 *  dockerConfig: typeof dockerConfigSchema,
 *  composeFile: typeof composeFileSchema,
 *  configuration: typeof configurationSchema,
 *  hosted: typeof hostedSchema,
 *  managedUser: typeof managedUserSchema,
 *  node: typeof nodeSchema,
 *  cvmInstance: typeof cvmInstanceSchema,
 *  createCvmResponse: typeof createCvmResponseSchema,
 *  getPubkeyFromCvmResponse: typeof getPubkeyFromCvmResponseSchema,
 *  getCvmByAppIdResponse: typeof getCvmByAppIdResponseSchema,
 *  getUserInfoResponse: typeof getUserInfoResponseSchema,
 *  getCvmsByUserIdResponse: typeof getCvmsByUserIdResponseSchema,
 *  upgradeCvmResponse: typeof upgradeCvmResponseSchema,
 *  encryptedEnvItem: typeof encryptedEnvItemSchema
 * }} as const
 */
export const schemas = {
  dockerConfig: dockerConfigSchema,
  composeFile: composeFileSchema,
  configuration: configurationSchema,
  hosted: hostedSchema,
  managedUser: managedUserSchema,
  node: nodeSchema,
  cvmInstance: cvmInstanceSchema,
  createCvmResponse: createCvmResponseSchema,
  getPubkeyFromCvmResponse: getPubkeyFromCvmResponseSchema,
  getCvmByAppIdResponse: getCvmByAppIdResponseSchema,
  getUserInfoResponse: getUserInfoResponseSchema,
  getCvmsByUserIdResponse: getCvmsByUserIdResponseSchema,
  upgradeCvmResponse: upgradeCvmResponseSchema,
  encryptedEnvItem: encryptedEnvItemSchema,
} as const;
