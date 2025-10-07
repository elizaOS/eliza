export interface VoiceModel {
  value: string;
  label: string;
  provider: 'elevenlabs' | 'openai' | 'none';
  gender?: 'male' | 'female';
  language?: string;
  features?: string[];
}

// TODO: ELI2-218 Refactor this to use plugin categories when available
// This hardcoded mapping will be replaced with a more flexible approach
// that leverages plugin category metadata once implemented

export const providerPluginMap: Record<string, string> = {
  elevenlabs: '@elizaos/plugin-elevenlabs',
  openai: '@elizaos/plugin-openai',
  none: '', // No plugin needed for "No Voice" option
};

// No voice option for agents that don't need speech capabilities
export const noVoiceModel: VoiceModel[] = [{ value: 'none', label: 'No Voice', provider: 'none' }];

export const localVoiceModels: VoiceModel[] = [];

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

export const openAIVoiceModels: VoiceModel[] = [
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

export const getAllVoiceModels = (): VoiceModel[] => {
  return [...noVoiceModel, ...localVoiceModels, ...elevenLabsVoiceModels, ...openAIVoiceModels];
};

export const getVoiceModelsByProvider = (
  provider: 'elevenlabs' | 'openai' | 'none'
): VoiceModel[] => {
  switch (provider) {
    case 'elevenlabs':
      return elevenLabsVoiceModels;
    case 'openai':
      return openAIVoiceModels;
    case 'none':
      return noVoiceModel;
    default:
      return [];
  }
};

export const getVoiceModelByValue = (value: string): VoiceModel | undefined => {
  return getAllVoiceModels().find((model) => model.value === value);
};

export const getRequiredPluginForProvider = (provider: string): string | undefined => {
  return providerPluginMap[provider];
};

export const getAllRequiredPlugins = (): string[] => {
  // Filter out empty strings (for "none" provider)
  return Object.values(providerPluginMap).filter(Boolean);
};
