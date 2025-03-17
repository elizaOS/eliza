import CharacterForm from '@/components/character-form';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '@/lib/api';
import type { Agent } from '@elizaos/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AvatarPanel from './avatar-panel';
import PluginsPanel from './plugins-panel';
import SecretPanel from './secret-panel';

const defaultCharacter = {
  name: '',
  username: '',
  system: '',
  bio: [] as string[],
  topics: [] as string[],
  adjectives: [] as string[],
} as Agent;

export default function AgentCreator() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [characterValue, setCharacterValue] = useState<Agent>({
    ...defaultCharacter,
  });

  const ensureRequiredFields = (character: Agent): Agent => {
    return {
      ...character,
      bio: character.bio ?? [],
      messageExamples: character.messageExamples ?? [],
      postExamples: character.postExamples ?? [],
      topics: character.topics ?? [],
      adjectives: character.adjectives ?? [],
      plugins: character.plugins ?? [],
      style: {
        all: character.style?.all ?? [],
        chat: character.style?.chat ?? [],
        post: character.style?.post ?? [],
      },
    };
  };

  const handleSubmit = async (character: Agent) => {
    try {
      const completeCharacter = ensureRequiredFields(character);
      await apiClient.createAgent({
        characterJson: completeCharacter,
      });

      // Invalidate the characters query to refresh the characters list
      queryClient.invalidateQueries({ queryKey: ['characters'] });

      toast({
        title: 'Success',
        description: 'Character created successfully!',
      });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      navigate('/');
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create character',
        variant: 'destructive',
      });
    }
  };

  return (
    <CharacterForm
      characterValue={characterValue}
      setCharacterValue={setCharacterValue}
      title="Character Settings"
      description="Configure your AI character's behavior and capabilities"
      onSubmit={handleSubmit}
      onReset={() => setCharacterValue(defaultCharacter)}
      onDelete={() => {
        navigate('/');
      }}
      isAgent={true}
      customComponents={[
        {
          name: 'Plugins',
          component: (
            <PluginsPanel characterValue={characterValue} setCharacterValue={setCharacterValue} />
          ),
        },
        {
          name: 'Secret',
          component: (
            <SecretPanel characterValue={characterValue} setCharacterValue={setCharacterValue} />
          ),
        },
        {
          name: 'Avatar',
          component: (
            <AvatarPanel characterValue={characterValue} setCharacterValue={setCharacterValue} />
          ),
        },
      ]}
    />
  );
}
