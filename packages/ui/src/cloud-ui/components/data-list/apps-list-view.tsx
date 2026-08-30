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
import { Card } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import { StatusBadge } from "../../../components/ui/status-badge";
import { TextLink } from "../../../components/ui/text-link";
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
  /** When provided (with `selectedIds`), each row grows a selection checkbox —
   * the host owns the selection state and any bulk actions on it. */
  onToggleSelect?: (app: AppsListItem, selected: boolean) => void;
  selectedIds?: ReadonlySet<string>;
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
  onToggleSelect,
  selectedIds,
}: AppsListViewProps) {
  if (apps.length === 0) {
    return null;
  }

  return (
    <DashboardDataList className="grid grid-cols-1 gap-2">
      {apps.map((app) => (
        <Card
          key={app.id}
          variant="panel"
          className="group relative min-w-0 overflow-hidden transition-colors duration-300"
        >
          <div className="px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {onToggleSelect ? (
                  <Checkbox
                    aria-label={`Select ${app.name}`}
                    checked={selectedIds?.has(app.id) ?? false}
                    onCheckedChange={(checked) =>
                      onToggleSelect(app, checked === true)
                    }
                  />
                ) : null}
                {renderAppLink({
                  app,
                  className:
                    "min-w-0 truncate text-sm font-medium text-white transition-colors hover:text-txt-strong",
                  children: app.name,
                })}
                <StatusBadge
                  status={app.is_active ? "success" : "neutral"}
                  label={app.is_active ? "Active" : "Inactive"}
                />
                {app.affiliate_code ? (
                  <Badge
                    variant="outline"
                    size="micro"
                    tone="muted"
                    className="shrink-0"
                  >
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
                          <Settings className="mr-2 size-4" />
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
                            <TextLink
                              href={app.website_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-normal text-inherit no-underline"
                            >
                              <ExternalLink className="mr-2  size-4" />
                              Visit Website
                            </TextLink>
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
                      "cursor-pointer bg-destructive-subtle text-destructive hover:bg-destructive-subtle/70 [&_svg]:text-destructive data-[disabled]:opacity-60",
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
                <Users className="size-3 text-muted" />
                <span>{app.total_users.toLocaleString()}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1 text-white/50">
                <Activity className="size-3 text-muted" />
                <span>{app.total_requests.toLocaleString()}</span>
              </div>
              <span className="text-white/20">-</span>
              <span className="shrink-0 text-white/60">
                {formatRelativeTime(app.updated_at)}
              </span>
            </div>
          </div>
        </Card>
      ))}
    </DashboardDataList>
  );
}
