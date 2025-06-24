import CharacterForm from '@/components/character-form';
import { useAgentUpdate } from '@/hooks/use-agent-update';
import { useAgentManagement } from '@/hooks/use-agent-management';
import ConfirmationDialog from '@/components/confirmation-dialog';
import { useConfirmation } from '@/hooks/use-confirmation';
import { useToast } from '@/hooks/use-toast';
import { createHybridClient } from '@/lib/migration-utils';
import type { Agent, UUID } from '@elizaos/core';
import { AgentStatus } from '@elizaos/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import AvatarPanel from './avatar-panel';
import PluginsPanel from './plugins-panel';
import { SecretPanel, type SecretPanelRef } from './secret-panel';

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
  const [isDeleting, setIsDeleting] = useState(false);
  const { confirm, isOpen, onOpenChange, onConfirm, options } = useConfirmation();
  const isActive = agent?.status === AgentStatus.ACTIVE;
  const secretPanelRef = useRef<SecretPanelRef>(null);
  const [currentSecrets, setCurrentSecrets] = useState<Record<string, string | null>>({});

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
        const hybridApiClient = createHybridClient();
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

            await hybridApiClient.updateAgent(agentId, forceUpdate as Partial<Agent>);

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
        await hybridApiClient.updateAgent(agentId, partialUpdate as Agent);

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
    if (isDeleting) return; // Prevent multiple clicks

    confirm(
      {
        title: 'Delete Agent',
        description: `Are you sure you want to delete the agent "${agent.name}"? This action cannot be undone.`,
        confirmText: 'Delete',
        variant: 'destructive',
      },
      confirmDelete
    );
  };

  const confirmDelete = async () => {
    try {
      // Set deleting state
      setIsDeleting(true);

      // Show a toast to indicate deletion is in progress
      toast({
        title: 'Deleting...',
        description: `Deleting agent "${agent.name}"`,
      });

      let responseReceived = false;
      let navigationTimer = null;

      try {
        // Set a timeout to navigate away if the deletion takes too long
        navigationTimer = setTimeout(() => {
          if (!responseReceived) {
            queryClient.invalidateQueries({ queryKey: ['agents'] });
            navigate('/');
            toast({
              title: 'Note',
              description: 'Deletion is still processing in the background.',
            });
          }
        }, 8000);

        const hybridApiClient = createHybridClient();
        const response = await hybridApiClient.deleteAgent(agentId);
        responseReceived = true;

        if (navigationTimer) {
          clearTimeout(navigationTimer);
          navigationTimer = null;
        }

        // Handle partial success response
        if (response && 'partial' in response && response.partial === true) {
          toast({
            title: 'Processing',
            description: 'Deletion is still in progress and will complete in the background.',
          });
        } else {
          toast({
            title: 'Success',
            description: 'Agent deleted successfully',
          });
        }

        // Invalidate queries and navigate away regardless
        queryClient.invalidateQueries({ queryKey: ['agents'] });
        navigate('/');
      } catch (deleteError) {
        responseReceived = true;

        if (navigationTimer) {
          clearTimeout(navigationTimer);
          navigationTimer = null;
        }

        // Handle specific error codes
        if (deleteError instanceof Error) {
          const errorMessage = deleteError.message;
          const statusCode = (deleteError as any).statusCode;

          if (
            statusCode === 409 ||
            errorMessage.includes('409') ||
            errorMessage.includes('Conflict') ||
            errorMessage.includes('foreign key constraint') ||
            errorMessage.includes('active references')
          ) {
            // Conflict - agent has references that prevent deletion
            toast({
              title: 'Cannot Delete',
              description:
                'This agent cannot be deleted because it has active references. Try stopping the agent first.',
              variant: 'destructive',
            });
          } else if (
            statusCode === 408 ||
            statusCode === 504 ||
            errorMessage.includes('408') ||
            errorMessage.includes('504') ||
            errorMessage.includes('timeout') ||
            errorMessage.includes('timed out')
          ) {
            // Timeout - operation is still running in background
            toast({
              title: 'Operation Timeout',
              description:
                'The deletion is taking longer than expected and will continue in the background.',
              variant: 'destructive',
            });

            // Still navigate away
            queryClient.invalidateQueries({ queryKey: ['agents'] });
            navigate('/');
          } else {
            // Generic error
            toast({
              title: 'Error',
              description: errorMessage || 'Failed to delete agent',
              variant: 'destructive',
            });
          }
        } else {
          // Unknown error
          toast({
            title: 'Error',
            description: 'An unknown error occurred while deleting the agent',
            variant: 'destructive',
          });
        }
      }
    } catch (error) {
      // Outer try/catch fallback
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete agent',
        variant: 'destructive',
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <>
      <CharacterForm
        characterValue={agentState.agent}
        setCharacterValue={agentState}
        title="Agent Settings"
        description="Configure your AI agent's behavior and capabilities"
        onSubmit={handleSubmit}
        onReset={agentState.reset}
        onDelete={handleDelete}
        onStopAgent={isActive ? handleStopAgent : undefined}
        isAgent={true}
        isDeleting={isDeleting}
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
