import { useEffect, useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import {
  type VoiceModel,
  getProviderConfig,
  getVoiceModelsByProvider,
  registerVoiceModels,
} from '@/config/voice-models';

/**
 * ElevenLabs API configuration
 */
const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io';
const ELEVENLABS_API_VERSION = 'v2';
const ELEVENLABS_VOICES_ENDPOINT = `${ELEVENLABS_API_BASE}/${ELEVENLABS_API_VERSION}/voices`;

/**
 * Cache duration for ElevenLabs voices (1 hour)
 */
const VOICE_CACHE_DURATION_MS = 60 * 60 * 1000;

/**
 * Local storage key for ElevenLabs API key
 */
const ELEVENLABS_API_KEY_STORAGE_KEY = 'ELEVENLABS_API_KEY';

/**
 * Zod schema for validating ElevenLabs voice label data
 */
const ElevenLabsVoiceLabelsSchema = z.object({
  accent: z.string().optional(),
  age: z.string().optional(),
  description: z.string().optional(),
  gender: z.string().optional(),
  use_case: z.string().optional(),
});

/**
 * Zod schema for validating individual ElevenLabs voice data
 */
const ElevenLabsVoiceSchema = z.object({
  voice_id: z.string(),
  name: z.string(),
  category: z.string(),
  labels: ElevenLabsVoiceLabelsSchema.optional(),
  preview_url: z.string().optional(),
});

/**
 * Zod schema for validating ElevenLabs API response
 */
const ElevenLabsVoicesResponseSchema = z.object({
  voices: z.array(ElevenLabsVoiceSchema),
});

type ElevenLabsVoice = z.infer<typeof ElevenLabsVoiceSchema>;

/**
 * Transform an ElevenLabs API voice to our VoiceModel format
 */
function transformToVoiceModel(voice: ElevenLabsVoice): VoiceModel {
  const gender = voice.labels?.gender?.toLowerCase();
  return {
    value: voice.voice_id,
    label: `ElevenLabs - ${voice.name} (Custom)`,
    provider: 'elevenlabs',
    gender: gender === 'female' ? 'female' : 'male',
    language: 'en',
    features: [voice.category || 'professional', voice.labels?.description || 'natural'].filter(
      Boolean
    ),
    isCustom: true,
  };
}

/**
 * Fetch and validate custom ElevenLabs voices from the API
 */
async function fetchElevenLabsVoices(apiKey: string): Promise<VoiceModel[]> {
  const response = await fetch(ELEVENLABS_VOICES_ENDPOINT, {
    method: 'GET',
    headers: {
      'xi-api-key': apiKey,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`ElevenLabs API error: ${response.status} ${response.statusText}`);
  }

  const rawData: unknown = await response.json();
  const validatedData = ElevenLabsVoicesResponseSchema.parse(rawData);

  // Get built-in voice IDs to filter out
  const builtInVoiceIds = new Set(getVoiceModelsByProvider('elevenlabs').map((v) => v.value));

  // Filter to only custom voices (not in built-in list)
  const customVoices = validatedData.voices.filter((voice) => !builtInVoiceIds.has(voice.voice_id));

  return customVoices.map(transformToVoiceModel);
}

/**
 * Get the ElevenLabs API key from local storage
 */
function getStoredApiKey(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return localStorage.getItem(ELEVENLABS_API_KEY_STORAGE_KEY);
}

/**
 * Hook result interface
 */
interface UseElevenLabsVoicesResult {
  /** Custom ElevenLabs voices fetched from the API */
  data: VoiceModel[] | undefined;
  /** Whether the voices are currently loading */
  isLoading: boolean;
  /** Error that occurred during fetching */
  error: Error | null;
  /** Whether an API key is configured */
  hasApiKey: boolean;
  /** Refetch the voices */
  refetch: () => void;
}

/**
 * Hook to fetch custom ElevenLabs voices.
 *
 * This hook retrieves the user's custom/cloned ElevenLabs voices using their API key
 * stored in localStorage. The voices are automatically registered with the voice
 * model registry so they appear in voice selection UIs.
 *
 * Built-in ElevenLabs voices are excluded from the results since they're already
 * available in the voice model registry.
 *
 * @example
 * ```tsx
 * function VoiceSelector() {
 *   const { data: customVoices, isLoading, hasApiKey } = useElevenLabsVoices();
 *
 *   if (!hasApiKey) {
 *     return <p>Please configure your ElevenLabs API key to see custom voices.</p>;
 *   }
 *
 *   if (isLoading) {
 *     return <p>Loading custom voices...</p>;
 *   }
 *
 *   return (
 *     <select>
 *       {customVoices?.map(voice => (
 *         <option key={voice.value} value={voice.value}>{voice.label}</option>
 *       ))}
 *     </select>
 *   );
 * }
 * ```
 */
export function useElevenLabsVoices(): UseElevenLabsVoicesResult {
  const [apiKey, setApiKey] = useState<string | null>(null);

  // Load API key from localStorage on mount
  useEffect(() => {
    const storedKey = getStoredApiKey();
    setApiKey(storedKey);

    // Listen for storage changes (in case API key is updated in another tab)
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === ELEVENLABS_API_KEY_STORAGE_KEY) {
        setApiKey(event.newValue);
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  const query = useQuery({
    queryKey: ['elevenlabs-voices', apiKey],
    queryFn: async () => {
      if (!apiKey) {
        return [];
      }

      const customVoices = await fetchElevenLabsVoices(apiKey);

      // Register custom voices with the voice model registry
      // This makes them available through getAllVoiceModels() and getVoiceModelsByProvider()
      if (customVoices.length > 0) {
        registerVoiceModels('elevenlabs', customVoices);
      }

      return customVoices;
    },
    enabled: Boolean(apiKey),
    staleTime: VOICE_CACHE_DURATION_MS,
    refetchOnWindowFocus: false,
    retry: 2,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error as Error | null,
    hasApiKey: Boolean(apiKey),
    refetch: query.refetch,
  };
}

/**
 * Get the ElevenLabs provider configuration.
 * Useful for displaying provider-specific UI elements.
 */
export function getElevenLabsConfig() {
  return getProviderConfig('elevenlabs');
}
