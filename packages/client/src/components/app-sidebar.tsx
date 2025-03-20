import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/components/ui/sidebar';
import { useAgents, useRooms } from '@/hooks/use-query-hooks';
import info from '@/lib/info.json';
import { formatAgentName } from '@/lib/utils';
import { AgentStatus, UUID } from '@elizaos/core';
import type { Agent } from '@elizaos/core';
import { Book, Cog, TerminalIcon } from 'lucide-react';
import { NavLink, useLocation } from 'react-router';
import ConnectionStatus from './connection-status';
import AgentAvatarStack from './agent-avatar-stack';

export function AppSidebar() {
  const { data: roomsData, isLoading: roomsLoading } = useRooms();
  const { data: { data: agentsData } = {}, isLoading: agentsLoading } = useAgents();
  const location = useLocation();

  // Extract agents from the response
  const agents = agentsData?.agents || [];

  // Split into online and offline agents
  const onlineAgents = agents.filter(
    (agent: Partial<Agent & { status: string }>) => agent.status === AgentStatus.ACTIVE
  );

  const offlineAgents = agents.filter(
    (agent: Partial<Agent & { status: string }>) => agent.status === AgentStatus.INACTIVE
  );

  // Create a map of agent avatars for easy lookup
  const agentAvatars: Record<string, string | null> = {};
  agents.forEach((agent) => {
    if (agent.id && agent.settings?.avatar) {
      agentAvatars[agent.id] = agent.settings.avatar;
    }
  });

  return (
    <>
      <Sidebar className="bg-background">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild>
                <NavLink to="/" className="px-6 py-2 h-full">
                  <div className="flex flex-col pt-2 gap-1 items-start justify-center">
                    <img alt="elizaos-logo" src="/elizaos-logo-light.png" width="90%" />
                    <span className="text-xs font-mono text-muted-foreground text-center">
                      v{info?.version}
                    </span>
                  </div>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          {/* Agents Section */}
          <SidebarGroup>
            <SidebarGroupContent className="px-2">
              <SidebarMenu>
                {agentsLoading ? (
                  <div>
                    {Array.from({ length: 5 }).map((_, _index) => (
                      <SidebarMenuItem key={`agent-skeleton-item-${_index}`}>
                        <SidebarMenuSkeleton />
                      </SidebarMenuItem>
                    ))}
                  </div>
                ) : (
                  <div>
                    {/* Online Agents */}
                    {onlineAgents.length > 0 && (
                      <div className="px-4 py-1">
                        <div className="flex items-center space-x-2">
                          <span className="text-sm font-medium text-muted-foreground">Online</span>
                        </div>
                      </div>
                    )}

                    {/* Render enabled agents */}
                    {onlineAgents.map((agent) => (
                      <SidebarMenuItem key={agent.id}>
                        <NavLink to={`/chat/${agent.id}`}>
                          <SidebarMenuButton
                            isActive={location.pathname.includes(agent.id as string)}
                            className="transition-colors px-4 my-4 rounded-md"
                          >
                            <div className="flex items-center gap-2">
                              <div className="w-8 h-8 flex justify-center items-center">
                                <div className="relative bg-gray-600 rounded-full w-full h-full">
                                  {agent && (
                                    <div className="text-sm rounded-full h-full w-full flex justify-center items-center overflow-hidden">
                                      {agent.settings?.avatar ? (
                                        <img
                                          src={agent.settings.avatar}
                                          alt="Agent Avatar"
                                          className="w-full h-full object-contain"
                                        />
                                      ) : (
                                        formatAgentName(agent.name)
                                      )}
                                      <div className="absolute bottom-0 right-0 w-[10px] h-[10px] rounded-full border-[1px] border-white bg-green-500" />
                                    </div>
                                  )}
                                </div>
                              </div>
                              <span className="text-base">{agent.name}</span>
                            </div>
                          </SidebarMenuButton>
                        </NavLink>
                      </SidebarMenuItem>
                    ))}

                    {/* Offline Agents */}
                    {offlineAgents.length > 0 && (
                      <div className="px-4 py-1 mt-4">
                        <div className="flex items-center space-x-2">
                          <span className="text-sm font-medium text-muted-foreground">Offline</span>
                        </div>
                      </div>
                    )}

                    {/* Render disabled agents */}
                    {offlineAgents.map((agent) => (
                      <SidebarMenuItem key={agent.id}>
                        <div className="transition-colors px-4 my-4 rounded-md">
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 flex justify-center items-center">
                              <div className="relative bg-gray-600 rounded-full w-full h-full">
                                {agent && (
                                  <div className="text-sm rounded-full h-full w-full flex justify-center items-center overflow-hidden">
                                    {agent.settings?.avatar ? (
                                      <img
                                        src={agent.settings.avatar}
                                        alt="Agent Avatar"
                                        className="w-full h-full object-contain"
                                      />
                                    ) : (
                                      formatAgentName(agent.name)
                                    )}
                                    <div className="absolute bottom-0 right-0 w-[10px] h-[10px] rounded-full border-[1px] border-white bg-muted-foreground" />
                                  </div>
                                )}
                              </div>
                            </div>
                            <span className="text-base truncate max-w-24">{agent.name}</span>
                          </div>
                        </div>
                      </SidebarMenuItem>
                    ))}
                  </div>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {/* Groups Section */}
          <SidebarGroup>
            <SidebarGroupContent className="px-2 mt-4">
              <SidebarMenu>
                {roomsLoading ? (
                  <div>
                    {Array.from({ length: 5 }).map((_, _index) => (
                      <SidebarMenuItem key={`group-skeleton-item-${_index}`}>
                        <SidebarMenuSkeleton />
                      </SidebarMenuItem>
                    ))}
                  </div>
                ) : (
                  <div>
                    <div className="px-4 py-1 mt-2">
                      <div className="flex items-center space-x-2">
                        <span className="text-sm font-medium text-muted-foreground">Groups</span>
                      </div>
                    </div>
                    {roomsData &&
                      Array.from(roomsData.entries()).map(([roomId, roomArray]) => {
                        // Get room name
                        const roomName = roomArray.length > 0 ? roomArray[0]?.name : null;

                        // Get agent IDs for this room
                        const roomAgentIds = roomArray
                          .map((room) => room.agentId)
                          .filter(Boolean) as UUID[];
                        const roomAgentNames = roomArray
                          .map((room) => room.character.name)
                          .filter(Boolean) as string[];

                        console.log(roomArray, roomAgentNames);

                        return (
                          <SidebarMenuItem key={roomId}>
                            <NavLink to={`/room/${roomId}`}>
                              <div className="transition-colors px-4 my-4 rounded-md">
                                <div className="flex items-center gap-3">
                                  <AgentAvatarStack
                                    agentIds={roomAgentIds}
                                    agentNames={roomAgentNames}
                                    agentAvatars={agentAvatars}
                                    size="md"
                                  />
                                  <div className="flex flex-col h-full justify-center">
                                    <div className="text-base truncate max-w-24">{roomName}</div>
                                    <div className="text-xs truncate max-w-24">{`${roomAgentIds.length} Members`}</div>
                                  </div>
                                </div>
                              </div>
                            </NavLink>
                          </SidebarMenuItem>
                        );
                      })}
                  </div>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="px-4 py-4">
          <SidebarMenu>
            <SidebarMenuItem>
              <NavLink to="https://elizaos.github.io/eliza/docs/intro/" target="_blank">
                <SidebarMenuButton className="text-muted-foreground rounded-md">
                  <Book className="size-5" />
                  <span>Documentation</span>
                </SidebarMenuButton>
              </NavLink>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <NavLink to="/logs">
                <SidebarMenuButton className="text-muted-foreground rounded-md">
                  <TerminalIcon className="size-5" />
                  <span>Logs</span>
                </SidebarMenuButton>
              </NavLink>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton disabled className="text-muted-foreground/50 rounded-md">
                <Cog className="size-5" />
                <span>Settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <ConnectionStatus />
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
    </>
  );
}
