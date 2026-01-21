"use client";

import { cn } from "@babylon/shared";
import { Bot, LogOut, Plus, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { LoginButton } from "@/components/auth/LoginButton";
import { UserMenu } from "@/components/auth/UserMenu";
import { Avatar } from "@/components/shared/Avatar";
import { Separator } from "@/components/shared/Separator";
import { useAuth } from "@/hooks/useAuth";
import { useOwnedAgents } from "@/hooks/useOwnedAgents";

/**
 * Sidebar content component with navigation for Polymarket Agent Manager.
 */
function SidebarContent() {
  const [showMdMenu, setShowMdMenu] = useState(false);
  const mdMenuRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const { ready, authenticated, user, logout } = useAuth();
  const { agents } = useOwnedAgents();

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        mdMenuRef.current &&
        !mdMenuRef.current.contains(event.target as Node)
      ) {
        setShowMdMenu(false);
      }
    };

    if (showMdMenu) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
    return undefined;
  }, [showMdMenu]);

  const navItems = [
    {
      name: "Agents",
      href: "/agents",
      icon: Bot,
      color: "#0066FF",
      active:
        pathname === "/agents" ||
        (pathname.startsWith("/agents/") && !pathname.includes("/create")),
    },
    {
      name: "Create Agent",
      href: "/agents/create",
      icon: Plus,
      color: "#22c55e",
      active: pathname === "/agents/create",
    },
    {
      name: "Settings",
      href: "/settings",
      icon: Settings,
      color: "#0066FF",
      active: pathname === "/settings",
    },
  ];

  const agentList = Array.from(agents.values());

  const statusLabel = (status: string) => {
    switch (status) {
      case "active":
        return "Active";
      case "paused":
        return "Paused";
      case "error":
        return "Error";
      default:
        return "Idle";
    }
  };

  const statusDotClass = (status: string) => {
    switch (status) {
      case "active":
        return "bg-green-500";
      case "paused":
        return "bg-yellow-500";
      case "error":
        return "bg-red-500";
      default:
        return "bg-gray-400";
    }
  };

  return (
    <aside
      className={cn(
        "sticky top-0 isolate z-40 hidden h-screen md:flex md:flex-col",
        "bg-sidebar",
        "transition-all duration-300",
        "md:w-20 lg:w-64",
      )}
    >
      {/* Header - Logo */}
      <div className="flex items-center justify-center p-6 lg:justify-start">
        <Link
          href="/"
          className="transition-transform duration-300 hover:scale-105"
        >
          <div className="flex items-center gap-2">
            <Bot className="h-8 w-8 text-primary" />
            <span className="hidden font-bold text-lg lg:block">Polyagent</span>
          </div>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="pointer-events-auto relative z-20 flex-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.name}
              href={item.href}
              prefetch={true}
              className={cn(
                "group pointer-events-auto relative z-10 flex items-center px-4 py-3",
                "transition-colors duration-200",
                "md:justify-center lg:justify-start",
                !item.active && "bg-transparent hover:bg-sidebar-accent",
              )}
              title={item.name}
              style={{
                backgroundColor: item.active ? item.color : undefined,
              }}
              onMouseEnter={(e) => {
                if (!item.active) {
                  e.currentTarget.style.backgroundColor = item.color;
                }
              }}
              onMouseLeave={(e) => {
                if (!item.active) {
                  e.currentTarget.style.backgroundColor = "";
                }
              }}
            >
              <div className="relative lg:mr-3">
                <Icon
                  className={cn(
                    "h-6 w-6 flex-shrink-0",
                    "transition-all duration-300",
                    "group-hover:scale-110",
                    !item.active && "text-sidebar-foreground",
                  )}
                  style={{
                    color: item.active ? "#e4e4e4" : undefined,
                  }}
                  onMouseEnter={(e) => {
                    if (!item.active) {
                      e.currentTarget.style.color = "#e4e4e4";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!item.active) {
                      e.currentTarget.style.color = "";
                    }
                  }}
                />
              </div>

              <span
                className={cn(
                  "hidden lg:block",
                  "text-lg transition-colors duration-300",
                  item.active ? "font-semibold" : "text-sidebar-foreground",
                )}
                style={{
                  color: item.active ? "#e4e4e4" : undefined,
                }}
                onMouseEnter={(e) => {
                  if (!item.active) {
                    e.currentTarget.style.color = "#e4e4e4";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!item.active) {
                    e.currentTarget.style.color = "";
                  }
                }}
              >
                {item.name}
              </span>
            </Link>
          );
        })}

        {authenticated && agentList.length > 0 && (
          <div className="mt-4 hidden px-4 lg:block">
            <p className="mb-2 font-semibold text-muted-foreground text-xs uppercase">
              Agents
            </p>
            <div className="space-y-1">
              {agentList.map((agent) => (
                <Link
                  key={agent.id}
                  href={`/agents/${agent.id}`}
                  className={cn(
                    "flex items-center justify-between rounded-md px-2 py-1 text-sm",
                    "text-sidebar-foreground transition-colors",
                    "hover:bg-sidebar-accent",
                  )}
                >
                  <span className="truncate">{agent.name}</span>
                  <span className="flex items-center gap-1 text-muted-foreground text-xs">
                    <span
                      className={cn(
                        "inline-flex h-2 w-2 rounded-full",
                        statusDotClass(agent.status),
                      )}
                      aria-hidden
                    />
                    {statusLabel(agent.status)}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </nav>

      {/* Separator */}
      <div className="hidden px-4 py-2 lg:block">
        <Separator />
      </div>

      {/* Bottom Section - Authentication (Desktop lg+) */}
      <div className="hidden p-4 lg:block">
        {!ready ? (
          <div className="flex animate-pulse items-center gap-3 p-3">
            <div className="h-10 w-10 rounded-full bg-sidebar-accent/50" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-4 w-24 rounded bg-sidebar-accent/50" />
              <div className="h-3 w-16 rounded bg-sidebar-accent/30" />
            </div>
          </div>
        ) : authenticated ? (
          <UserMenu />
        ) : (
          <LoginButton />
        )}
      </div>

      {/* Bottom Section - User Icon (Tablet md) */}
      {authenticated && user && (
        <div className="relative md:block lg:hidden" ref={mdMenuRef}>
          <div className="flex justify-center p-4">
            <button
              onClick={() => setShowMdMenu(!showMdMenu)}
              className="transition-opacity hover:opacity-80"
              aria-label="Open user menu"
            >
              <Avatar
                id={user.id}
                name={user.displayName || user.email || "User"}
                type="user"
                size="md"
                src={user.profileImageUrl || undefined}
                imageUrl={user.profileImageUrl || undefined}
              />
            </button>
          </div>

          {/* Dropdown Menu */}
          {showMdMenu && (
            <div className="absolute bottom-full left-1/2 z-50 mb-2 w-auto -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-sidebar shadow-lg">
              <button
                onClick={() => {
                  setShowMdMenu(false);
                  logout();
                }}
                className="flex w-full items-center justify-center p-3 text-destructive transition-colors hover:bg-destructive/10"
                title="Logout"
                aria-label="Logout"
              >
                <LogOut className="h-5 w-5 flex-shrink-0" />
              </button>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

/**
 * Sidebar component for Polymarket Agent Manager.
 */
export function Sidebar() {
  return <SidebarContent />;
}
