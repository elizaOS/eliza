import CharacterForm from '@/components/character-form';
import { useToast } from '@/hooks/use-toast';
import { useAgentUpdate } from '@/hooks/use-agent-update';
import { apiClient } from '@/lib/api';
import { deepMerge } from '@/lib/utils';
import type { Agent, UUID } from '@elizaos/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import AvatarPanel from './avatar-panel';
import PluginsPanel from './plugins-panel';
import SecretPanel from './secret-panel';

export default function AgentSettings({ agent, agentId }: { agent: Agent; agentId: UUID }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Use our agent update hook for more intelligent handling of JSONb fields
  const { agent: agentState, updateObject, reset } = useAgentUpdate(agent);
  const [characterValue, setCharacterValue] = useState<Agent>(agent);

  // Keep characterValue in sync with agentState (our source of truth)
  useEffect(() => {
    setCharacterValue(agentState);
  }, [agentState]);

  // When setCharacterValue is called, update our agentState
  const handleCharacterValueChange = (updater: (prev: Agent) => Agent) => {
    const newValue = updater(characterValue);
    updateObject(newValue);
    setCharacterValue(newValue);
  };

  const handleSubmit = async (updatedAgent: Agent) => {
    try {
      // Call the API to update the agent's character
      if (!agentId) {
        throw new Error('Agent ID is missing');
      }

      // Make sure we're properly merging all JSONb fields
      // Get the original agent to ensure we're starting with complete data
      const { data: currentAgent } = await apiClient.getAgent(agentId);

      // Create a properly merged agent object
      // This ensures all JSONb fields are correctly handled
      const mergedAgent = deepMerge(currentAgent, {
        ...updatedAgent,
        plugins: characterValue.plugins, // Preserve the plugins from our local state
      });

      // Send the character update request to the agent endpoint
      await apiClient.updateAgent(agentId, mergedAgent);

      // Invalidate both the agent query and the agents list
      queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
      queryClient.invalidateQueries({ queryKey: ['agents'] });

      navigate('/');

      toast({
        title: 'Success',
        description: 'Agent updated and restarted successfully',
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update agent',
        variant: 'destructive',
      });
      throw error;
    }
  };

  const handleDelete = async (agent: Agent) => {
    try {
      await apiClient.deleteAgent(agent.id as UUID);
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      navigate('/');
    } catch (error) {
      console.error('Error deleting agent:', error);
    }
  };

  return (
    <CharacterForm
      characterValue={characterValue}
      setCharacterValue={handleCharacterValueChange}
      title="Character Settings"
      description="Configure your AI character's behavior and capabilities"
      onSubmit={handleSubmit}
      onReset={() => reset()}
      onDelete={() => handleDelete(agent)}
      isAgent={true}
      customComponents={[
        {
          name: 'Plugins',
          component: (
            <PluginsPanel
              characterValue={characterValue}
              setCharacterValue={handleCharacterValueChange}
            />
          ),
        },
        {
          name: 'Secret',
          component: (
            <SecretPanel
              characterValue={characterValue}
              setCharacterValue={handleCharacterValueChange}
            />
          ),
        },
        {
          name: 'Avatar',
          component: (
            <AvatarPanel
              characterValue={characterValue}
              setCharacterValue={handleCharacterValueChange}
            />
          ),
        },
      ]}
    />
  );
}
