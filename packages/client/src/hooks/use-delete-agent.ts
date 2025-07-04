import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from './use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { createElizaClient } from '@/lib/api-client-config';
import type { Agent } from '@elizaos/core';

export function useDeleteAgent(targetAgentData: Agent) {
  const [isDeleting, setIsDeleting] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const handleDelete = useCallback(async () => {
    setIsDeleting(true);
    toast({
      title: 'Deleting...',
      description: `Deleting agent "${targetAgentData.name}"`,
    });

    let responseReceived = false;
    let navigationTimer = null;

    try {
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

      const elizaClient = createElizaClient();
      const response = await elizaClient.agents.deleteAgent(targetAgentData.id);
      responseReceived = true;

      clearTimeout(navigationTimer);

      if (response?.partial) {
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

      queryClient.invalidateQueries({ queryKey: ['agents'] });
      navigate('/');
    } catch (deleteError) {
      responseReceived = true;
      clearTimeout(navigationTimer);

      const errorMessage = deleteError?.message ?? 'Failed to delete agent';
      const statusCode = deleteError?.statusCode;

      if (
        statusCode === 409 ||
        errorMessage.includes('409') ||
        errorMessage.includes('Conflict') ||
        errorMessage.includes('foreign key constraint') ||
        errorMessage.includes('active references')
      ) {
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
        toast({
          title: 'Operation Timeout',
          description:
            'The deletion is taking longer than expected and will continue in the background.',
          variant: 'destructive',
        });

        queryClient.invalidateQueries({ queryKey: ['agents'] });
        navigate('/');
      } else {
        toast({
          title: 'Error',
          description: errorMessage,
          variant: 'destructive',
        });
      }
    } finally {
      setIsDeleting(false);
    }
  }, [targetAgentData, toast, navigate, queryClient]);

  return {
    handleDelete,
    isDeleting,
  };
}
