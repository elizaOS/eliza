import PageTitle from '@/components/page-title';
import ProfileCard from '@/components/profile-card';
import ProfileOverlay from '@/components/profile-overlay';
import { Card } from '@/components/ui/card';
import { useAgents, useRooms } from '@/hooks/use-query-hooks';
import { formatAgentName } from '@/lib/utils';
import { AgentStatus } from '@elizaos/core';
import type { Agent, UUID } from '@elizaos/core';
import { Tooltip, TooltipContent, TooltipTrigger } from '@radix-ui/react-tooltip';
import { Cog, Info, InfoIcon, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgentManagement } from '../hooks/use-agent-management';
import { AgentsSidebar } from '@/components/agent-sidebar';
import { apiClient } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import GroupPanel from '@/components/group-panel';

export default function Home() {
  const { data: { data: agentsData } = {}, isLoading, isError, error } = useAgents();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Extract agents properly from the response
  const agents = agentsData?.agents || [];

  const { data: roomsData } = useRooms();

  const [isOverlayOpen, setOverlayOpen] = useState(false);
  const [isGroupPanelOpen, setIsGroupPanelOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<UUID | null>(null);
  const { startAgent, isAgentStarting, isAgentStopping } = useAgentManagement();

  const openOverlay = (agent: Agent) => {
    setSelectedAgent(agent);
    setOverlayOpen(true);
  };

  const closeOverlay = () => {
    setSelectedAgent(null);
    setOverlayOpen(false);
  };

  // Sort agents: enabled first, then disabled
  const sortedAgents = [...agents].sort((a, b) => {
    // Sort by status (active agents first)
    if (a.status === AgentStatus.ACTIVE && b.status !== AgentStatus.ACTIVE) return -1;
    if (a.status !== AgentStatus.ACTIVE && b.status === AgentStatus.ACTIVE) return 1;
    // If both have the same status, sort alphabetically by name
    return a.name.localeCompare(b.name);
  });

  // Split into enabled and disabled groups
  const activeAgents = sortedAgents.filter(
    (agent: Partial<Agent & { status: string }>) => agent.status === AgentStatus.ACTIVE
  );
  const inactiveAgents = sortedAgents.filter(
    (agent: Partial<Agent & { status: string }>) => agent.status === AgentStatus.INACTIVE
  );

  return (
    <>
      <div className="flex">
        <div className="flex flex-col gap-4 h-full p-4">
          <div className="flex items-center justify-between">
            <PageTitle title="Agents" />
          </div>

          {isLoading && <div className="text-center py-8">Loading agents...</div>}

          {isError && (
            <div className="text-center py-8 text-destructive">
              Error loading agents: {error instanceof Error ? error.message : 'Unknown error'}
            </div>
          )}

          {agents.length === 0 && !isLoading && (
            <div className="text-center py-8 flex flex-col items-center gap-4">
              <p className="text-muted-foreground">
                No agents currently running. Start a character to begin.
              </p>
            </div>
          )}

          {!isLoading && !isError && (
            <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4 p-3">
              {agents
                ?.sort((a: Agent, b: Agent) => Number(b?.enabled) - Number(a?.enabled))
                .map((agent: Agent) => {
                  return (
                    <ProfileCard
                      key={agent.id}
                      title={
                        <div className="flex gap-2 items-center">
                          <div className="">{agent.name}</div>
                          {agent?.status === AgentStatus.ACTIVE ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="size-2.5 rounded-full bg-green-500 ring-2 ring-green-500/20 animate-pulse mt-[2px]" />
                              </TooltipTrigger>
                              <TooltipContent side="right">
                                <p>Agent is active</p>
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="size-2.5 rounded-full bg-gray-300 ring-2 ring-gray-300/20 mt-[2px]" />
                              </TooltipTrigger>
                              <TooltipContent side="right">
                                <p>Agent is inactive</p>
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      }
                      content={
                        <div
                          className="relative cursor-pointer h-full w-full flex items-center justify-center group"
                          onClick={() => openOverlay(agent)}
                        >
                          <div
                            className={
                              agent.status === AgentStatus.ACTIVE
                                ? 'brightness-[100%] hover:brightness-[107%]'
                                : 'grayscale brightness-[75%] opacity-50 hover:brightness-[85%]'
                            }
                          >
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
                          {agent.status !== AgentStatus.ACTIVE && (
                            <span className="absolute bottom-4 left-1/2 transform -translate-x-1/2 bg-black text-white text-xs px-2 py-1 rounded-md opacity-60">
                              Offline
                            </span>
                          )}
                        </div>
                      }
                      buttons={[
                        agent.status === AgentStatus.ACTIVE
                          ? {
                              label: 'Message',
                              action: () => navigate(`/chat/${agent.id}`),
                              className: `w-[80%]`,
                              variant: 'default',
                            }
                          : {
                              label: isAgentStarting(agent.id)
                                ? 'Starting...'
                                : isAgentStopping(agent.id)
                                  ? 'Stopping...'
                                  : 'Start',
                              action: () => startAgent(agent),
                              className: `w-[80%]`,
                              variant: 'default',
                              disabled: isAgentStarting(agent.id) || isAgentStopping(agent.id),
                            },
                        {
                          icon: <InfoIcon style={{ height: 16, width: 16 }} />,
                          className: 'w-10 h-10 rounded-full',
                          action: () => {
                            openOverlay(agent);
                          },
                          variant: 'outline',
                        },
                        {
                          icon: <Cog style={{ height: 16, width: 16 }} />,
                          className: 'w-10 h-10 rounded-full',
                          action: () => navigate(`/settings/${agent.id}`),
                          variant: 'outline',
                        },
                      ]}
                    />
                  );
                })}
              {/* Create new agent card */}
              <Card
                className="flex flex-col items-center justify-center h-full cursor-pointer hover:bg-accent/50 transition-colors"
                onClick={() => navigate('/create')}
              >
                <div className="flex flex-col items-center justify-center gap-2 p-8">
                  <Plus size={40} className="text-muted-foreground" />
                  <span className="text-muted-foreground whitespace-nowrap">Create New Agent</span>
                </div>
              </Card>
            </div>
          )}
          <div className="flex items-center justify-between">
            <PageTitle title="Rooms" />
          </div>

          {!isLoading && !isError && (
            <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4 p-3">
              {roomsData &&
                Array.from(roomsData.entries()).map(([roomId, roomArray]) => {
                  const thumbnail = roomArray.length > 0 ? roomArray[0]?.metadata?.thumbnail : null;
                  const roomName = roomArray.length > 0 ? roomArray[0]?.name : null;
                  return (
                    <ProfileCard
                      key={roomId}
                      title={
                        <div className="flex gap-2 items-center">
                          <div className="">{roomName}</div>
                        </div>
                      }
                      content={
                        <div
                          className="relative cursor-pointer h-full w-full flex items-center justify-center group"
                          onClick={() => navigate(`/room/${roomId}`)}
                        >
                          <div className="brightness-[100%] hover:brightness-[107%]">
                            {thumbnail ? (
                              <img
                                src={thumbnail}
                                alt="Agent Avatar"
                                className="w-full h-full object-contain"
                              />
                            ) : (
                              formatAgentName(roomName)
                            )}
                          </div>
                        </div>
                      }
                      buttons={[
                        {
                          label: 'Chat',
                          action: () => {
                            navigate(`/room/${roomId}`);
                          },
                          className: `w-[80%]`,
                          variant: 'default',
                        },
                        {
                          icon: <Cog style={{ height: 16, width: 16 }} />,
                          className: 'w-10 h-10 rounded-full',
                          action: () => {
                            setIsGroupPanelOpen(true);
                            setSelectedGroupId(roomId);
                          },
                          variant: 'outline',
                        },
                      ]}
                    />
                  );
                })}
            </div>
          )}
        </div>
        <AgentsSidebar
          onlineAgents={activeAgents}
          offlineAgents={inactiveAgents}
          isLoading={isLoading}
        />
      </div>

      <ProfileOverlay
        isOpen={isOverlayOpen}
        onClose={closeOverlay}
        agent={agents.find((a) => a.id === selectedAgent?.id) || selectedAgent}
        agents={agents}
      />

      {isGroupPanelOpen && (
        <GroupPanel
          agents={agents}
          onClose={() => {
            setSelectedGroupId(null);
            setIsGroupPanelOpen(false);
          }}
          groupId={selectedGroupId}
        />
      )}
    </>
  );
}
