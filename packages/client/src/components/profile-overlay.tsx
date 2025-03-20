import { useAgentManagement } from '@/hooks/use-agent-management';
import { formatAgentName } from '@/lib/utils';
import type { Agent } from '@elizaos/core';
import { Cog, Loader2, MessageSquare, Play, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';

interface ProfileOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  agent: Agent;
  agents: Agent[];
}

export default function ProfileOverlay({ isOpen, onClose, agent }: ProfileOverlayProps) {
  if (!isOpen) return null;

  const { startAgent, stopAgent, isAgentStarting, isAgentStopping } = useAgentManagement();

  const navigate = useNavigate();

  const isActive = (agent as Agent & { status?: string }).status === 'active';
  const isStarting = isAgentStarting(agent.id);
  const isStopping = isAgentStopping(agent.id);
  const isProcessing = isStarting || isStopping;
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  // handle Start/Stop button
  let buttonLabel = 'Start';
  let buttonIcon = <Play />;
  if (isStarting) {
    buttonLabel = 'Starting...';
    buttonIcon = <Loader2 className="animate-spin" />;
  } else if (isStopping) {
    buttonLabel = 'Stopping...';
    buttonIcon = <Loader2 className="animate-spin" />;
  } else if (isActive) {
    buttonLabel = 'Stop';
    buttonIcon = <Square fill="#EF4444" size={16} />;
  }

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);
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
        {/* Close button - top right */}
        <div className="absolute top-4 right-4 z-10">
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-5 h-5" />
          </Button>
        </div>

        {/* Improved header with gradient background */}
        <div className="p-6 w-full flex items-end bg-gradient-to-b from-primary/20 to-background">
          <div className="flex w-full justify-between items-end">
            <div className="flex flex-col gap-2">
              <div className="w-24 h-24 flex justify-center items-center relative">
                {agent && (
                  <div className="text-4xl bg-muted rounded-full h-full w-full flex justify-center items-center overflow-hidden border-4 border-background">
                    {agent.settings?.avatar ? (
                      <img
                        src={agent.settings.avatar}
                        alt="Agent Avatar"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      formatAgentName(agent.name)
                    )}
                  </div>
                )}
                <div
                  className={`absolute bottom-1 right-1 w-4 h-4 rounded-full border-2 border-background ${
                    isActive ? 'bg-green-500' : 'bg-muted-foreground'
                  }`}
                />
              </div>
              <div className="flex flex-col justify-center mr-4">
                {agent && <div className="text-xl font-bold truncate max-w-48">{agent.name}</div>}
                {agent && (
                  <div className="text-xs text-muted-foreground">
                    ID: {agent.id.substring(0, 8)}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Main content */}
        <CardContent className="p-6 overflow-auto">
          <div className="rounded-md bg-muted p-4 mb-6">
            <p className="font-medium text-sm mb-2">About Me</p>
            {agent && <p className="font-light text-sm text-gray-500">{agent?.system}</p>}
          </div>

          {/* Additional information sections */}
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
              <p className="font-medium text-sm mb-2">Created</p>
              <p className="text-sm text-gray-500">
                {agent?.createdAt
                  ? new Date(agent.createdAt).toLocaleDateString()
                  : new Date().toLocaleDateString()}
              </p>
            </div>

            {/* Plugins Section */}
            <div>
              <p className="font-medium text-sm mb-2">Plugins</p>
              <div className="flex flex-wrap gap-2">
                {agent?.plugins?.length > 0 ? (
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

        {/* Action buttons at the bottom */}
        <div className="p-4 border-t flex justify-between items-center mt-auto">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 flex items-center justify-center"
              onClick={() => {
                setIsDropdownOpen(false);
                navigate(`/settings/${agent.id}`);
              }}
            >
              <Cog className="w-4 h-4" />
            </Button>

            <Button
              variant="outline"
              className={`${isActive ? '' : 'opacity-50'} h-9`}
              onClick={() => {
                if (isActive) {
                  navigate(`/chat/${agent.id}`);
                }
              }}
              disabled={!isActive}
            >
              <MessageSquare className="w-4 h-4 mr-2" />
              Message
            </Button>
          </div>

          <Button
            variant={isActive ? 'destructive' : 'default'}
            onClick={() => {
              if (isProcessing) return;

              if (!isActive) {
                startAgent(agent);
              } else {
                stopAgent(agent);
              }
            }}
            disabled={isProcessing}
          >
            {buttonIcon}
            <span className="ml-2">{buttonLabel}</span>
          </Button>
        </div>
      </Card>
    </div>
  );
}
