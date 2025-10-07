import CharacterForm from '@/components/character-form';
import { useToast } from '@/hooks/use-toast';
import { createElizaClient } from '@/lib/api-client-config';
import type { Agent } from '@elizaos/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import AvatarPanel from './avatar-panel';
import PluginsPanel from './plugins-panel';
import { SecretPanel, type SecretPanelRef } from './secret-panel';
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
  plugins: ['@elizaos/plugin-sql', '@elizaos/plugin-openai', '@elizaos/plugin-bootstrap'],
  settings: { secrets: {} },
};

export default function AgentCreator() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [initialCharacter] = useState<Partial<Agent>>({
    ...defaultCharacter,
  });
  const secretPanelRef = useRef<SecretPanelRef>(null);
  const [currentSecrets, setCurrentSecrets] = useState<Record<string, string | null>>({});

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

      // Get secrets from state (or ref as fallback)
      const secrets = currentSecrets || secretPanelRef.current?.getSecrets() || {};
      if (secrets && Object.keys(secrets).length > 0) {
        // Add secrets to the character settings
        completeCharacter.settings = {
          ...completeCharacter.settings,
          secrets,
        };
      }

      const elizaClient = createElizaClient();
      await elizaClient.agents.createAgent({ agent: completeCharacter });

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
    <div className="h-full w-full">
      <CharacterForm
        characterValue={agentState.agent}
        setCharacterValue={agentState}
        title="Create Agent"
        description="Configure your AI agent's behavior and capabilities."
        onSubmit={handleSubmit}
        onReset={() => {
          agentState.reset();
          setCurrentSecrets({});
        }}
        onDelete={() => {
          navigate('/');
        }}
        onTemplateChange={() => {
          setCurrentSecrets({});
        }}
        isAgent={true}
        secretPanelRef={secretPanelRef}
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
                ref={secretPanelRef}
                onChange={(secrets) => {
                  // Only update local state, don't update agent state to avoid circular updates
                  setCurrentSecrets(secrets);
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
    </div>
  );
}
