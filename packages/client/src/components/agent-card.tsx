import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatAgentName, cn } from '@/lib/utils';
import type { Agent } from '@elizaos/core';
import { AgentStatus as CoreAgentStatus } from '@elizaos/core';
import { MoreHorizontal, MessageSquare, Settings, Pause, Play, Loader2 } from 'lucide-react';
import { useAgentManagement } from '@/hooks/use-agent-management';
import type { AgentWithStatus } from '@/types';
import clientLogger from '@/lib/logger';

interface AgentCardProps {
  agent: Partial<AgentWithStatus>;
  onChat: (agent: Partial<AgentWithStatus>) => void;
}

const AgentCard: React.FC<AgentCardProps> = ({ agent, onChat }) => {
  const navigate = useNavigate();
  const { startAgent, stopAgent, isAgentStarting, isAgentStopping } = useAgentManagement();

  if (!agent || !agent.id) {
    clientLogger.error('[AgentCard] Agent data or ID is missing', { agent });
    return (
      <Card className="p-4 min-h-[80px] flex items-center justify-center text-muted-foreground">
        Agent data not available.
      </Card>
    );
  }

  const agentIdForNav = agent.id;
  const agentName = agent.name || 'Unnamed Agent';
  const avatarUrl = typeof agent.settings?.avatar === 'string' ? agent.settings.avatar : undefined;
  const description =
    (typeof agent.bio === 'string' && agent.bio.trim()) ||
    'Engages with all types of questions and conversations';
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

  const handleStart = () => {
    startAgent(agentForMutation);
  };

  const handleStop = () => {
    stopAgent(agentForMutation);
  };

  const handleNewChat = () => {
    onChat(agent);
  };

  const handleSettings = () => {
    navigate(`/settings/${agentIdForNav}`);
  };

  const handlePauseAgent = () => {
    if (isActive) {
      handleStop();
    } else {
      handleStart();
    }
  };

  const getStatusText = () => {
    if (isStarting) return 'Starting...';
    if (isStopping) return 'Stopping...';
    return isActive ? 'Active' : 'Inactive';
  };

  const getStatusColor = () => {
    if (isStarting || isStopping) return 'bg-yellow-500';
    return isActive ? 'bg-green-500' : 'bg-red-500';
  };

  return (
    <Card
      className={cn(
        'w-full transition-all hover:shadow-lg cursor-pointer bg-card',
        isActive ? '' : 'opacity-75 hover:opacity-100'
      )}
      onClick={handleNewChat}
      data-testid="agent-card"
    >
      <CardContent className="p-4 relative">
        {/* Menu positioned absolutely in top-right */}
        <div className="absolute top-2 right-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 hover:bg-muted"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  handleNewChat();
                }}
              >
                <MessageSquare className="mr-2 h-4 w-4" />
                New Chat
              </DropdownMenuItem>

              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  handlePauseAgent();
                }}
                disabled={isStarting || isStopping}
              >
                {isStarting || isStopping ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : isActive ? (
                  <Pause className="mr-2 h-4 w-4" />
                ) : (
                  <Play className="mr-2 h-4 w-4" />
                )}
                {isStarting
                  ? 'Starting...'
                  : isStopping
                    ? 'Stopping...'
                    : isActive
                      ? 'Pause Agent'
                      : 'Start Agent'}
              </DropdownMenuItem>

              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  handleSettings();
                }}
              >
                <Settings className="mr-2 h-4 w-4" />
                Settings
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-start gap-3 pr-8">
          {/* Avatar */}
          <Avatar className="h-12 w-12 flex-shrink-0 rounded-lg">
            <AvatarImage src={avatarUrl} alt={agentName} />
            <AvatarFallback className="text-sm font-medium">
              {formatAgentName(agentName)}
            </AvatarFallback>
          </Avatar>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Name and Status */}
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-semibold text-base truncate" title={agentName}>
                {agentName}
              </h3>
              <div className="flex items-center gap-1.5">
                <div className={cn('w-2 h-2 rounded-full', getStatusColor())} />
                <span
                  className={cn(
                    'text-sm font-medium',
                    isActive
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-red-600 dark:text-red-400'
                  )}
                >
                  {getStatusText()}
                </span>
              </div>
            </div>

            {/* Description - Reserve space for 2 lines */}
            <div className="h-10 flex items-start">
              <p
                className="text-sm text-muted-foreground leading-5 overflow-hidden"
                style={{
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                }}
                title={description}
              >
                {description}
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default AgentCard;
