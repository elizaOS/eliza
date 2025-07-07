import CharacterForm from '@/components/character-form';
import { useAgentUpdate } from '@/hooks/use-agent-update';
import { useAgentManagement } from '@/hooks/use-agent-management';
import ConfirmationDialog from '@/components/confirmation-dialog';
import { useConfirmation } from '@/hooks/use-confirmation';
import { useToast } from '@/hooks/use-toast';
import { createElizaClient } from '@/lib/api-client-config';
import type { Agent, UUID } from '@elizaos/core';
import { AgentStatus } from '@elizaos/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import AvatarPanel from './avatar-panel';
import PluginsPanel from './plugins-panel';
import { SecretPanel, type SecretPanelRef } from './secret-panel';
import { useDeleteAgent } from '@/hooks/use-delete-agent';

export default function AgentSettings({
  agent,
  agentId,
  onSaveComplete,
}: {
  agent: Agent;
  agentId: UUID;
  onSaveComplete?: () => void;
}) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { confirm, isOpen, onOpenChange, onConfirm, options } = useConfirmation();
  const isActive = agent?.status === AgentStatus.ACTIVE;
  const secretPanelRef = useRef<SecretPanelRef>(null);
  const [currentSecrets, setCurrentSecrets] = useState<Record<string, string | null>>({});

  const { handleDelete: handleDeleteAgent, isDeleting: isDeletingAgent } = useDeleteAgent(agent);

  // Use our enhanced agent update hook for more intelligent handling of JSONb fields
  const agentState = useAgentUpdate(agent);

  // Use agent management hook for stop functionality
  const { stopAgent, isAgentStopping } = useAgentManagement();

  const handleStopAgent = async () => {
    try {
      await stopAgent(agent);
      toast({
        title: 'Success',
        description: 'Agent stopped successfully',
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to stop agent',
        variant: 'destructive',
      });
    }
  };

  const handleSubmit = async () => {
    if (!agentId) {
      toast({
        title: 'Error',
        description: 'Agent ID is missing',
        variant: 'destructive',
      });
      return;
    }

    // Define the actual save logic
    const performSave = async () => {
      try {
        const elizaClient = createElizaClient();
        // Get secrets from state (or ref as fallback)
        const secrets =
          Object.keys(currentSecrets).length > 0
            ? currentSecrets
            : secretPanelRef.current?.getSecrets() || {};

        // Get only the fields that have changed
        const changedFields = agentState.getChangedFields();

        // Manually add secrets to changedFields if they exist
        if (secrets && Object.keys(secrets).length > 0) {
          // Ensure settings object exists in changedFields
          if (!changedFields.settings) {
            changedFields.settings = {};
          }

          const activeSecrets = Object.entries(secrets)
            .filter(([_, value]) => value !== null)
            .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {});

          // Add only active secrets to the settings (exclude deleted ones)
          changedFields.settings.secrets = activeSecrets;
        }

        // No need to send update if nothing changed
        if (Object.keys(changedFields).length === 0) {
          const secrets = agentState.agent?.settings?.secrets;
          // Force include secrets if they exist even if no other changes detected
          if (secrets && Object.keys(secrets).length > 0) {
            const forceUpdate = {
              id: agentId,
              settings: { secrets },
            };

            await elizaClient.agents.updateAgent(agentId, forceUpdate as Partial<Agent>);

            queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
            queryClient.invalidateQueries({ queryKey: ['agents'] });

            toast({
              title: 'Success',
              description: 'Agent secrets updated successfully',
            });

            if (onSaveComplete) {
              onSaveComplete();
            } else {
              navigate('/');
            }
            return;
          }

          toast({
            title: 'No Changes',
            description: 'No changes were made to the agent',
          });

          if (onSaveComplete) {
            onSaveComplete();
          } else {
            navigate('/');
          }
          return;
        }

        // Always include the ID
        const partialUpdate = {
          id: agentId,
          ...changedFields,
        };

        // Send the partial update
        await elizaClient.agents.updateAgent(agentId, partialUpdate as Agent);

        // Invalidate both the agent query and the agents list
        queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
        queryClient.invalidateQueries({ queryKey: ['agents'] });

        toast({
          title: 'Success',
          description: 'Agent updated successfully',
        });

        // Call the onSaveComplete callback if provided, otherwise navigate
        if (onSaveComplete) {
          onSaveComplete();
        } else {
          navigate('/');
        }
      } catch (error) {
        toast({
          title: 'Error',
          description: error instanceof Error ? error.message : 'Failed to update agent',
          variant: 'destructive',
        });
        throw error;
      }
    };

    // Validate required secrets if we have a secret panel ref
    if (secretPanelRef?.current) {
      const secretValidation = secretPanelRef.current.validateSecrets();
      if (!secretValidation.isValid) {
        // Show confirmation dialog for missing secrets
        confirm(
          {
            title: 'Missing Required Secrets',
            description: `The following required secrets are missing: ${secretValidation.missingSecrets.join(', ')}. Do you want to save anyway?`,
            confirmText: 'Save Anyway',
            cancelText: 'Cancel',
            variant: 'destructive',
          },
          performSave
        );
        return; // Exit early - performSave will be called if user confirms
      }
    }

    // If validation passes or no secret panel, proceed with save
    await performSave();
  };

  const handleDelete = () => {
    if (isDeletingAgent) return; // Prevent multiple clicks

    confirm(
      {
        title: 'Delete Agent',
        description: `Are you sure you want to delete the agent "${agent.name}"? This action cannot be undone.`,
        confirmText: 'Delete',
        variant: 'destructive',
      },
      handleDeleteAgent
    );
  };

  return (
    <>
      <CharacterForm
        characterValue={agentState.agent}
        setCharacterValue={agentState}
        title="Agent Settings"
        description="Configure your AI agent's behaviour and capabilities."
        onSubmit={handleSubmit}
        onReset={agentState.reset}
        onDelete={handleDelete}
        onStopAgent={isActive ? handleStopAgent : undefined}
        isAgent={true}
        isDeleting={isDeletingAgent}
        isStopping={isAgentStopping(agentId)}
        customComponents={[
          {
            name: 'Plugins',
            component: (
              <PluginsPanel
                characterValue={agentState.agent}
                setCharacterValue={agentState}
                initialPlugins={agent.plugins}
              />
            ),
          },
          {
            name: 'Secret',
            component: (
              <SecretPanel
                characterValue={agentState.agent}
                ref={secretPanelRef}
                onChange={(secrets) => {
                  setCurrentSecrets(secrets);
                  // Also update the agent state so changes persist across tab switches
                  agentState.updateSettings({ secrets });
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

      {/* Confirmation Dialog */}
      <ConfirmationDialog
        open={isOpen}
        onOpenChange={onOpenChange}
        title={options?.title || ''}
        description={options?.description || ''}
        confirmText={options?.confirmText}
        cancelText={options?.cancelText}
        variant={options?.variant}
        onConfirm={onConfirm}
      />
    </>
  );
}
