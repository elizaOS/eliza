import CharacterForm from '@/components/character-form';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '@/lib/api';
import type { Agent } from '@elizaos/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AvatarPanel from './avatar-panel';
import PluginsPanel from './plugins-panel';
import { SecretPanel } from './secret-panel';
import { useAgentUpdate } from '@/hooks/use-agent-update';
import { getTemplateById } from '@/config/agent-templates';

// Define a partial agent for initialization from the "none" template
const defaultCharacter: Partial<Agent> = getTemplateById('none')?.template || {
  name: '',
  username: '',
  system: '',
  bio: [] as string[],
  topics: [] as string[],
  adjectives: [] as string[],
  plugins: ['@elizaos/plugin-sql', '@elizaos/plugin-openai'],
  settings: { secrets: {} },
};

export default function AgentCreator() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [initialCharacter] = useState<Partial<Agent>>({
    ...defaultCharacter,
  });

  // Use agent update hook for proper handling of nested fields
  const agentState = useAgentUpdate(initialCharacter as Agent);

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
      settings: character.settings ?? { secrets: {} },
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
        description: 'Agent created successfully!',
      });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      navigate('/');
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create agent',
        variant: 'destructive',
      });
    }
  };

  return (
    <CharacterForm
      characterValue={agentState.agent}
      setCharacterValue={agentState}
      title="Agent Settings"
      description="Configure your AI agent's behavior and capabilities. Recommended default plugins: @elizaos/plugin-sql, @elizaos/plugin-local-ai"
      onSubmit={handleSubmit}
      onReset={() => agentState.reset()}
      onDelete={() => {
        navigate('/');
      }}
      isAgent={true}
      customComponents={[
        {
          name: 'Plugins',
          component: (
            <PluginsPanel characterValue={agentState.agent} setCharacterValue={agentState} />
          ),
        },
        {
          name: 'Secret',
          component: (
            <SecretPanel
              characterValue={agentState.agent}
              onChange={(updatedAgent) => {
                agentState.updateSettings(updatedAgent.settings);
              }}
            />
          ),
        },
        {
          name: 'Avatar',
          component: (
            <AvatarPanel characterValue={agentState.agent} setCharacterValue={agentState} />
          ),
        },
      ]}
    />
  );
}
