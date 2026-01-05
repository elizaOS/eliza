import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { elevenLabsVoiceModels } from '@/config/voice-models';
import type { VoiceModel } from '@/config/voice-models';
import clientLogger from '@/lib/logger';

// TODO: Move this to a shared config file, or the 11labs plugin once plugin categories are implemented

interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category: string;
  labels?: {
    accent?: string;
    age?: string;
    description?: string;
    gender?: string;
    use_case?: string;
  };
  preview_url?: string;
}

export function useElevenLabsVoices() {
  const [apiKey, setApiKey] = useState<string | null>(null);

  // Load API key from localStorage or another source
  useEffect(() => {
    const storedKey = localStorage.getItem('ELEVENLABS_API_KEY');
    setApiKey(storedKey);
  }, []);

  return useQuery({
    queryKey: ['elevenlabs-voices', apiKey],
    queryFn: async () => {
      // If no API key is available, return empty array (no custom voices)
      if (!apiKey) {
        return [];
      }

      try {
        const response = await fetch('https://api.elevenlabs.io/v2/voices', {
          method: 'GET',
          headers: {
            'xi-api-key': apiKey,
          },
        });

        if (!response.ok) {
          clientLogger.error('Failed to fetch ElevenLabs voices:', response.statusText);
          return [];
        }

        const data = await response.json();

        // Get the IDs of the default voices we already have
        const defaultVoiceIds = elevenLabsVoiceModels.map((v) => v.value);

        // Filter to only include custom/cloned voices (those not in the default list)
        const customVoices: ElevenLabsVoice[] = data.voices.filter(
          (voice: ElevenLabsVoice) => !defaultVoiceIds.includes(voice.voice_id)
        );

        // Transform only the custom voices to match our VoiceModel format
        const apiVoices: VoiceModel[] = customVoices.map((voice: ElevenLabsVoice) => ({
          value: voice.voice_id,
          label: `ElevenLabs - ${voice.name} (Custom)`,
          provider: 'elevenlabs',
          gender: voice.labels?.gender === 'female' ? 'female' : 'male',
          language: 'en',
          features: [voice.category || 'professional', voice.labels?.description || 'natural'],
        }));

        return apiVoices;
      } catch (error) {
        clientLogger.error('Error fetching ElevenLabs voices:', error);
        return [];
      }
    },
    // Refresh the data every hour
    staleTime: 60 * 60 * 1000,
    // Don't refetch on window focus
    refetchOnWindowFocus: false,
  });
}
