import CharacterForm from '@/components/character-form';
import { useToast } from '@/hooks/use-toast';
import { useAgentUpdate } from '@/hooks/use-agent-update';
import { apiClient } from '@/lib/api';
import type { Agent, UUID } from '@elizaos/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import AvatarPanel from './avatar-panel';
import PluginsPanel from './plugins-panel';
import { SecretPanel } from './secret-panel';

export default function AgentSettings({ agent, agentId }: { agent: Agent; agentId: UUID }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  console.log('[AgentSettings] Initializing with agent:', agent);

  // Use our enhanced agent update hook for more intelligent handling of JSONb fields
  const agentState = useAgentUpdate(agent);

  // Log whenever agent state changes
  useEffect(() => {
    console.log('[AgentSettings] Agent state updated:', agentState.agent);
    console.log('[AgentSettings] Settings.secrets:', agentState.agent.settings?.secrets);
  }, [agentState.agent]);

  const handleSubmit = async (updatedAgent: Agent) => {
    try {
      if (!agentId) {
        throw new Error('Agent ID is missing');
      }

      console.log('[AgentSettings] Submitting agent update:', updatedAgent);
      console.log('[AgentSettings] Settings being submitted:', updatedAgent.settings);
      console.log('[AgentSettings] Secrets being submitted:', updatedAgent.settings?.secrets);

      // Make sure we're properly handling all JSONb fields
      const mergedAgent = {
        ...updatedAgent,
        // Explicitly ensure all these fields are properly included
        id: agentId,
        bio: updatedAgent.bio || [],
        topics: updatedAgent.topics || [],
        adjectives: updatedAgent.adjectives || [],
        plugins: updatedAgent.plugins || [],
        style: updatedAgent.style || { all: [], chat: [], post: [] },
        settings: updatedAgent.settings || { secrets: {} },
      };

      console.log('[AgentSettings] Final merged agent being sent to API:', mergedAgent);
      console.log('[AgentSettings] Final secrets being sent:', mergedAgent.settings?.secrets);

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
      console.error('[AgentSettings] Error updating agent:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update agent',
        variant: 'destructive',
      });
      throw error;
    }
  };

  const handleDelete = async () => {
    try {
      await apiClient.deleteAgent(agentId);
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      navigate('/');

      toast({
        title: 'Success',
        description: 'Agent deleted successfully',
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete agent',
        variant: 'destructive',
      });
    }
  };

  return (
    <CharacterForm
      characterValue={agentState.agent}
      setCharacterValue={agentState}
      title="Character Settings"
      description="Configure your AI character's behavior and capabilities"
      onSubmit={handleSubmit}
      onReset={agentState.reset}
      onDelete={handleDelete}
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
                console.log('[agent-settings] SecretPanel onChange called with:', updatedAgent);
                agentState.updateObject(updatedAgent);
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
