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
import { type Agent, AgentStatus } from '@elizaos/core';
import { Book, Cog, Plus, TerminalIcon } from 'lucide-react';
import { NavLink, useLocation } from 'react-router';
import ConnectionStatus from './connection-status';
import { useState } from 'react';
import GroupPanel from './group-panel';

export function AppSidebar() {
  const location = useLocation();

  // Add more defensive coding to handle any possible null/undefined responses
  const agentsResult = useAgents();
  const { data, isPending: isAgentsPending } = agentsResult || { data: undefined, isPending: true };
  const [isGroupPanelOpen, setIsGroupPanelOpen] = useState(false);
  // Create a safe data object that can't be null
  const safeData = data || {};
  const safeDataData = (safeData as any).data || {};
  const agents = safeDataData.agents || [];

  const { data: roomsData } = useRooms();

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
          <SidebarGroup>
            <SidebarGroupContent className="px-2">
              <SidebarMenu>
                {isAgentsPending ? (
                  <div>
                    {Array.from({ length: 5 }).map((_, _index) => (
                      <SidebarMenuItem key={`skeleton-item-${_index}`}>
                        <SidebarMenuSkeleton />
                      </SidebarMenuItem>
                    ))}
                  </div>
                ) : (
                  <div>
                    {(() => {
                      return (
                        <>
                          <div className="px-4 py-1 mt-8">
                            <div className="flex items-center space-x-2">
                              <span className="text-sm font-medium text-muted-foreground">
                                Rooms
                              </span>
                            </div>
                          </div>
                          <SidebarMenuItem>
                            <SidebarMenuButton
                              onClick={() => setIsGroupPanelOpen(true)}
                              className="transition-colors px-4 my-4 rounded-md"
                            >
                              <div className="flex items-center gap-2">
                                <div className="w-8 h-8 flex justify-center items-center">
                                  <div className="bg-muted rounded-full w-full h-full">
                                    <div className="text-sm rounded-full h-full w-full flex justify-center items-center overflow-hidden">
                                      <Plus />
                                    </div>
                                  </div>
                                </div>
                                <span className="text-base">{'Add room'}</span>
                              </div>
                            </SidebarMenuButton>
                            {roomsData &&
                              Array.from(roomsData.entries()).map(([roomName, roomArray]) => {
                                // Ensure the array exists and has elements before accessing metadata
                                const thumbnail =
                                  roomArray.length > 0 ? roomArray[0]?.metadata?.thumbnail : null;

                                return (
                                  <SidebarMenuItem key={roomName}>
                                    <NavLink to={`/room/?roomname=${roomName}`}>
                                      <SidebarMenuButton className="transition-colors px-4 my-4 rounded-md">
                                        <div className="flex items-center gap-2">
                                          <div className="w-8 h-8 flex justify-center items-center">
                                            <div className="relative bg-muted rounded-full w-full h-full">
                                              {thumbnail ? (
                                                <img
                                                  src={thumbnail}
                                                  alt={`${roomName} thumbnail`}
                                                  className="rounded-full w-full h-full object-cover"
                                                />
                                              ) : (
                                                <div className="text-sm rounded-full h-full w-full flex justify-center items-center overflow-hidden">
                                                  {formatAgentName(roomName)}
                                                </div>
                                              )}
                                            </div>
                                          </div>
                                          <span className="text-base truncate max-w-24">
                                            {roomName}
                                          </span>
                                        </div>
                                      </SidebarMenuButton>
                                    </NavLink>
                                  </SidebarMenuItem>
                                );
                              })}
                          </SidebarMenuItem>
                        </>
                      );
                    })()}
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
      {isGroupPanelOpen && (
        <GroupPanel agents={agents} onClose={() => setIsGroupPanelOpen(false)} />
      )}
    </>
  );
}
