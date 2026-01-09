/**
 * Voice model configuration for ElizaOS agents.
 *
 * This module provides a registry-based approach for voice models that can be
 * extended by plugins. Plugins can register their voice models using the
 * `registerVoiceModels` function.
 *
 * In the future, when plugin categories are implemented in the core Plugin interface,
 * voice models will be auto-discovered from plugins tagged with the 'voice' category.
 * Until then, this registry serves as the central source for available voice models.
 */

export type VoiceProvider = 'elevenlabs' | 'openai' | 'none';

export interface VoiceModel {
  /** Unique identifier for the voice model (e.g., API voice ID) */
  value: string;
  /** Human-readable label for display */
  label: string;
  /** Voice provider that serves this model */
  provider: VoiceProvider;
  /** Voice gender characteristic */
  gender?: 'male' | 'female';
  /** Primary language code (ISO 639-1) */
  language?: string;
  /** Descriptive features of the voice */
  features?: string[];
  /** Whether this is a custom/cloned voice */
  isCustom?: boolean;
}

/**
 * Voice provider metadata including required plugin information.
 */
interface VoiceProviderConfig {
  /** Display name for the provider */
  displayName: string;
  /** ElizaOS plugin package name required for this provider */
  pluginPackage: string;
  /** Whether this provider requires an API key */
  requiresApiKey: boolean;
  /** Environment variable name for the API key */
  apiKeyEnvVar?: string;
}

/**
 * Voice provider configuration registry.
 * Maps provider identifiers to their configuration metadata.
 */
const voiceProviderConfigs: Record<VoiceProvider, VoiceProviderConfig> = {
  elevenlabs: {
    displayName: 'ElevenLabs',
    pluginPackage: '@elizaos/plugin-elevenlabs',
    requiresApiKey: true,
    apiKeyEnvVar: 'ELEVENLABS_API_KEY',
  },
  openai: {
    displayName: 'OpenAI',
    pluginPackage: '@elizaos/plugin-openai',
    requiresApiKey: true,
    apiKeyEnvVar: 'OPENAI_API_KEY',
  },
  none: {
    displayName: 'No Voice',
    pluginPackage: '',
    requiresApiKey: false,
  },
};

/**
 * Plugin to voice provider mapping for backward compatibility.
 * @deprecated Use `voiceProviderConfigs` and `getProviderConfig` instead.
 */
export const providerPluginMap: Record<string, string> = Object.fromEntries(
  Object.entries(voiceProviderConfigs).map(([provider, config]) => [provider, config.pluginPackage])
);

/**
 * Internal voice model registry.
 * Plugins can extend this registry using `registerVoiceModels`.
 */
const voiceModelRegistry: Map<VoiceProvider, VoiceModel[]> = new Map();

// Initialize with no voice option
const noVoiceModel: VoiceModel = {
  value: 'none',
  label: 'No Voice',
  provider: 'none',
};

// Built-in ElevenLabs voice models
const builtInElevenLabsModels: VoiceModel[] = [
  {
    value: 'EXAVITQu4vr4xnSDxMaL',
    label: 'ElevenLabs - Rachel (Default)',
    provider: 'elevenlabs',
    gender: 'female',
    language: 'en',
    features: ['natural', 'professional'],
  },
  {
    value: '21m00Tcm4TlvDq8ikWAM',
    label: 'ElevenLabs - Adam',
    provider: 'elevenlabs',
    gender: 'male',
    language: 'en',
    features: ['natural', 'professional'],
  },
  {
    value: 'AZnzlk1XvdvUeBnXmlld',
    label: 'ElevenLabs - Domi',
    provider: 'elevenlabs',
    gender: 'female',
    language: 'en',
    features: ['natural', 'friendly'],
  },
  {
    value: 'MF3mGyEYCl7XYWbV9V6O',
    label: 'ElevenLabs - Elli',
    provider: 'elevenlabs',
    gender: 'female',
    language: 'en',
    features: ['natural', 'friendly'],
  },
  {
    value: 'TxGEqnHWrfWFTfGW9XjX',
    label: 'ElevenLabs - Josh',
    provider: 'elevenlabs',
    gender: 'male',
    language: 'en',
    features: ['natural', 'professional'],
  },
];

// Built-in OpenAI voice models
const builtInOpenAIModels: VoiceModel[] = [
  {
    value: 'alloy',
    label: 'OpenAI - Alloy',
    provider: 'openai',
    gender: 'female',
    language: 'en',
    features: ['natural', 'versatile'],
  },
  {
    value: 'echo',
    label: 'OpenAI - Echo',
    provider: 'openai',
    gender: 'male',
    language: 'en',
    features: ['natural', 'professional'],
  },
  {
    value: 'fable',
    label: 'OpenAI - Fable',
    provider: 'openai',
    gender: 'male',
    language: 'en',
    features: ['natural', 'narrative'],
  },
  {
    value: 'onyx',
    label: 'OpenAI - Onyx',
    provider: 'openai',
    gender: 'male',
    language: 'en',
    features: ['natural', 'deep'],
  },
  {
    value: 'nova',
    label: 'OpenAI - Nova',
    provider: 'openai',
    gender: 'female',
    language: 'en',
    features: ['natural', 'friendly'],
  },
  {
    value: 'shimmer',
    label: 'OpenAI - Shimmer',
    provider: 'openai',
    gender: 'female',
    language: 'en',
    features: ['natural', 'bright'],
  },
  {
    value: 'ash',
    label: 'OpenAI - Ash',
    provider: 'openai',
    gender: 'male',
    language: 'en',
    features: ['natural', 'calm'],
  },
  {
    value: 'coral',
    label: 'OpenAI - Coral',
    provider: 'openai',
    gender: 'female',
    language: 'en',
    features: ['natural', 'warm'],
  },
  {
    value: 'sage',
    label: 'OpenAI - Sage',
    provider: 'openai',
    gender: 'female',
    language: 'en',
    features: ['natural', 'wise'],
  },
  {
    value: 'ballad',
    label: 'OpenAI - Ballad',
    provider: 'openai',
    gender: 'male',
    language: 'en',
    features: ['natural', 'melodic'],
  },
];

/**
 * Initialize the voice model registry with built-in models.
 */
function initializeRegistry(): void {
  voiceModelRegistry.set('none', [noVoiceModel]);
  voiceModelRegistry.set('elevenlabs', [...builtInElevenLabsModels]);
  voiceModelRegistry.set('openai', [...builtInOpenAIModels]);
}

// Initialize on module load
initializeRegistry();

/**
 * Register voice models for a provider.
 * This allows plugins to add custom voice models at runtime.
 *
 * @param provider - The voice provider
 * @param models - Array of voice models to register
 * @param options - Registration options
 */
export function registerVoiceModels(
  provider: VoiceProvider,
  models: VoiceModel[],
  options: { replace?: boolean } = {}
): void {
  const existingModels = voiceModelRegistry.get(provider) ?? [];

  if (options.replace) {
    voiceModelRegistry.set(provider, models);
  } else {
    // Merge models, avoiding duplicates by value
    const existingValues = new Set(existingModels.map((m) => m.value));
    const newModels = models.filter((m) => !existingValues.has(m.value));
    voiceModelRegistry.set(provider, [...existingModels, ...newModels]);
  }
}

/**
 * Clear all voice models for a provider.
 * Useful for testing or reinitializing the registry.
 */
export function clearVoiceModels(provider: VoiceProvider): void {
  voiceModelRegistry.set(provider, []);
}

/**
 * Reset the registry to built-in models only.
 */
export function resetVoiceModelRegistry(): void {
  voiceModelRegistry.clear();
  initializeRegistry();
}

/**
 * Get the configuration for a voice provider.
 */
export function getProviderConfig(provider: VoiceProvider): VoiceProviderConfig {
  return voiceProviderConfigs[provider];
}

/**
 * Get all registered voice models across all providers.
 */
export function getAllVoiceModels(): VoiceModel[] {
  const allModels: VoiceModel[] = [];
  // Ensure consistent ordering: none first, then alphabetically
  const orderedProviders: VoiceProvider[] = ['none', 'elevenlabs', 'openai'];

  for (const provider of orderedProviders) {
    const models = voiceModelRegistry.get(provider);
    if (models) {
      allModels.push(...models);
    }
  }

  return allModels;
}

/**
 * Get voice models for a specific provider.
 */
export function getVoiceModelsByProvider(provider: VoiceProvider): VoiceModel[] {
  return voiceModelRegistry.get(provider) ?? [];
}

/**
 * Find a voice model by its value identifier.
 */
export function getVoiceModelByValue(value: string): VoiceModel | undefined {
  for (const models of voiceModelRegistry.values()) {
    const found = models.find((model) => model.value === value);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * Get the required plugin package for a voice provider.
 */
export function getRequiredPluginForProvider(provider: VoiceProvider): string | undefined {
  const config = voiceProviderConfigs[provider];
  return config?.pluginPackage || undefined;
}

/**
 * Get all required plugin packages for voice functionality.
 */
export function getAllRequiredPlugins(): string[] {
  return Object.values(voiceProviderConfigs)
    .map((config) => config.pluginPackage)
    .filter(Boolean);
}

/**
 * Get all available voice providers.
 */
export function getAvailableProviders(): VoiceProvider[] {
  return Array.from(voiceModelRegistry.keys());
}

/**
 * Check if a provider has any registered voice models.
 */
export function hasVoiceModels(provider: VoiceProvider): boolean {
  const models = voiceModelRegistry.get(provider);
  return Boolean(models && models.length > 0);
}

// Legacy exports for backward compatibility
export const noVoiceModels: VoiceModel[] = [noVoiceModel];
export const localVoiceModels: VoiceModel[] = [];
export const elevenLabsVoiceModels: VoiceModel[] = builtInElevenLabsModels;
export const openAIVoiceModels: VoiceModel[] = builtInOpenAIModels;
