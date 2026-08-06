"use client";

import {
  Settings,
  Cpu,
  Zap,
  Key,
  Send,
  Shield,
  Server,
  Keyboard,
  Database,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type SettingsSection =
  | "general"
  | "model"
  | "provider"
  | "api"
  | "telegram"
  | "permissions"
  | "mcp"
  | "keyboard"
  | "data";

interface NavItem {
  id: SettingsSection;
  label: string;
  icon: React.ElementType;
}

const NAV_ITEMS: NavItem[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "model", label: "Model", icon: Cpu },
  { id: "provider", label: "Provider", icon: Zap },
  { id: "api", label: "API & Auth", icon: Key },
  { id: "telegram", label: "Telegram", icon: Send },
  { id: "permissions", label: "Permissions", icon: Shield },
  { id: "mcp", label: "MCP Servers", icon: Server },
  { id: "keyboard", label: "Keyboard", icon: Keyboard },
  { id: "data", label: "Data & Privacy", icon: Database },
];

interface SettingsNavProps {
  active: SettingsSection;
  onChange: (section: SettingsSection) => void;
  searchQuery: string;
}

export function SettingsNav({ active, onChange, searchQuery }: SettingsNavProps) {
  const filtered = searchQuery
    ? NAV_ITEMS.filter((item) =>
        item.label.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : NAV_ITEMS;

  return (
    <nav className="w-48 flex-shrink-0 py-2">
      {filtered.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            onClick={() => onChange(item.id)}
            className={cn(
              "w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors text-left",
              active === item.id
                ? "bg-surface-800 text-surface-100"
                : "text-surface-400 hover:text-surface-200 hover:bg-surface-800/50"
            )}
          >
            <Icon className="w-4 h-4 flex-shrink-0" />
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
