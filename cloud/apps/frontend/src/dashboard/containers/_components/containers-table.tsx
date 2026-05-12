/**
 * Containers table component displaying deployed containers with filtering and sorting.
 * Supports search, status filtering, deletion, and navigation to container logs.
 */

"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@elizaos/cloud-ui";
import { ArrowUpDown, Boxes, ExternalLink, FileText, Search, Server, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

// Simplified container type for table display
interface TableContainer {
  id: string;
  name: string;
  description: string | null;
  status: string;
  load_balancer_url: string | null;
  port: number;
  desired_count: number;
  cpu: number;
  memory: number;
  last_deployed_at: Date | null;
  created_at: Date;
  error_message: string | null;
}

interface ContainersTableProps {
  containers: TableContainer[];
}

const STATUS_COLORS = {
  running: "bg-green-500 hover:bg-green-600",
  pending: "bg-yellow-500 hover:bg-yellow-600",
  building: "bg-yellow-500 hover:bg-yellow-600",
  deploying: "bg-blue-500 hover:bg-blue-600",
  failed: "bg-red-500 hover:bg-red-600",
  stopped: "bg-gray-500 hover:bg-gray-600",
  deleting: "bg-orange-500 hover:bg-orange-600",
} as const;

const STATUS_ICONS = {
  running: "🟢",
  pending: "🟡",
  building: "🔨",
  deploying: "🚀",
  failed: "🔴",
  stopped: "⚫",
  deleting: "🗑️",
} as const;

type SortField = "name" | "status" | "deployed" | "cpu" | "memory";
type SortDirection = "asc" | "desc";

interface TableFilters {
  searchQuery: string;
  statusFilter: string;
  sortField: SortField;
  sortDirection: SortDirection;
}

const DEFAULT_FILTERS: TableFilters = {
  searchQuery: "",
  statusFilter: "all",
  sortField: "deployed",
  sortDirection: "desc",
};

export function ContainersTable({ containers }: ContainersTableProps) {
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Consolidated filter and sort state
  const [filters, setFilters] = useState<TableFilters>(DEFAULT_FILTERS);

  const getStatusColor = (status: string): string => {
    return STATUS_COLORS[status as keyof typeof STATUS_COLORS] || "bg-gray-500";
  };

  const _getStatusIcon = (status: string): string => {
    return STATUS_ICONS[status as keyof typeof STATUS_ICONS] || "⚪";
  };

  const handleSort = (field: SortField) => {
    setFilters((prev) => ({
      ...prev,
      sortField: field,
      sortDirection: prev.sortField === field && prev.sortDirection === "asc" ? "desc" : "asc",
    }));
  };

  const filteredAndSortedContainers = useMemo(() => {
    const filtered = containers.filter((container) => {
      const matchesSearch =
        filters.searchQuery === "" ||
        container.name.toLowerCase().includes(filters.searchQuery.toLowerCase()) ||
        container.description?.toLowerCase().includes(filters.searchQuery.toLowerCase());

      const matchesStatus =
        filters.statusFilter === "all" || container.status === filters.statusFilter;

      return matchesSearch && matchesStatus;
    });

    filtered.sort((a, b) => {
      let comparison = 0;

      switch (filters.sortField) {
        case "name":
          comparison = a.name.localeCompare(b.name);
          break;
        case "status":
          comparison = a.status.localeCompare(b.status);
          break;
        case "deployed": {
          const aDate = a.last_deployed_at ? new Date(a.last_deployed_at).getTime() : 0;
          const bDate = b.last_deployed_at ? new Date(b.last_deployed_at).getTime() : 0;
          comparison = aDate - bDate;
          break;
        }
        case "cpu":
          comparison = a.cpu - b.cpu;
          break;
        case "memory":
          comparison = a.memory - b.memory;
          break;
      }

      return filters.sortDirection === "asc" ? comparison : -comparison;
    });

    return filtered;
  }, [containers, filters]);

  const handleDelete = async (id: string) => {
    setIsDeleting(true);

    const response = await fetch(`/api/v1/containers/${id}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      throw new Error("Failed to delete container");
    }

    toast.success("Container deleted successfully");
    window.location.reload();
    setIsDeleting(false);
    setDeleteId(null);
  };

  const formatDate = (date: Date | null): string => {
    if (!date) return "Never";
    const now = new Date();
    const deployDate = new Date(date);
    const diffMs = now.getTime() - deployDate.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;
    return deployDate.toLocaleDateString();
  };

  if (containers.length === 0) {
    return null;
  }

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* Search and Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-500" />
            <Input
              placeholder="Search containers..."
              value={filters.searchQuery}
              onChange={(e) =>
                setFilters((prev) => ({
                  ...prev,
                  searchQuery: e.target.value,
                }))
              }
              className="pl-9 h-10 rounded-lg border-white/10 bg-black/40 text-white placeholder:text-neutral-500 focus-visible:ring-[#FF5800]/50"
            />
          </div>
          <Select
            value={filters.statusFilter}
            onValueChange={(value) => setFilters((prev) => ({ ...prev, statusFilter: value }))}
          >
            <SelectTrigger className="w-full sm:w-[160px] h-10 rounded-lg border-white/10 bg-black/40">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent className="rounded-lg border-white/10 bg-neutral-900">
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="running">Running</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="building">Building</SelectItem>
              <SelectItem value="deploying">Deploying</SelectItem>
              <SelectItem value="stopped">Stopped</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Results Count */}
        {(filters.searchQuery || filters.statusFilter !== "all") && (
          <p className="text-sm text-neutral-500">
            Showing {filteredAndSortedContainers.length} of {containers.length} containers
          </p>
        )}

        {/* Desktop table */}
        <div className="hidden overflow-hidden rounded-lg border border-white/10 md:block">
          <Table>
            <TableHeader>
              <TableRow className="bg-black/40 border-b border-white/10">
                <TableHead>
                  <button
                    onClick={() => handleSort("name")}
                    className="flex items-center gap-1 text-xs font-medium text-neutral-400 hover:text-white transition-colors"
                  >
                    Container
                    <ArrowUpDown className="h-3 w-3" />
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    onClick={() => handleSort("status")}
                    className="flex items-center gap-1 text-xs font-medium text-neutral-400 hover:text-white transition-colors"
                  >
                    Status
                    <ArrowUpDown className="h-3 w-3" />
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    onClick={() => handleSort("cpu")}
                    className="flex items-center gap-1 text-xs font-medium text-neutral-400 hover:text-white transition-colors"
                  >
                    Resources
                    <ArrowUpDown className="h-3 w-3" />
                  </button>
                </TableHead>
                <TableHead className="text-xs font-medium text-neutral-400">Instances</TableHead>
                <TableHead>
                  <button
                    onClick={() => handleSort("deployed")}
                    className="flex items-center gap-1 text-xs font-medium text-neutral-400 hover:text-white transition-colors"
                  >
                    Deployed
                    <ArrowUpDown className="h-3 w-3" />
                  </button>
                </TableHead>
                <TableHead className="text-right text-xs font-medium text-neutral-400">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredAndSortedContainers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center">
                    <div className="flex flex-col items-center justify-center text-neutral-500">
                      <Boxes className="h-8 w-8 mb-2" />
                      <p>No containers match your filters</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filteredAndSortedContainers.map((container) => (
                  <TableRow
                    key={container.id}
                    className="hover:bg-white/5 transition-colors border-b border-white/5"
                  >
                    <TableCell>
                      <div className="space-y-1">
                        <Link
                          to={`/dashboard/containers/${container.id}`}
                          className="font-medium text-white hover:text-[#FF5800] transition-colors"
                        >
                          {container.name}
                        </Link>
                        {container.description && (
                          <p className="text-sm text-neutral-500 line-clamp-1">
                            {container.description}
                          </p>
                        )}
                        <div className="text-xs text-neutral-600">Port: {container.port}</div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-2">
                        <Badge
                          variant="outline"
                          className={`${getStatusColor(container.status)} text-white border-none w-fit rounded-md text-xs`}
                        >
                          {container.status}
                        </Badge>
                        {container.error_message && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <p className="text-xs text-red-500 truncate max-w-[200px] cursor-help">
                                {container.error_message}
                              </p>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs bg-neutral-900 border-white/10">
                              <p>{container.error_message}</p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm text-neutral-400">
                        <div>{container.cpu} CPU</div>
                        <div>{container.memory}MB RAM</div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5 text-sm text-neutral-400">
                        <Server className="h-3.5 w-3.5" />
                        <span>{container.desired_count}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">
                        <div className="text-white">{formatDate(container.last_deployed_at)}</div>
                        {container.last_deployed_at && (
                          <div className="text-xs text-neutral-500">
                            {new Date(container.last_deployed_at).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Link to={`/dashboard/containers/${container.id}`}>
                              <button className="p-2 text-neutral-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
                                <FileText className="h-4 w-4" />
                              </button>
                            </Link>
                          </TooltipTrigger>
                          <TooltipContent className="bg-neutral-900 border-white/10">
                            View details & logs
                          </TooltipContent>
                        </Tooltip>

                        {container.load_balancer_url && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={() => window.open(container.load_balancer_url!, "_blank")}
                                className="p-2 text-neutral-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
                              >
                                <ExternalLink className="h-4 w-4" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent className="bg-neutral-900 border-white/10">
                              Open container URL
                            </TooltipContent>
                          </Tooltip>
                        )}

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => setDeleteId(container.id)}
                              disabled={isDeleting}
                              className="p-2 text-neutral-400 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent className="bg-neutral-900 border-white/10">
                            Delete container
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {/* Mobile cards */}
        <div className="space-y-2 md:hidden">
          {filteredAndSortedContainers.length === 0 ? (
            <div className="flex min-h-32 flex-col items-center justify-center rounded-lg border border-white/10 bg-black/40 p-6 text-center text-neutral-500">
              <Boxes className="mb-2 h-8 w-8" />
              <p>No containers match your filters</p>
            </div>
          ) : (
            filteredAndSortedContainers.map((container) => (
              <div
                key={container.id}
                className="space-y-3 rounded-lg border border-white/10 bg-black/40 p-4"
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <Link
                      to={`/dashboard/containers/${container.id}`}
                      className="block truncate font-medium text-white transition-colors hover:text-[#FF5800]"
                    >
                      {container.name}
                    </Link>
                    {container.description && (
                      <p className="line-clamp-2 text-sm text-neutral-500">
                        {container.description}
                      </p>
                    )}
                    <p className="text-xs text-neutral-600">Port: {container.port}</p>
                  </div>
                  <Badge
                    variant="outline"
                    className={`${getStatusColor(container.status)} w-fit shrink-0 rounded-md border-none text-xs text-white`}
                  >
                    {container.status}
                  </Badge>
                </div>

                {container.error_message && (
                  <p className="line-clamp-2 text-xs text-red-500">{container.error_message}</p>
                )}

                <div className="grid grid-cols-3 gap-2 border-t border-white/5 pt-3 text-xs">
                  <div>
                    <p className="text-neutral-600">Resources</p>
                    <p className="mt-1 text-neutral-300">
                      {container.cpu} CPU / {container.memory}MB
                    </p>
                  </div>
                  <div>
                    <p className="text-neutral-600">Instances</p>
                    <p className="mt-1 flex items-center gap-1 text-neutral-300">
                      <Server className="h-3.5 w-3.5" />
                      {container.desired_count}
                    </p>
                  </div>
                  <div>
                    <p className="text-neutral-600">Deployed</p>
                    <p className="mt-1 text-neutral-300">
                      {formatDate(container.last_deployed_at)}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 border-t border-white/5 pt-3">
                  <Link
                    to={`/dashboard/containers/${container.id}`}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 py-2 text-xs text-neutral-300 transition-colors hover:bg-white/5 hover:text-white"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    Details
                  </Link>

                  {container.load_balancer_url && (
                    <button
                      type="button"
                      onClick={() => window.open(container.load_balancer_url!, "_blank")}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 py-2 text-xs text-neutral-300 transition-colors hover:bg-white/5 hover:text-white"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Open
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setDeleteId(container.id)}
                    disabled={isDeleting}
                    className="rounded-lg border border-white/10 px-3 py-2 text-neutral-400 transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                    aria-label={`Delete ${container.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <AlertDialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent className="bg-neutral-900 border-white/10">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white">Delete Container</AlertDialogTitle>
            <AlertDialogDescription className="text-neutral-400">
              Are you sure you want to delete this container? This action cannot be undone and will
              remove the container from AWS ECS.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/10 bg-transparent text-white hover:bg-white/5">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && handleDelete(deleteId)}
              className="bg-red-500 hover:bg-red-600 text-white"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
