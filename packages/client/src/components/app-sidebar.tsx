import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/components/ui/sidebar';
import { useAgents, useRooms } from '@/hooks/use-query-hooks';
import info from '@/lib/info.json';
import { formatAgentName, cn } from '@/lib/utils';
import { AgentStatus, type UUID } from '@elizaos/core';
import type { Agent } from '@elizaos/core';
import { Book, ChevronDown, Cog, Plus, TerminalIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import AgentAvatarStack from './agent-avatar-stack';
import ConnectionStatus from './connection-status';
import GroupPanel from './group-panel';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

export function AppSidebar() {
  const [onlineAgents, setOnlineAgents] = useState<Agent[]>([]);
  const [offlineAgents, setOfflineAgents] = useState<Agent[]>([]);
  const { data: roomsData, isLoading: roomsLoading } = useRooms();
  const {
    data: { data: agentsData } = {},
    isLoading: agentsLoading,
    isError: agentsError,
  } = useAgents();
  const location = useLocation();
  const [isGroupPanelOpen, setIsGroupPanelOpen] = useState(false);
  const [animateCreate, setAnimateCreate] = useState(false);

  // Animation for the create button when the page loads
  useEffect(() => {
    // Set a small delay before showing the animation
    const timeout = setTimeout(() => {
      setAnimateCreate(true);

      // Remove the animation after it's complete
      const removeTimeout = setTimeout(() => {
        setAnimateCreate(false);
      }, 1500);

      return () => clearTimeout(removeTimeout);
    }, 1000);

    return () => clearTimeout(timeout);
  }, []);

  // Display agent loading error if it occurs
  const agentLoadError = agentsError
    ? 'Error loading agents: NetworkError: Unable to connect to the server. Please check if the server is running.'
    : undefined;

  // Extract agents from the response
  const agents = agentsData?.agents || [];

  const isRoomPage = location.pathname.startsWith('/room/');
  const match = location.pathname.match(/^\/room\/([^/]+)$/);
  const roomId = match ? match[1] : null;

  // Create a map of agent avatars for easy lookup
  const agentAvatars: Record<string, string | null> = {};
  for (const agent of agents) {
    if (agent.id && agent.settings?.avatar) {
      agentAvatars[agent.id] = agent.settings.avatar;
    }
  }

  useEffect(() => {
    // Split into online and offline agents
    let onlineAgents = agents.filter(
      (agent: Partial<Agent & { status: string }>) => agent.status === AgentStatus.ACTIVE
    );

    let offlineAgents = agents.filter(
      (agent: Partial<Agent & { status: string }>) => agent.status === AgentStatus.INACTIVE
    );
    if (isRoomPage) {
      if (roomId) {
        onlineAgents = [...onlineAgents].filter((agent) =>
          roomsData?.get(roomId)?.some((room) => room.agentId === agent.id)
        );
        offlineAgents = [...offlineAgents].filter((agent) =>
          roomsData?.get(roomId)?.some((room) => room.agentId === agent.id)
        );
      }
    }

    setOnlineAgents(onlineAgents);
    setOfflineAgents(offlineAgents);
  }, [isRoomPage, agentsData, roomId, roomsData]);

  return (
    <>
      <Sidebar className="bg-background">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild>
                <NavLink to="/" className="px-6 py-2 h-full sidebar-logo">
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
          {/* Create Button with Dropdown */}
          <div className="px-4 py-2 mb-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="default"
                  className={cn(
                    'w-full justify-between items-center relative transition-all bg-primary text-primary-foreground hover:bg-primary/90',
                    'group overflow-hidden',
                    // Animation classes
                    animateCreate && 'animate-bounce-sm',
                    'hover:shadow-md hover:scale-[1.02] transition-all duration-300',
                    'sidebar-create-button'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Plus className="h-4 w-4 group-hover:rotate-90 transition-transform duration-300" />
                    <span>Create</span>
                  </div>
                  <ChevronDown className="h-4 w-4 transition-transform duration-200 group-data-[state=open]:rotate-180" />

                  {/* Spotlight effect on hover */}
                  <div
                    className="absolute inset-0 opacity-0 bg-gradient-to-r from-transparent via-white/20 to-transparent 
                    group-hover:opacity-100 transform -translate-x-full group-hover:translate-x-full transition-all duration-1000 ease-in-out"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-48 z-50 mt-2 bg-popover border-2 border-primary/20 shadow-xl rounded-md animate-in fade-in-50 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2"
              >
                <DropdownMenuItem asChild>
                  <NavLink
                    to="/create"
                    className="flex items-center cursor-pointer px-4 py-3 hover:bg-accent hover:text-accent-foreground rounded-sm font-medium"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    <span>Create Agent</span>
                  </NavLink>
                </DropdownMenuItem>
                <DropdownMenuItem
                  asChild
                  onClick={() => {
                    setIsGroupPanelOpen(true);
                  }}
                  className="flex items-center cursor-pointer px-4 py-3 hover:bg-accent hover:text-accent-foreground rounded-sm font-medium"
                >
                  <div className="flex items-center">
                    <Plus className="h-4 w-4 mr-2" />
                    <span>Create Room</span>
                  </div>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {isGroupPanelOpen && (
            <GroupPanel
              agents={agents}
              onClose={() => {
                setIsGroupPanelOpen(false);
              }}
            />
          )}

          {/* Display agent loading error if present */}
          {agentLoadError && <div className="px-4 py-2 text-xs text-red-500">{agentLoadError}</div>}

          {/* Online header section */}
          <div className="px-4 py-2 text-sm font-medium text-muted-foreground sidebar-online-section">
            Online
          </div>

          {/* Online agents menu */}
          <SidebarMenu>
            {onlineAgents.map((agent) => (
              <SidebarMenuItem key={agent.id}>
                <NavLink to={`/chat/${agent.id}`}>
                  <SidebarMenuButton
                    isActive={location.pathname.includes(agent.id as string)}
                    className="transition-colors px-4 my-4 h-full py-1 rounded-md"
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
          </SidebarMenu>

          {/* Offline header section */}
          {offlineAgents.length > 0 && (
            <>
              <div className="px-4 py-2 text-sm font-medium text-muted-foreground mt-2 sidebar-offline-section">
                Offline
              </div>

              {/* Offline agents menu */}
              <SidebarMenu>
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
              </SidebarMenu>
            </>
          )}

          {/* Groups header section */}
          <div className="px-4 py-2 text-sm font-medium text-muted-foreground mt-2 sidebar-groups-section">
            Groups
          </div>

          {/* Groups Section */}
          <SidebarGroup>
            <SidebarGroupContent className="px-2">
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
                    {roomsData &&
                      Array.from(roomsData.entries()).map(([roomId, roomArray]) => {
                        // Get room name
                        const roomName = roomArray.length > 0 ? roomArray[0]?.name : null;

                        // Get agent IDs for this room
                        const roomAgentIds = roomArray
                          .map((room) => room.agentId)
                          .filter(Boolean) as UUID[];

                        // Get agent names from the agents list using the IDs
                        const roomAgentNames = roomAgentIds.map(
                          (agentId) =>
                            agents.find((agent) => agent.id === agentId)?.name || 'Unknown Agent'
                        );

                        return (
                          <SidebarMenuItem key={roomId} className="h-16">
                            <NavLink to={`/room/${roomId}`}>
                              <SidebarMenuButton className="px-4 py-2 my-2 h-full rounded-md transition-colors">
                                <div className="flex items-center gap-5">
                                  <AgentAvatarStack
                                    agentIds={roomAgentIds}
                                    agentNames={roomAgentNames}
                                    agentAvatars={agentAvatars}
                                    size="md"
                                    showExtraTooltip={true}
                                  />
                                  <div className="flex flex-col justify-center gap-2">
                                    <div className="text-base truncate max-w-24 leading-none">
                                      {roomName}
                                    </div>
                                    <div className="text-xs truncate max-w-24 text-muted-foreground leading-none">
                                      {`${roomAgentIds.length} ${roomAgentIds.length === 1 ? 'Member' : 'Members'}`}
                                    </div>
                                  </div>
                                </div>
                              </SidebarMenuButton>
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
              <NavLink to="/docs">
                <SidebarMenuButton className="sidebar-docs-button">
                  <Book className="h-4 w-4 mr-3" />
                  <span>Documentation</span>
                </SidebarMenuButton>
              </NavLink>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <NavLink to="/logs">
                <SidebarMenuButton className="sidebar-logs-button">
                  <TerminalIcon className="h-4 w-4 mr-3" />
                  <span>Logs</span>
                </SidebarMenuButton>
              </NavLink>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <NavLink to="/settings">
                <SidebarMenuButton className="sidebar-settings-button">
                  <Cog className="h-4 w-4 mr-3" />
                  <span>Settings</span>
                </SidebarMenuButton>
              </NavLink>
            </SidebarMenuItem>
            <ConnectionStatus className="sidebar-connection-status" />
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
    </>
  );
}
