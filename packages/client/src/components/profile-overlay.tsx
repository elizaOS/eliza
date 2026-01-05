import { useAgentManagement } from '@/hooks/use-agent-management';
import { useToast } from '@/hooks/use-toast';
import { exportCharacterAsJson } from '@/lib/export-utils';
import { formatAgentName, moment } from '@/lib/utils';
import type { Agent, UUID } from '@elizaos/core';
import { AgentStatus } from '@elizaos/core';
import { Brain, Loader2, Play, X, Download, Settings } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useElizaAgent } from '../hooks/use-eliza';
import StopAgentButton from './stop-agent-button';
import { Button } from './ui/button';
import { Card, CardContent, CardFooter, CardHeader } from './ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

interface ProfileOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  agentId: UUID;
}

/**
 * Displays a modal overlay with detailed information and controls for a specific agent.
 *
 * Renders an interactive profile card for the agent identified by {@link agentId}, including avatar, status, metadata, capabilities, plugins, and action buttons for starting, stopping, messaging, and navigating to settings. The overlay is visible when {@link isOpen} is true and can be closed via the provided callback.
 *
 * @param isOpen - Whether the overlay is visible.
 * @param onClose - Callback invoked to close the overlay.
 * @param agentId - UUID of the agent whose profile is displayed.
 *
 * @returns The profile overlay component, or null if not open.
 */
export default function ProfileOverlay({ isOpen, onClose, agentId }: ProfileOverlayProps) {
  if (!isOpen) return null;

  const { startAgent, isAgentStarting, isAgentStopping } = useAgentManagement();
  const { toast } = useToast();
  const navigate = useNavigate();

  const { agent } = useElizaAgent(agentId);

  const isActive = agent?.status === AgentStatus.ACTIVE;
  const isStarting = isAgentStarting(agentId);
  const isStopping = isAgentStopping(agentId);
  const isProcessing = isStarting || isStopping;

  // Start button configuration
  const startButtonConfig = {
    label: 'Start',
    icon: <Play className="w-4 h-4" />,
  };

  if (isStarting) {
    startButtonConfig.label = 'Starting...';
    startButtonConfig.icon = <Loader2 className="animate-spin w-4 h-4" />;
  }

  // Handle agent start
  const handleAgentStart = () => {
    if (isProcessing) return;
    startAgent(agent!);
  };

  // Handle character export
  const handleExportCharacter = () => {
    if (!agent) return;

    // Ensure agent has required properties for export
    const agentForExport = {
      ...agent,
      createdAt: agent.createdAt || Date.now(),
      updatedAt: agent.updatedAt || Date.now(),
    } as Agent;

    exportCharacterAsJson(agentForExport, toast);
  };

  return (
    <div
      className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm"
      onClick={onClose}
      onKeyUp={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          onClose();
        }
      }}
    >
      <Card
        className="flex flex-col w-full max-w-md md:max-w-xl overflow-hidden relative"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader className="p-0 space-y-0">
          <div className="absolute top-4 right-4 z-10">
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="w-5 h-5" />
            </Button>
          </div>

          <div className="p-6 w-full flex items-end bg-gradient-to-b from-primary/20 to-background">
            <div className="flex w-full justify-between items-end">
              <div className="flex flex-col gap-2">
                <div className="w-24 h-24 flex justify-center items-center relative">
                  <div className="text-4xl bg-muted rounded-full h-full w-full flex justify-center items-center overflow-hidden border-4 border-background">
                    {typeof agent?.settings?.avatar === 'string' ? (
                      <img
                        src={agent.settings.avatar}
                        alt="Agent Avatar"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      formatAgentName(agent?.name ?? '')
                    )}
                  </div>
                  <div
                    className={`absolute bottom-1 right-1 w-4 h-4 rounded-full border-2 border-background ${
                      isActive ? 'bg-emerald-500' : 'bg-muted-foreground'
                    }`}
                  />
                </div>
                <div className="flex flex-col justify-center mr-4">
                  <div className="text-xl font-bold truncate max-w-48">{agent?.name}</div>
                  <div className="text-xs text-muted-foreground">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className="cursor-pointer hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (agent?.id) {
                              navigator.clipboard.writeText(agent.id);
                            }
                          }}
                          onKeyUp={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.stopPropagation();
                              if (agent?.id) {
                                navigator.clipboard.writeText(agent.id);
                              }
                            }
                          }}
                        >
                          ID: {agent?.id ?? 'N/A'}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        <p>Click to copy agent ID</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-6 overflow-auto">
          <div className="rounded-md bg-muted p-4 mb-6 max-h-60 overflow-y-auto">
            <p className="font-medium text-sm mb-2">About Me</p>
            <p className="font-light text-sm text-gray-500">{agent?.system}</p>
          </div>

          <div className="space-y-6">
            <div>
              <p className="font-medium text-sm mb-2">Status</p>
              <div className="flex items-center">
                <div
                  className={`w-3 h-3 rounded-full mr-2 ${isActive ? 'bg-green-500' : 'bg-gray-400'}`}
                />
                <span className="text-sm">{isActive ? 'Active' : 'Inactive'}</span>
              </div>
            </div>

            <div>
              <p className="font-medium text-sm mb-2">Model</p>
              <div className="flex items-center gap-2">
                <Brain className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm">
                  {typeof agent?.settings?.model === 'string'
                    ? agent.settings.model
                    : agent?.settings?.model !== undefined
                      ? String(agent.settings.model)
                      : 'Default'}
                </span>
              </div>
            </div>

            <div>
              <p className="font-medium text-sm mb-2">Created</p>
              <p className="text-sm text-gray-500">
                {agent?.createdAt ? moment(agent.createdAt).format('LLL') : moment().format('LLL')}
              </p>
            </div>

            <div>
              <p className="font-medium text-sm mb-2">Plugins</p>
              <div className="flex flex-wrap gap-2">
                {agent?.plugins && agent.plugins.length > 0 ? (
                  agent.plugins.map((plugin, index) => {
                    // Extract plugin name by removing the prefix
                    const pluginName = plugin
                      .replace('@elizaos/plugin-', '')
                      .replace('@elizaos-plugins/plugin-', '');
                    return (
                      <span
                        key={index}
                        className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground border border-border"
                      >
                        {pluginName}
                      </span>
                    );
                  })
                ) : (
                  <p className="text-sm text-gray-500">No plugins enabled</p>
                )}
              </div>
            </div>
          </div>
        </CardContent>

        <CardFooter className="flex justify-between items-center p-4 border-t">
          <div className="flex items-center gap-2">
            {isActive ? (
              <StopAgentButton agent={agent} showIcon={true} size="default" className="h-9" />
            ) : (
              <Button
                variant="default"
                onClick={handleAgentStart}
                disabled={isProcessing}
                className="h-9"
              >
                {startButtonConfig.icon}
                <span className="ml-2">{startButtonConfig.label}</span>
              </Button>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  onClick={handleExportCharacter}
                  disabled={!agent}
                  className="h-9"
                  size="sm"
                >
                  Export
                  <Download size={16} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>Export character as JSON</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  onClick={() => navigate(`/settings/${agentId}`)}
                  disabled={!agent}
                  className="h-9"
                  size="sm"
                >
                  <Settings size={16} className="mr-1" />
                  Settings
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>Configure agent settings</p>
              </TooltipContent>
            </Tooltip>
          </div>

          {isActive && (
            <Button variant="default" className="h-9" onClick={() => navigate(`/chat/${agent.id}`)}>
              Message
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
