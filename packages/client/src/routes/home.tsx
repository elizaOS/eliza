import PageTitle from '@/components/page-title';
import ProfileCard from '@/components/profile-card';
import ProfileOverlay from '@/components/profile-overlay';
import { useAgents, useRooms } from '@/hooks/use-query-hooks';
import { formatAgentName } from '@/lib/utils';
import type { Agent, UUID } from '@elizaos/core';
import { AgentStatus } from '@elizaos/core';
import { Tooltip, TooltipContent, TooltipTrigger } from '@radix-ui/react-tooltip';
import { Cog, InfoIcon, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgentManagement } from '../hooks/use-agent-management';

import GroupPanel from '@/components/group-panel';
import { Button } from '../components/ui/button';
import { Separator } from '../components/ui/separator';
export default function Home() {
  const { data: { data: agentsData } = {}, isLoading, isError, error } = useAgents();
  const navigate = useNavigate();

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

  return (
    <>
      <div className="flex-1 p-3 w-full h-full">
        <div className="flex flex-col gap-4 h-full w-full md:max-w-4xl mx-auto">
          <div className="flex items-center justify-between gap-2 p-2">
            <PageTitle title="Agents" />
            <Button
              variant="outline"
              onClick={() => navigate('/create')}
              className="create-agent-button"
            >
              <Plus className="w-4 h-4" />
            </Button>
          </div>
          <Separator />

          {isLoading && <div className="text-center py-8">Loading agents...</div>}

          {isError && (
            <div className="text-center py-8">
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
            <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-2 auto-rows-fr agents-section">
              {agents
                ?.sort((a: Agent, b: Agent) => Number(b?.enabled) - Number(a?.enabled))
                .map((agent: Agent) => {
                  return (
                    <ProfileCard
                      key={agent.id}
                      className="agent-card"
                      title={
                        <div className="flex gap-2 items-center">
                          <div className="truncate max-w-24">{agent.name}</div>
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
                          onKeyUp={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              openOverlay(agent);
                            }
                          }}
                        >
                          <div
                            className={`
                              w-full h-full flex items-center justify-center
                              ${
                                agent.status === AgentStatus.ACTIVE
                                  ? 'brightness-[100%] hover:brightness-[107%]'
                                  : 'grayscale }brightness-[75%] opacity-50 hover:brightness-[85%]'
                              }
                            `}
                          >
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
                              className: 'w-[80%] message-button',
                              variant: 'default',
                            }
                          : {
                              label: isAgentStarting(agent.id)
                                ? 'Starting...'
                                : isAgentStopping(agent.id)
                                  ? 'Stopping...'
                                  : 'Start',
                              action: () => startAgent(agent),
                              className: 'w-[80%] start-button',
                              variant: 'default',
                              disabled: isAgentStarting(agent.id) || isAgentStopping(agent.id),
                            },
                        {
                          icon: <InfoIcon style={{ height: 16, width: 16 }} />,
                          className: 'w-10 h-10 rounded-full agent-info-button',
                          action: () => {
                            openOverlay(agent);
                          },
                          variant: 'outline',
                        },
                        {
                          icon: <Cog style={{ height: 16, width: 16 }} />,
                          className: 'w-10 h-10 rounded-full agent-settings-button',
                          action: () => navigate(`/settings/${agent.id}`),
                          variant: 'outline',
                        },
                      ]}
                    />
                  );
                })}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 p-2">
            <PageTitle title="Groups" />
            <Button
              variant="outline"
              onClick={() => setIsGroupPanelOpen(true)}
              className="groups-create-button"
            >
              <Plus className="w-2 h-2" />
            </Button>
          </div>
          <Separator />

          {!isLoading && !isError && (
            <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-2 auto-rows-fr groups-section">
              {roomsData &&
                Array.from(roomsData.entries()).map(([roomId, roomArray]) => {
                  const roomName = roomArray.length > 0 ? roomArray[0]?.name : null;
                  return (
                    <ProfileCard
                      key={roomId}
                      title={
                        <div className="flex gap-2 items-center">
                          <div className="truncate max-w-24">{roomName}</div>
                        </div>
                      }
                      content={
                        <div
                          className="relative cursor-pointer h-full w-full flex items-center justify-center group"
                          onClick={() => navigate(`/room/${roomId}`)}
                          onKeyUp={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              navigate(`/room/${roomId}`);
                            }
                          }}
                        >
                          <div className="w-full h-full flex items-center justify-center brightness-[100%] hover:brightness-[107%]">
                            {formatAgentName(roomName ?? '')}
                          </div>
                        </div>
                      }
                      buttons={[
                        {
                          label: 'Chat',
                          action: () => {
                            navigate(`/room/${roomId}`);
                          },
                          className: 'w-[80%]',
                          variant: 'default',
                        },
                        {
                          icon: <Cog style={{ height: 16, width: 16 }} />,
                          className: 'w-10 h-10 rounded-full',
                          action: () => {
                            setSelectedGroupId(roomId as UUID);
                            setIsGroupPanelOpen(true);
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
      </div>

      <ProfileOverlay
        isOpen={isOverlayOpen}
        onClose={closeOverlay}
        agent={
          agents.find((a) => a.id === selectedAgent?.id) ||
          (selectedAgent as Agent) ||
          agents[0] ||
          ({} as Agent)
        }
        agents={agents}
      />

      {isGroupPanelOpen && (
        <GroupPanel
          agents={agents}
          onClose={() => {
            setSelectedGroupId(null);
            setIsGroupPanelOpen(false);
          }}
          groupId={selectedGroupId ?? undefined}
        />
      )}
    </>
  );
}
