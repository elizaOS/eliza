/**
 * List view of cloud apps with per-item status and quick actions.
 */
import {
  Activity,
  Copy,
  ExternalLink,
  Loader2,
  Settings,
  Trash2,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "../../../components/ui/badge";
import { StatusBadge } from "../../../components/ui/status-badge";
import { DashboardDataList } from "./dashboard-data-list";
import { ListActionMenu } from "./list-action-menu";

export interface AppsListItem {
  id: string;
  name: string;
  app_url: string;
  website_url?: string | null;
  is_active: boolean;
  affiliate_code?: string | null;
  total_users: number;
  total_requests: number;
  updated_at: string | Date;
}

export interface AppsListLinkRenderProps {
  app: AppsListItem;
  className?: string;
  children: ReactNode;
}

export interface AppsListViewProps {
  apps: AppsListItem[];
  deletingId?: string | null;
  renderAppLink: (props: AppsListLinkRenderProps) => ReactNode;
  onCopyUrl?: (app: AppsListItem) => void;
  onDeleteApp?: (app: AppsListItem) => void;
}

function formatRelativeTime(value: string | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";

  const diffMs = Date.now() - date.getTime();
  const minutes = Math.max(0, Math.floor(diffMs / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function AppsListView({
  apps,
  deletingId,
  renderAppLink,
  onCopyUrl,
  onDeleteApp,
}: AppsListViewProps) {
  if (apps.length === 0) {
    return null;
  }

  return (
    <DashboardDataList className="grid grid-cols-1 gap-2 space-y-0">
      {apps.map((app) => (
        <div
          key={app.id}
          className="group relative min-w-0 overflow-hidden rounded-sm border border-white/10 bg-white/5 transition-all duration-300 hover:border-white/20 hover:bg-white/[0.07]"
        >
          <div className="px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {renderAppLink({
                  app,
                  className:
                    "min-w-0 truncate text-sm font-medium text-white transition-colors hover:text-[var(--accent)]",
                  children: app.name,
                })}
                <StatusBadge
                  status={app.is_active ? "success" : "neutral"}
                  label={app.is_active ? "Active" : "Inactive"}
                  className="px-1.5 py-0 text-[10px]"
                />
                {app.affiliate_code ? (
                  <Badge className="shrink-0 rounded-sm border-accent/30 bg-accent-subtle px-1.5 py-0 text-2xs text-accent">
                    Affiliate
                  </Badge>
                ) : null}
              </div>

              <ListActionMenu
                triggerClassName="h-8 w-8 rounded-sm bg-transparent hover:bg-white/10"
                contentClassName="w-44"
                onTriggerClick={(event) => event.preventDefault()}
                items={[
                  {
                    asChild: true,
                    label: "Manage App",
                    className: "cursor-pointer",
                    child: renderAppLink({
                      app,
                      children: (
                        <>
                          <Settings className="mr-2 h-4 w-4" />
                          Manage App
                        </>
                      ),
                    }),
                  },
                  {
                    label: "Copy URL",
                    icon: Copy,
                    className: "cursor-pointer",
                    onSelect: () => onCopyUrl?.(app),
                  },
                  ...(app.website_url
                    ? [
                        {
                          asChild: true as const,
                          label: "Visit Website",
                          className: "cursor-pointer",
                          child: (
                            <a
                              href={app.website_url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <ExternalLink className="mr-2 h-4 w-4" />
                              Visit Website
                            </a>
                          ),
                        },
                      ]
                    : []),
                  { type: "separator" },
                  {
                    label: "Delete App",
                    icon: deletingId === app.id ? Loader2 : Trash2,
                    disabled: deletingId === app.id,
                    className:
                      "cursor-pointer bg-red-500/10 text-red-500 hover:bg-red-500/20   [&_svg]:text-red-500 data-[disabled]:opacity-60",
                    onSelect: () => onDeleteApp?.(app),
                  },
                ]}
              />
            </div>

            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="min-w-0 basis-full truncate text-white/74 sm:basis-auto">
                {app.app_url}
              </span>
              <span className="hidden text-white/20 sm:inline">-</span>
              <div className="flex shrink-0 items-center gap-1 text-white/50">
                <Users className="h-3 w-3 text-muted" />
                <span>{app.total_users.toLocaleString()}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1 text-white/50">
                <Activity className="h-3 w-3 text-muted" />
                <span>{app.total_requests.toLocaleString()}</span>
              </div>
              <span className="text-white/20">-</span>
              <span className="shrink-0 text-white/40">
                {formatRelativeTime(app.updated_at)}
              </span>
            </div>
          </div>
        </div>
      ))}
    </DashboardDataList>
  );
}
