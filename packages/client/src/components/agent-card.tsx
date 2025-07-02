import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { formatAgentName, cn } from '@/lib/utils';
import type { Agent } from '@elizaos/core';
import { AgentStatus as CoreAgentStatus } from '@elizaos/core';
import { MessageSquare, Settings, Loader2, MoreVertical, Pause, Play } from 'lucide-react';
import { useAgentManagement } from '@/hooks/use-agent-management';
import type { AgentWithStatus } from '@/types';
import clientLogger from '@/lib/logger';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';

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
      <Card className="p-4 min-h-[100px] flex items-center justify-center text-muted-foreground">
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

  const handleToggle = () => {
    if (isActive) {
      handleStop();
    } else {
      handleStart();
    }
  };

  return (
    <Card
      className={cn(
        'w-full transition-all hover:shadow-lg hover:bg-muted/30 cursor-pointer bg-card border border-border/50',
        isActive ? '' : 'opacity-75'
      )}
      // onClick={handleNewChat}
      data-testid="agent-card"
    >
      <CardContent className="p-4 relative">
        {/* Toggle Switch - positioned absolutely in top-right */}
        <div className="absolute top-3 right-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 p-0">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="bottom">
              <DropdownMenuItem onClick={handleNewChat}>
                <MessageSquare className="h-4 w-4 mr-2" />
                New Chat
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={isActive ? handleStop : handleStart}
                disabled={isStarting || isStopping}
              >
                {isStarting || isStopping ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : isActive ? (
                  <Pause className="h-4 w-4 mr-2" />
                ) : (
                  <Play className="h-4 w-4 mr-2" />
                )}
                {isStarting || isStopping
                  ? isActive
                    ? 'Stopping...'
                    : 'Starting...'
                  : isActive
                  ? 'Pause Agent'
                  : 'Start Agent'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleSettings}>
                <Settings className="h-4 w-4 mr-2" />
                Settings
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-start gap-4 pr-10">
          {/* Avatar */}
          <Avatar className="h-16 w-16 flex-shrink-0 rounded-xl">
            <AvatarImage src={avatarUrl} alt={agentName} />
            <AvatarFallback className="text-lg font-medium rounded-xl">
              {formatAgentName(agentName)}
            </AvatarFallback>
          </Avatar>

          {/* Content - Name and Description */}
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-xl mb-1 truncate" title={agentName}>
              {agentName}
            </h3>
            <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed">
              {description}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default AgentCard;
