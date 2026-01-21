"use client";

import { cn } from "@babylon/shared";
import { Bot, Home, Plus, Settings, User } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Bottom navigation component for mobile devices.
 */
function BottomNavContent() {
  const pathname = usePathname();

  const navItems = [
    {
      name: "Home",
      href: "/",
      icon: Home,
      color: "#0066FF",
      active: pathname === "/",
    },
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
      name: "Create",
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
    {
      name: "Profile",
      href: "/profile",
      icon: User,
      color: "#0066FF",
      active: pathname === "/profile",
    },
  ];

  return (
    <nav className="fixed right-0 bottom-0 bottom-nav-rounded left-0 z-50 border-border border-t bg-sidebar md:hidden">
      <div className="safe-area-bottom flex h-14 items-center justify-between px-4">
        <div className="flex flex-1 items-center justify-around">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.name}
                href={item.href}
                className={cn(
                  "flex h-12 w-12 items-center justify-center rounded-lg transition-colors duration-200",
                  "hover:bg-sidebar-accent/50",
                  "relative",
                )}
                aria-label={item.name}
              >
                <Icon
                  className={cn(
                    "h-6 w-6 transition-colors duration-200",
                    item.active
                      ? "text-sidebar-primary"
                      : "text-sidebar-foreground",
                  )}
                  style={{
                    color: item.active ? item.color : undefined,
                  }}
                />
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

/**
 * Bottom navigation for mobile - Polymarket Agent Manager.
 */
export function BottomNav() {
  return <BottomNavContent />;
}
