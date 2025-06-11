import { Button } from '@/components/ui/button';
import { useAgentManagement } from '@/hooks/use-agent-management';
import ConfirmationDialog from '@/components/confirmation-dialog';
import { useConfirmation } from '@/hooks/use-confirmation';
import clientLogger from '@/lib/logger';
import type { Agent } from '@elizaos/core';
import { Loader2, Square } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface StopAgentButtonProps {
  agent: Agent;
  variant?: 'default' | 'destructive' | 'outline';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  className?: string;
  showIcon?: boolean;
  redirectToHome?: boolean;
  onStopComplete?: () => void;
}

export default function StopAgentButton({
  agent,
  variant = 'destructive',
  size = 'default',
  className = '',
  showIcon = true,
  redirectToHome = false,
  onStopComplete,
}: StopAgentButtonProps) {
  const { stopAgent, isAgentStopping } = useAgentManagement();
  const navigate = useNavigate();
  const isStoppingAgent = isAgentStopping(agent.id);
  const { confirm, isOpen, onOpenChange, onConfirm, options } = useConfirmation();

  const handleStopAgent = () => {
    confirm(
      {
        title: 'Stop Agent',
        description: `Are you sure you want to stop "${agent.name}"?`,
        confirmText: 'Stop',
        variant: 'destructive',
      },
      async () => {
        try {
          await stopAgent(agent);

          // Call the onStopComplete callback if provided
          if (onStopComplete) {
            onStopComplete();
          }

          // Navigate to homepage if redirectToHome is true
          if (redirectToHome) {
            navigate('/');
          }
        } catch (error) {
          // If error occurs, don't navigate or call callback
          clientLogger.error('Error stopping agent:', error);
        }
      }
    );
  };

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        onClick={handleStopAgent}
        disabled={isStoppingAgent}
      >
        {isStoppingAgent ? (
          <>
            {showIcon && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Stopping...
          </>
        ) : (
          <>
            {showIcon && <Square className="mr-2 h-4 w-4" />}
            Stop
          </>
        )}
      </Button>

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
