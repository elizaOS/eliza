export interface VoiceModel {
  value: string;
  label: string;
  provider: 'local' | 'elevenlabs';
  gender?: 'male' | 'female';
  language?: string;
  features?: string[];
}

// Map of voice model providers to their required plugins
export const providerPluginMap: Record<string, string> = {
  elevenlabs: '@elizaos/plugin-elevenlabs',
  local: '@elizaos/plugin-local-ai',
};

export const localVoiceModels: VoiceModel[] = [
  { value: 'female_1', label: 'Local Voice - Female 1', provider: 'local', gender: 'female' },
  { value: 'female_2', label: 'Local Voice - Female 2', provider: 'local', gender: 'female' },
  { value: 'male_1', label: 'Local Voice - Male 1', provider: 'local', gender: 'male' },
  { value: 'male_2', label: 'Local Voice - Male 2', provider: 'local', gender: 'male' },
];

export const elevenLabsVoiceModels: VoiceModel[] = [
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

export const getAllVoiceModels = (): VoiceModel[] => {
  return [...localVoiceModels, ...elevenLabsVoiceModels];
};

export const getVoiceModelsByProvider = (provider: 'local' | 'elevenlabs'): VoiceModel[] => {
  return provider === 'local' ? localVoiceModels : elevenLabsVoiceModels;
};

export const getVoiceModelByValue = (value: string): VoiceModel | undefined => {
  return getAllVoiceModels().find((model) => model.value === value);
};

export const getRequiredPluginForProvider = (provider: string): string | undefined => {
  return providerPluginMap[provider];
};

export const getAllRequiredPlugins = (): string[] => {
  return Object.values(providerPluginMap);
};
