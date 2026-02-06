/**
 * Valid types for environment variable/secret configuration
 */
export type EnvVarType =
  | "api_key"
  | "private_key"
  | "public_key"
  | "url"
  | "credential"
  | "config"
  | "secret";

export interface EnvVarConfig {
  value?: string;
  type: EnvVarType;
  required: boolean;
  description: string;
  canGenerate: boolean;
  validationMethod?: string;
  status: "missing" | "generating" | "validating" | "invalid" | "valid";
  lastError?: string;
  attempts: number;
  createdAt?: number;
  validatedAt?: number;
  plugin: string;
}

export interface EnvVarMetadata {
  [pluginName: string]: {
    [varName: string]: EnvVarConfig;
  };
}

export interface GenerationScript {
  variableName: string;
  pluginName: string;
  script: string;
  dependencies: string[];
  attempts: number;
  output?: string;
  error?: string;
  status: "pending" | "running" | "success" | "failed";
  createdAt: number;
}

export interface GenerationScriptMetadata {
  [scriptId: string]: GenerationScript;
}

export interface EnvVarUpdate {
  pluginName: string;
  variableName: string;
  value: string;
}

export interface ValidationResult {
  isValid: boolean;
  error?: string;
  details?: string;
}

// New types for multi-level secret management
export interface SecretConfig extends EnvVarConfig {
  level: "global" | "world" | "user";
  ownerId?: string; // UUID as string
  worldId?: string; // UUID as string
  encrypted?: boolean;
  permissions?: SecretPermission[];
  sharedWith?: string[]; // UUIDs of entities with access
}

/**
 * Valid permission types for secrets
 */
export type SecretPermissionType = "read" | "write" | "delete" | "share";

export interface SecretPermission {
  entityId: string; // UUID
  permissions: SecretPermissionType[];
  grantedBy: string; // UUID
  grantedAt: number;
  expiresAt?: number;
}

export interface SecretContext {
  level: "global" | "world" | "user";
  worldId?: string; // UUID
  userId?: string; // UUID
  agentId: string; // UUID
  requesterId?: string; // UUID of entity making the request
}

export interface SecretMetadata {
  [key: string]: SecretConfig;
}

export interface SecretAccessLog {
  secretKey: string;
  accessedBy: string; // UUID
  action: "read" | "write" | "delete" | "share";
  timestamp: number;
  context: SecretContext;
  success: boolean;
  error?: string;
}

export interface EncryptedSecret {
  value: string; // encrypted value
  iv: string; // initialization vector
  authTag?: string; // for authenticated encryption
  algorithm: string;
  keyId: string; // reference to encryption key
}
