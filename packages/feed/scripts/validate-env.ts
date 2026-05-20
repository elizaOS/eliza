#!/usr/bin/env bun

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type ValidationProfile = 'local' | 'staging' | 'production';

export type EnvValues = Record<string, string | undefined>;

type RuleKind = 'allOf' | 'oneOf';

type RuleContext = {
  env: EnvValues;
  profile: ValidationProfile;
};

type ValidationRule = {
  id: string;
  description: string;
  kind: RuleKind;
  keys: string[];
  profiles?: ValidationProfile[];
  when?: (context: RuleContext) => boolean;
};

export type MissingRequirement = {
  id: string;
  description: string;
  requirement: string;
};

type DeprecatedEnvVar = {
  key: string;
  message: string;
};

export type ValidationResult = {
  profile: ValidationProfile;
  activeRuleCount: number;
  missing: MissingRequirement[];
  deprecated: DeprecatedEnvVar[];
  undocumentedKeys: string[];
  valid: boolean;
};

type ParsedArgs = {
  profile?: ValidationProfile;
  envFiles: string[];
  showHelp: boolean;
};

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on', 'start', 'running']);

const BASE_REQUIRED_RULES: ValidationRule[] = [
  {
    id: 'database-url',
    description: 'Database connection',
    kind: 'allOf',
    keys: ['DATABASE_URL'],
  },
  {
    id: 'privy-app-id',
    description: 'Privy application identifier',
    kind: 'oneOf',
    keys: ['NEXT_PUBLIC_PRIVY_APP_ID', 'PRIVY_APP_ID'],
  },
  {
    id: 'privy-app-secret',
    description: 'Privy backend secret',
    kind: 'allOf',
    keys: ['PRIVY_APP_SECRET'],
  },
  {
    id: 'cron-secret',
    description: 'Cron authentication',
    kind: 'allOf',
    keys: ['CRON_SECRET'],
  },
  {
    id: 'llm-provider-key',
    description: 'At least one LLM provider API key',
    kind: 'oneOf',
    keys: ['GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
  },
];

const CONDITIONAL_RULES: ValidationRule[] = [
  {
    id: 'sendgrid-from-address',
    description: 'Notification sender address when SendGrid is enabled',
    kind: 'oneOf',
    keys: ['NOTIFICATION_EMAIL_FROM', 'EMAIL_FROM'],
    when: ({ env }) => isSet(env, 'SENDGRID_API_KEY'),
  },
  {
    id: 'agent0-core',
    description: 'Agent0 runtime settings when Agent0 integration is enabled',
    kind: 'allOf',
    keys: [
      'AGENT0_RPC_URL',
      'AGENT0_PRIVATE_KEY',
      'BABYLON_GAME_WALLET_ADDRESS',
      'AGENT0_SUBGRAPH_URL',
    ],
    when: ({ env }) => isEnabled(env.AGENT0_ENABLED),
  },
  {
    id: 'agent0-ipfs-provider',
    description: 'Agent0 IPFS provider credentials when Agent0 is enabled',
    kind: 'oneOf',
    keys: ['PINATA_JWT', 'FILECOIN_PRIVATE_KEY', 'AGENT0_IPFS_API'],
    when: ({ env }) => isEnabled(env.AGENT0_ENABLED),
  },
  {
    id: 'nft-chat-gating',
    description: 'NFT chat gating dependencies when NFT chat gating is enabled',
    kind: 'allOf',
    keys: ['NFT_CONTRACT_ADDRESS', 'NFT_INDEXER_GRAPHQL_URL'],
    when: ({ env }) => isEnabled(env.NFT_CHAT_GATING_ENABLED),
  },
  {
    id: 'public-app-url',
    description: 'Public app URL for non-local environments',
    kind: 'allOf',
    keys: ['NEXT_PUBLIC_APP_URL'],
    profiles: ['staging', 'production'],
  },
];

const DEPRECATED_ENV_VARS: DeprecatedEnvVar[] = [
  {
    key: 'WAITLIST_MODE',
    message:
      'Deprecated. Waitlist/app routing is host-based now (WAITLIST_HOSTNAMES).',
  },
  {
    key: 'NEXT_PUBLIC_POSTHOG_KEY',
    message: 'Deprecated alias. Use NEXT_PUBLIC_POSTHOG_PROJECT_ID.',
  },
  {
    key: 'BABYLON_GAME_WALLET',
    message: 'Legacy alias. Use BABYLON_GAME_WALLET_ADDRESS.',
  },
];

const UNDOCUMENTED_ALLOWLIST = new Set([
  'CI',
  'HOSTNAME',
  'HOME',
  'PWD',
  'PATH',
  'SHLVL',
]);

function normalizeValue(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isEnabled(value: string | undefined): boolean {
  const normalized = normalizeValue(value)?.toLowerCase();
  if (!normalized) return false;
  return TRUTHY_VALUES.has(normalized);
}

function isSet(env: EnvValues, key: string): boolean {
  return Boolean(normalizeValue(env[key]));
}

function buildRequirement(rule: ValidationRule): string {
  if (rule.kind === 'allOf') {
    return `all of: ${rule.keys.join(', ')}`;
  }
  return `one of: ${rule.keys.join(', ')}`;
}

function isRuleActive(rule: ValidationRule, context: RuleContext): boolean {
  if (rule.profiles && !rule.profiles.includes(context.profile)) {
    return false;
  }
  if (!rule.when) {
    return true;
  }
  return rule.when(context);
}

export function deriveProfile(
  env: EnvValues,
  explicitProfile?: ValidationProfile
): ValidationProfile {
  if (explicitProfile) return explicitProfile;

  const deploymentEnv = env.DEPLOYMENT_ENV?.toLowerCase().trim();
  if (deploymentEnv === 'mainnet') return 'production';
  if (deploymentEnv === 'testnet') return 'staging';
  if (deploymentEnv === 'localnet') return 'local';

  const vercelEnv = env.VERCEL_ENV?.toLowerCase().trim();
  if (vercelEnv === 'production') return 'production';
  if (vercelEnv === 'preview') return 'staging';

  const nodeEnv = env.NODE_ENV?.toLowerCase().trim();
  if (nodeEnv === 'production') return 'production';

  return 'local';
}

export function evaluateEnv(params: {
  env: EnvValues;
  profile: ValidationProfile;
  documentedKeys?: Set<string>;
  declaredFileKeys?: Set<string>;
}): ValidationResult {
  const {
    env,
    profile,
    documentedKeys = new Set(),
    declaredFileKeys = new Set(),
  } = params;
  const context: RuleContext = { env, profile };
  const rules = [...BASE_REQUIRED_RULES, ...CONDITIONAL_RULES].filter((rule) =>
    isRuleActive(rule, context)
  );

  const missing: MissingRequirement[] = [];

  for (const rule of rules) {
    if (rule.kind === 'allOf') {
      const missingKeys = rule.keys.filter((key) => !isSet(env, key));
      if (missingKeys.length > 0) {
        missing.push({
          id: rule.id,
          description: rule.description,
          requirement: buildRequirement(rule),
        });
      }
      continue;
    }

    const hasAny = rule.keys.some((key) => isSet(env, key));
    if (!hasAny) {
      missing.push({
        id: rule.id,
        description: rule.description,
        requirement: buildRequirement(rule),
      });
    }
  }

  const deprecated = DEPRECATED_ENV_VARS.filter(({ key }) => isSet(env, key));
  const deprecatedKeys = new Set(deprecated.map((item) => item.key));

  const undocumentedKeys = Array.from(declaredFileKeys).filter((key) => {
    if (deprecatedKeys.has(key)) return false;
    if (documentedKeys.has(key)) return false;
    if (UNDOCUMENTED_ALLOWLIST.has(key)) return false;
    if (key.startsWith('TURBO_')) return false;
    if (key.startsWith('NX_')) return false;
    return true;
  });

  undocumentedKeys.sort((a, b) => a.localeCompare(b));

  return {
    profile,
    activeRuleCount: rules.length,
    missing,
    deprecated,
    undocumentedKeys,
    valid: missing.length === 0,
  };
}

function loadFileEnv(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }
  const raw = readFileSync(filePath, 'utf8');
  return parseEnvContent(raw);
}

function extractEnvKeys(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf8');
  const keys: string[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const delimiterIndex = trimmed.indexOf('=');
    if (delimiterIndex <= 0) continue;
    const key = trimmed.slice(0, delimiterIndex).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    keys.push(key);
  }
  return keys;
}

function normalizeEnvMap(input: Record<string, string | undefined>): EnvValues {
  const normalized: EnvValues = {};
  for (const [key, value] of Object.entries(input)) {
    normalized[key] = normalizeValue(value);
  }
  return normalized;
}

function parseEnvContent(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const delimiterIndex = trimmed.indexOf('=');
    if (delimiterIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, delimiterIndex).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) {
      continue;
    }

    let rawValue = trimmed.slice(delimiterIndex + 1).trim();
    if (
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) {
      rawValue = rawValue.slice(1, -1);
    }

    parsed[key] = rawValue;
  }
  return parsed;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    envFiles: [],
    showHelp: false,
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg) continue;

    if (arg === '--help' || arg === '-h') {
      parsed.showHelp = true;
      continue;
    }

    if (arg.startsWith('--profile=')) {
      const profile = arg.slice('--profile='.length) as ValidationProfile;
      if (!['local', 'staging', 'production'].includes(profile)) {
        throw new Error(
          `Invalid --profile value "${profile}". Expected local|staging|production.`
        );
      }
      parsed.profile = profile;
      continue;
    }

    if (arg === '--profile') {
      const value = args[index + 1] as ValidationProfile | undefined;
      if (!value) {
        throw new Error('--profile requires a value.');
      }
      if (!['local', 'staging', 'production'].includes(value)) {
        throw new Error(
          `Invalid --profile value "${value}". Expected local|staging|production.`
        );
      }
      parsed.profile = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--env-file=')) {
      const filePath = arg.slice('--env-file='.length).trim();
      if (!filePath) {
        throw new Error('--env-file cannot be empty.');
      }
      parsed.envFiles.push(filePath);
      continue;
    }

    if (arg === '--env-file') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('--env-file requires a value.');
      }
      parsed.envFiles.push(value);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument "${arg}". Use --help for usage.`);
  }

  return parsed;
}

function getDefaultEnvFiles(profile: ValidationProfile): string[] {
  if (profile === 'production') {
    return ['.env', '.env.production.local'];
  }
  if (profile === 'staging') {
    return ['.env', '.env.staging.local'];
  }
  return ['.env', '.env.local'];
}

function printHelp(): void {
  console.info('Validate Babylon environment variables');
  console.info('');
  console.info('Usage:');
  console.info(
    '  bun run scripts/validate-env.ts [--profile local|staging|production] [--env-file <path>]'
  );
  console.info('');
  console.info('Examples:');
  console.info('  bun run scripts/validate-env.ts');
  console.info(
    '  bun run scripts/validate-env.ts --profile=staging --env-file=.env.staging.local'
  );
}

function printMissingRequirements(missing: MissingRequirement[]): void {
  console.error('Missing required environment settings:');
  for (const item of missing) {
    console.error(`- ${item.description}`);
    console.error(`  requirement: ${item.requirement}`);
  }
}

function printWarnings(result: ValidationResult): void {
  if (result.deprecated.length > 0) {
    console.warn('');
    console.warn('Deprecated environment variables detected:');
    for (const warning of result.deprecated) {
      console.warn(`- ${warning.key}: ${warning.message}`);
    }
  }

  if (result.undocumentedKeys.length > 0) {
    console.warn('');
    console.warn(
      `Undocumented keys detected in loaded env files (${result.undocumentedKeys.length}):`
    );
    const preview = result.undocumentedKeys.slice(0, 40);
    for (const key of preview) {
      console.warn(`- ${key}`);
    }
    if (result.undocumentedKeys.length > preview.length) {
      const extraCount = result.undocumentedKeys.length - preview.length;
      console.warn(`- ...and ${extraCount} more`);
    }
  }
}

export function runCli(args: string[] = process.argv.slice(2)): number {
  const parsedArgs = parseArgs(args);
  if (parsedArgs.showHelp) {
    printHelp();
    return 0;
  }

  const processEnv = normalizeEnvMap(process.env);
  const profile = deriveProfile(processEnv, parsedArgs.profile);

  const filesToLoad = getDefaultEnvFiles(profile);
  for (const file of parsedArgs.envFiles) {
    filesToLoad.push(file);
  }

  const loadedFiles: string[] = [];
  const mergedFileEnv: EnvValues = {};
  const declaredFileKeys = new Set<string>();
  for (const file of filesToLoad) {
    const absolutePath = resolve(process.cwd(), file);
    if (!existsSync(absolutePath)) {
      continue;
    }
    const parsedFile = loadFileEnv(absolutePath);
    for (const [key, value] of Object.entries(parsedFile)) {
      mergedFileEnv[key] = normalizeValue(value);
    }
    for (const key of extractEnvKeys(absolutePath)) {
      declaredFileKeys.add(key);
    }
    loadedFiles.push(file);
  }

  const mergedEnv: EnvValues = {
    ...mergedFileEnv,
    ...processEnv,
  };

  const examplePath = resolve(process.cwd(), '.env.example');
  const documentedKeys = new Set(extractEnvKeys(examplePath));

  const result = evaluateEnv({
    env: mergedEnv,
    profile,
    documentedKeys,
    declaredFileKeys,
  });

  console.info(`Profile: ${result.profile}`);
  if (loadedFiles.length > 0) {
    console.info(`Loaded env files: ${loadedFiles.join(', ')}`);
  } else {
    console.info('Loaded env files: none (using process environment only)');
  }
  console.info(`Active rules: ${result.activeRuleCount}`);

  if (!result.valid) {
    console.error('');
    printMissingRequirements(result.missing);
    printWarnings(result);
    return 1;
  }

  console.info('');
  console.info('Environment validation passed.');
  printWarnings(result);
  return 0;
}

if (import.meta.main) {
  process.exit(runCli());
}
