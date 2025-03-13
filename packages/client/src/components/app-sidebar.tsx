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
} from "@/components/ui/sidebar";
import { useAgents } from "@/hooks/use-query-hooks";
import info from "@/lib/info.json";
import type { Agent } from "@elizaos/core";
import { Book, Cog, Scroll, User } from "lucide-react";
import { NavLink, useLocation } from "react-router";
import ConnectionStatus from "./connection-status";
import { AGENT_STATUS } from "@/types/index";
import { formatAgentName } from "@/lib/utils";

export function AppSidebar() {
	const location = useLocation();
	const {
		data: { data: agentsData } = {},
		isPending: isAgentsPending,
	} = useAgents();
	
	return (
		<Sidebar className="bg-background">
			<SidebarHeader className="pb-4">
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton size="lg" asChild>
							<NavLink to="/" className="px-6 py-4">
								<img
									alt="elizaos-icon"
									src="/elizaos-icon.png"
									width="100%"
									height="100%"
									className="size-9"
								/>

								<div className="flex flex-col leading-none ">
									<span className="font-semibold text-lg">ElizaOS</span>
									<span className="text-sm -mt-0.5 text-muted-foreground">
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
					<SidebarGroupLabel className="px-6 py-2 text-sm font-medium text-muted-foreground">
						<NavLink to={"/"}>AGENTS</NavLink>
					</SidebarGroupLabel>
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
										// Sort agents: enabled first, then disabled
										const sortedAgents = [...(agentsData?.agents || [])].sort(
											(a, b) => {
											  // Sort by status (active agents first)
											  if (a.status === AGENT_STATUS.ACTIVE && b.status !== AGENT_STATUS.ACTIVE) return -1;
											  if (a.status !== AGENT_STATUS.ACTIVE && b.status === AGENT_STATUS.ACTIVE) return 1;
											  // If both have the same status, sort alphabetically by name
											  return a.name.localeCompare(b.name);
											}
										  );
										  

										// Split into enabled and disabled groups
										const activeAgents = sortedAgents.filter(
											(agent: Partial<Agent & { status: string }>) =>
												agent.status === AGENT_STATUS.ACTIVE,
										);
										const inactiveAgents = sortedAgents.filter(
											(agent: Partial<Agent & { status: string }>) =>
												agent.status === AGENT_STATUS.INACTIVE,
										);

										return (
											<>
												{/* Render active section */}
												{activeAgents.length > 0 && (
													<div className="px-4 py-1 mt-4">
														<div className="flex items-center space-x-2">
															<div className="size-2.5 rounded-full bg-green-500" />
															<span className="text-sm font-medium text-muted-foreground">
																Online
															</span>
														</div>
													</div>
												)}

												{/* Render enabled agents */}
												{activeAgents.map((agent) => (
													<SidebarMenuItem key={agent.id}>
														<NavLink to={`/chat/${agent.id}`}>
															<SidebarMenuButton
																isActive={location.pathname.includes(
																	agent.id as string,
																)}
																className="transition-colors px-4 my-4 rounded-md"
															>
																<div className="flex items-center gap-2">
																	<div className="w-8 h-8 flex justify-center items-center">
																		<div className="relative bg-muted rounded-full w-full h-full">
																			{agent && <div className="text-sm rounded-full h-full w-full flex justify-center items-center overflow-hidden">
																			{agent.settings?.avatar ?
																				<img src={agent.settings?.avatar} alt="Agent Avatar" className="w-full h-full object-contain" /> :
																				formatAgentName(agent.name)
																			}
																			<div className={`absolute bottom-0 right-0 w-2 h-2 rounded-full border-[1px] border-white bg-green-500`} />
																		</div>}
																		</div>
																	</div>
																	<span className="text-base">
																		{agent.name}
																	</span>
																</div>
															</SidebarMenuButton>
														</NavLink>
													</SidebarMenuItem>
												))}

												{/* Render inactive section */}
												{inactiveAgents.length > 0 && (
													<div className="px-4 py-1 mt-12">
														<div className="flex items-center space-x-2">
															<div className="size-2.5 rounded-full bg-muted-foreground/50" />
															<span className="text-sm font-medium text-muted-foreground">
																Offline
															</span>
														</div>
													</div>
												)}

												{/* Render disabled agents */}
												{inactiveAgents.map((agent) => (
													<SidebarMenuItem key={agent.id}>
														<div
															className="transition-colors px-4 my-4 rounded-md"
														>
															<div className="flex items-center gap-2">
																<div className="w-8 h-8 flex justify-center items-center">
																	<div className="relative bg-muted rounded-full w-full h-full">
																		{agent && <div className="text-sm rounded-full h-full w-full flex justify-center items-center overflow-hidden">
																		{agent.settings?.avatar ?
																			<img src={agent.settings.avatar} alt="Agent Avatar" className="w-full h-full object-contain" /> :
																			formatAgentName(agent.name)
																		}
																		<div className={`absolute bottom-0 right-0 w-2 h-2 rounded-full border-[1px] border-white bg-muted-foreground`} />
																	</div>}
																	</div>
																</div>
																<span className="text-base truncate max-w-24">
																	{agent.name}
																</span>
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
			<SidebarFooter className="px-4 py-4">
				<SidebarMenu>
					<SidebarMenuItem>
						<NavLink
							to="https://elizaos.github.io/eliza/docs/intro/"
							target="_blank"
						>
							<SidebarMenuButton className="text-muted-foreground rounded-md">
								<Book className="size-5" />
								<span>Documentation</span>
							</SidebarMenuButton>
						</NavLink>
					</SidebarMenuItem>
					<SidebarMenuItem>
						<NavLink to="/logs">
							<SidebarMenuButton className="text-muted-foreground rounded-md">
								<Scroll className="size-5" />
								<span>Logs</span>
							</SidebarMenuButton>
						</NavLink>
					</SidebarMenuItem>
					<SidebarMenuItem>
						<SidebarMenuButton
							disabled
							className="text-muted-foreground/50 rounded-md"
						>
							<Cog className="size-5" />
							<span>Settings</span>
						</SidebarMenuButton>
					</SidebarMenuItem>
					<ConnectionStatus />
				</SidebarMenu>
			</SidebarFooter>
		</Sidebar>
	);
}
