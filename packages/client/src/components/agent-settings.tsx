import CharacterForm from '@/components/character-form';
import { useAgentUpdate } from '@/hooks/use-agent-update';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '@/lib/api';
import type { Agent, UUID } from '@elizaos/core';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import AvatarPanel from './avatar-panel';
import PluginsPanel from './plugins-panel';
import { SecretPanel } from './secret-panel';

export default function AgentSettings({ agent, agentId }: { agent: Agent; agentId: UUID }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Use our enhanced agent update hook for more intelligent handling of JSONb fields
  const agentState = useAgentUpdate(agent);

  const handleSubmit = async () => {
    try {
      if (!agentId) {
        throw new Error('Agent ID is missing');
      }

      // Get only the fields that have changed
      const changedFields = agentState.getChangedFields();

      // No need to send update if nothing changed
      if (Object.keys(changedFields).length === 0) {
        toast({
          title: 'No Changes',
          description: 'No changes were made to the agent',
        });
        navigate('/');
        return;
      }

      // Always include the ID
      const partialUpdate = {
        id: agentId,
        ...changedFields,
      };

      // Send the partial update
      await apiClient.updateAgent(agentId, partialUpdate as Agent);

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
                if (updatedAgent.settings?.secrets) {
                  // Create a new settings object with the updated secrets
                  const updatedSettings = {
                    ...agentState.agent.settings,
                    secrets: updatedAgent.settings.secrets,
                  };

                  // Use updateSettings to properly handle the secrets
                  agentState.updateSettings(updatedSettings);
                }
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
