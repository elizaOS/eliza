import { useAgentManagement } from '@/hooks/use-agent-management';
import { formatAgentName } from '@/lib/utils';
import type { Agent } from '@elizaos/core';
import { Cog, Loader2, MessageSquare, MoreHorizontal, Play, Square } from 'lucide-react';
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
      className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <Card
        className="flex flex-col items-center justify-between h-[70vh] w-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 h-[30%] w-full flex items-end">
          <div className="flex w-full h-full justify-between items-end">
            <div className="flex flex-col gap-2">
              <div className="w-20 h-20 flex justify-center items-center relative">
                {agent && (
                  <div className="text-4xl bg-muted rounded-full h-full w-full flex justify-center items-center overflow-hidden">
                    {agent.settings?.avatar ? (
                      <img
                        src={agent.settings.avatar}
                        alt="Agent Avatar"
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      formatAgentName(agent.name)
                    )}
                  </div>
                )}
                <div
                  className={`absolute bottom-1 right-1 w-4 h-4 rounded-full border-2 border-white ${
                    isActive ? 'bg-green-500' : 'bg-muted-foreground'
                  }`}
                />
              </div>
              <div className="flex justify-center items-center mr-4 font-bold">
                {agent && <div className="text-xl truncate max-w-48">{agent.name}</div>}
              </div>
            </div>

            <div className="flex flex-col items-end justify-end h-full">
              <div className="flex gap-1">
                <Button
                  variant={'secondary'}
                  className={`mr-4`}
                  onClick={() => {
                    setIsDropdownOpen(false);
                    navigate(`/settings/${agent.id}`);
                  }}
                >
                  <div>
                    <Cog className="w-4 h-4" />
                  </div>

                  <div>Settings</div>
                </Button>

                <Button
                  variant={'secondary'}
                  className={`mr-4`}
                  onClick={() => {
                    if (isActive) {
                      navigate(`/chat/${agent.id}`);
                    }
                  }}
                  size={'default'}
                  disabled={!isActive}
                >
                  <MessageSquare
                    className={'w-10 h-10 rounded-full'}
                    style={{ height: 14, width: 14 }}
                  />
                  {'Message'}
                </Button>

                <Button
                  variant={'secondary'}
                  className={`mr-4 ${isActive ? 'text-red-500' : ''}`}
                  onClick={() => {
                    if (isProcessing) return; // Prevent action while processing

                    if (!isActive) {
                      startAgent(agent);
                    } else {
                      stopAgent(agent);
                    }
                  }}
                  size={'default'}
                  disabled={isProcessing}
                >
                  {buttonIcon}
                  {buttonLabel}
                </Button>
              </div>
            </div>
          </div>
        </div>
        <CardContent className="p-3 h-[70%] w-full">
          <div className="rounded-md bg-muted h-full w-full mb-3">
            <div className="flex  h-full">
              <div className="p-6 overflow-scroll flex flex-col gap-2">
                <div>
                  <p className="font-light">About Me</p>
                  {agent && <p className="font-light text-sm text-gray-500">{agent?.system}</p>}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
