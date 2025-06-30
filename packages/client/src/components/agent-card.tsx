import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'; // Assuming Card components
import { Button } from '@/components/ui/button';
import { Avatar, AvatarImage } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatAgentName, cn } from '@/lib/utils';
import type { Agent, UUID, Character } from '@elizaos/core';
import { AgentStatus as CoreAgentStatus } from '@elizaos/core';
import { InfoIcon, MessageSquare, Settings, Play, UserX, Loader2, PowerOff } from 'lucide-react'; // Icons for actions
import { useAgentManagement } from '@/hooks/use-agent-management'; // For start/stop logic
import type { AgentWithStatus } from '@/types';
import clientLogger from '@/lib/logger'; // Assuming you have a logger

interface AgentCardProps {
  agent: Partial<AgentWithStatus>; // Use AgentWithStatus from client types
  onChat: (agent: Partial<AgentWithStatus>) => void;
  // onInfo: (agent: Partial<AgentWithStatus>) => void; // If you have an info overlay
  // onSettings: (agentId: UUID) => void; // If navigating to a specific settings page
}

const AgentCard: React.FC<AgentCardProps> = ({ agent, onChat }) => {
  const navigate = useNavigate();
  const { startAgent, stopAgent, isAgentStarting, isAgentStopping } = useAgentManagement();

  if (!agent || !agent.id) {
    clientLogger.error('[AgentCard] Agent data or ID is missing', { agent });
    return (
      <Card className="p-4 min-h-[220px] flex items-center justify-center text-muted-foreground">
        Agent data not available.
      </Card>
    );
  }
  const agentIdForNav = agent.id; // Store for logging
  const agentName = agent.name || 'Unnamed Agent';
  const avatarUrl = agent.settings?.avatar;
  const isActive = agent.status === CoreAgentStatus.ACTIVE;
  const isStarting = isAgentStarting(agent.id);
  const isStopping = isAgentStopping(agent.id);

  const agentForMutation: Agent = {
    id: agent.id!,
    name: agentName,
    username: agent.username || agentName,
    bio: agent.bio || '',
    messageExamples: agent.messageExamples || [],
    postExamples: agent.postExamples || [],
    topics: agent.topics || [],
    adjectives: agent.adjectives || [],
    knowledge: agent.knowledge || [],
    plugins: agent.plugins || [],
    settings: agent.settings || {},
    secrets: agent.secrets || {},
    style: agent.style || {},
    system: agent.system || undefined,
    templates: agent.templates || {},
    enabled: typeof agent.enabled === 'boolean' ? agent.enabled : true,
    status: agent.status || CoreAgentStatus.INACTIVE,
    createdAt: typeof agent.createdAt === 'number' ? agent.createdAt : Date.now(),
    updatedAt: typeof agent.updatedAt === 'number' ? agent.updatedAt : Date.now(),
  };

  const handleStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    startAgent(agentForMutation);
  };

  const handleStop = (e: React.MouseEvent) => {
    e.stopPropagation();
    stopAgent(agentForMutation);
  };

  const handleCardClick = (e: React.MouseEvent) => {
    clientLogger.info('[AgentCard] handleCardClick triggered', {
      agentId: agentIdForNav,
      currentStatus: agent.status,
      isActive,
    });
    if (!isActive) {
      clientLogger.info(`[AgentCard] Agent is not active. Navigating to /chat/${agentIdForNav}`);
      navigate(`/chat/${agentIdForNav}`);
    } else {
      clientLogger.info(
        '[AgentCard] Agent is active. Click intended for chat button or other actions.'
      );
      handleChatClick(e);
    }
  };

  const handleChatClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChat(agent);
  };

  return (
    <Card
      className={cn(
        'w-full aspect-square flex flex-col transition-all hover:shadow-xl cursor-pointer relative',
        isActive ? '' : 'opacity-75 hover:opacity-100'
      )}
      onClick={handleCardClick}
      data-testid="agent-card"
    >
      <CardContent className="flex-grow flex items-center justify-center p-0 overflow-hidden">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={agentName}
            className={cn(
              'w-full aspect-square object-cover rounded-lg',
              isActive ? '' : 'grayscale'
            )}
          />
        ) : (
          <div className="w-full h-full flex items-center rounded-lg justify-center bg-secondary text-2xl font-semibold text-muted-foreground">
            {formatAgentName(agentName)}
          </div>
        )}
        <div className="absolute bottom-4 right-4">
          {isActive ? (
            <Button
              onClick={handleChatClick}
              className=""
              variant="default"
              size="sm"
              disabled={isStopping || isStarting} /* Also disable if starting */
            >
              <MessageSquare className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              onClick={handleStart}
              disabled={isStarting || isStopping}
              className=""
              variant="outline"
              size="sm"
            >
              {isStarting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {isStarting ? 'Starting...' : 'Start'}
            </Button>
          )}
        </div>
      </CardContent>
      <CardHeader className="flex flex-row items-center gap-3 absolute w-full h-16">
        <Avatar className="h-10 w-10 border">
          <AvatarImage src={avatarUrl} alt={agentName} />
          {/* Fallback can be initials or generic icon */}
        </Avatar>
        <div className="overflow-hidden">
          <CardTitle
            className="text-lg truncate overflow-hidden whitespace-nowrap text-ellipsis"
            title={agentName}
          >
            {agentName}
          </CardTitle>
          <div className="flex items-center gap-1.5 mt-1">
            <div
              className={cn('w-2.5 h-2.5 rounded-full', isActive ? 'bg-green-500' : 'bg-red-500')}
            />
            <p className="text-xs text-muted-foreground">
              {isStarting
                ? 'Starting...'
                : isStopping
                  ? 'Stopping...'
                  : agent.status?.toString() || CoreAgentStatus.INACTIVE}
            </p>
          </div>
        </div>
        {/* Action buttons in header */}
        <div className="flex items-center gap-1 ml-auto">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/settings/${agentIdForNav}`);
                }}
                variant="ghost"
                size="icon"
              >
                <Settings className="h-4 w-4 m-2" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Configure Agent</TooltipContent>
          </Tooltip>
          {isActive && !isStopping && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button onClick={handleStop} variant="ghost" size="icon">
                  <PowerOff className="h-4 w-4 m-2 text-red-500" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Stop Agent</TooltipContent>
            </Tooltip>
          )}
          {isStopping && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
      </CardHeader>
    </Card>
  );
};

export default AgentCard;
