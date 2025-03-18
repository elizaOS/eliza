import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/components/ui/sidebar';
import { formatAgentName } from '@/lib/utils';
import { type Agent } from '@elizaos/core';
import { NavLink, useLocation } from 'react-router';

export function AgentsSidebar({
  onlineAgents,
  offlineAgents,
  isLoading,
}: {
  onlineAgents: Agent[];
  offlineAgents: Agent[];
  isLoading: boolean;
}) {
  const location = useLocation();

  return (
    <Sidebar className="bg-background" side="right">
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent className="px-2">
            <SidebarMenu>
              {isLoading ? (
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
                        {/* Render active section */}
                        {onlineAgents.length > 0 && (
                          <div className="px-4 py-1">
                            <div className="flex items-center space-x-2">
                              <span className="text-sm font-medium text-muted-foreground">
                                Online
                              </span>
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
                                    <div className="relative bg-muted rounded-full w-full h-full">
                                      {agent && (
                                        <div className="text-sm rounded-full h-full w-full flex justify-center items-center overflow-hidden">
                                          {agent.settings?.avatar ? (
                                            <img
                                              src={agent.settings?.avatar}
                                              alt="Agent Avatar"
                                              className="w-full h-full object-contain"
                                            />
                                          ) : (
                                            formatAgentName(agent.name)
                                          )}
                                          <div
                                            className={`absolute bottom-0 right-0 w-[10px] h-[10px] rounded-full border-[1px] border-white bg-green-500`}
                                          />
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

                        {/* Render inactive section */}
                        {offlineAgents.length > 0 && (
                          <div className="px-4 py-1 mt-8">
                            <div className="flex items-center space-x-2">
                              <span className="text-sm font-medium text-muted-foreground">
                                Offline
                              </span>
                            </div>
                          </div>
                        )}

                        {/* Render disabled agents */}
                        {offlineAgents.map((agent) => (
                          <SidebarMenuItem key={agent.id}>
                            <div className="transition-colors px-4 my-4 rounded-md">
                              <div className="flex items-center gap-2">
                                <div className="w-8 h-8 flex justify-center items-center">
                                  <div className="relative bg-muted rounded-full w-full h-full">
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
                                        <div
                                          className={`absolute bottom-0 right-0 w-[10px] h-[10px] rounded-full border-[1px] border-white bg-muted-foreground`}
                                        />
                                      </div>
                                    )}
                                  </div>
                                </div>
                                <span className="text-base truncate max-w-24">{agent.name}</span>
                              </div>
                            </div>
                          </SidebarMenuItem>
                        ))}
                      </>
                    );
                  })()}
                </div>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
