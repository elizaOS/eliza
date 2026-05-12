"use client";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useSetPageHeader,
} from "@elizaos/cloud-ui";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bug,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Edit,
  ExternalLink,
  Eye,
  FileText,
  HardDrive,
  Loader2,
  Network,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Square,
  Trash2,
  Wifi,
  WifiOff,
  XCircle,
} from "lucide-react";
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { WarmPoolPanel } from "./warm-pool-panel";

// Error boundary for tab content
class TabErrorBoundary extends Component<
  { fallback: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[TabErrorBoundary] ${this.props.fallback}:`, error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="rounded-md border border-red-200 bg-red-50 p-6 text-center dark:border-red-800 dark:bg-red-950">
          <p className="text-sm font-medium text-red-800 dark:text-red-200">
            {this.props.fallback}: {this.state.error.message}
          </p>
          <button
            type="button"
            className="mt-2 text-xs text-red-600 underline dark:text-red-400"
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DockerNode {
  id: string;
  nodeId: string;
  hostname: string;
  sshPort: number;
  sshUser: string;
  capacity: number;
  allocatedCount: number;
  availableSlots: number;
  enabled: boolean;
  status: "healthy" | "offline" | "degraded" | "unknown";
  lastHealthCheck: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** Container from the infrastructure snapshot (has live health data from SSH) */
interface InfraContainer {
  id: string;
  sandboxId: string | null;
  agentName: string | null;
  organizationId: string | null;
  userId: string | null;
  nodeId: string | null;
  containerName: string | null;
  dbStatus: string;
  liveHealth: string;
  liveHealthSeverity: string;
  liveHealthReason: string;
  runtimeState: string | null;
  runtimeStatus: string | null;
  runtimePresent: boolean;
  dockerImage: string | null;
  bridgePort: number | null;
  webUiPort: number | null;
  headscaleIp: string | null;
  bridgeUrl: string | null;
  healthUrl: string | null;
  lastHeartbeatAt: string | null;
  heartbeatAgeMinutes: number | null;
  errorMessage: string | null;
  errorCount: number;
  createdAt: string;
  updatedAt: string;
}

interface GhostContainer {
  name: string;
  state: string;
  status: string;
}

interface NodeRuntime {
  reachable: boolean;
  checkedAt: string;
  sshLatencyMs: number | null;
  dockerVersion: string | null;
  diskUsedPercent: number | null;
  memoryUsedPercent: number | null;
  loadAverage: string | null;
  actualContainerCount: number;
  runningContainerCount: number;
  containers: Array<{
    name: string;
    id: string;
    image: string | null;
    state: string;
    status: string;
    runningFor: string | null;
    health: string | null;
  }>;
  error: string | null;
}

interface InfraNode {
  id: string;
  nodeId: string;
  hostname: string;
  sshPort: number;
  sshUser: string;
  capacity: number;
  allocatedCount: number;
  availableSlots: number;
  enabled: boolean;
  status: string;
  lastHealthCheck: string | null;
  utilizationPct: number;
  runtime: NodeRuntime;
  allocationDrift: number;
  alerts: string[];
  containers: InfraContainer[];
  ghostContainers: GhostContainer[];
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

interface InfraIncident {
  severity: string;
  scope: string;
  title: string;
  detail: string;
  nodeId?: string;
  containerId?: string;
}

interface InfraSummary {
  totalNodes: number;
  enabledNodes: number;
  healthyNodes: number;
  degradedNodes: number;
  offlineNodes: number;
  unknownNodes: number;
  totalCapacity: number;
  allocatedSlots: number;
  availableSlots: number;
  utilizationPct: number;
  totalContainers: number;
  runningContainers: number;
  stoppedContainers: number;
  errorContainers: number;
  healthyContainers: number;
  attentionContainers: number;
  failedContainers: number;
  missingContainers: number;
  staleContainers: number;
}

interface InfraSnapshot {
  refreshedAt: string;
  summary: InfraSummary;
  incidents: InfraIncident[];
  nodes: InfraNode[];
  containers: InfraContainer[];
}

/** Container row for display — includes both DB-tracked and ghost containers */
interface ContainerRow {
  key: string;
  type: "tracked" | "ghost";
  containerName: string;
  agentName: string | null;
  nodeId: string;
  nodeHostname: string;
  status: string;
  liveHealth: string;
  liveHealthSeverity: string;
  liveHealthReason: string;
  runtimeState: string | null;
  runtimeStatus: string | null;
  dockerImage: string | null;
  bridgePort: number | null;
  webUiPort: number | null;
  headscaleIp: string | null;
  bridgeUrl: string | null;
  healthUrl: string | null;
  lastHeartbeatAt: string | null;
  heartbeatAgeMinutes: number | null;
  errorMessage: string | null;
  errorCount: number;
  sandboxId: string | null;
  createdAt: string;
  sshUser: string;
  sshPort: number;
}

interface VpnNode {
  id: string;
  name: string;
  givenName: string;
  user: string;
  ipAddresses: string[];
  online: boolean;
  lastSeen: string;
  expiry: string;
  createdAt: string;
  tags: string[];
}

interface HeadscaleData {
  serverConfigured?: boolean;
  user: string;
  vpnNodes: VpnNode[];
  summary: { total: number; online: number; offline: number };
  queriedAt: string;
}

interface AuditResult {
  nodesChecked: number;
  ghostContainers: Array<{ nodeId: string; hostname: string; names: string[] }>;
  orphanRecords: Array<{ id: string; containerName: string | null }>;
  totalGhostContainers?: number;
  totalOrphanRecords?: number;
  auditedAt?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function NodeStatusBadge({ status }: { status: string }) {
  const map: Record<
    string,
    {
      label: string;
      variant: "default" | "secondary" | "destructive" | "outline";
      icon: typeof CheckCircle2;
      className: string;
    }
  > = {
    healthy: {
      label: "Healthy",
      variant: "default",
      icon: CheckCircle2,
      className: "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30",
    },
    degraded: {
      label: "Degraded",
      variant: "secondary",
      icon: AlertTriangle,
      className: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/30",
    },
    offline: {
      label: "Offline",
      variant: "destructive",
      icon: XCircle,
      className: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
    },
    unknown: {
      label: "Unknown",
      variant: "outline",
      icon: Clock,
      className: "",
    },
  };
  const cfg = map[status] ?? map.unknown;
  const Icon = cfg.icon;
  return (
    <Badge variant={cfg.variant} className={`gap-1 ${cfg.className}`}>
      <Icon className="h-3 w-3" />
      {cfg.label}
    </Badge>
  );
}

function LiveHealthBadge({ health, severity }: { health: string; severity: string }) {
  const config: Record<
    string,
    {
      variant: "default" | "secondary" | "destructive" | "outline";
      className: string;
      icon: typeof CheckCircle2;
    }
  > = {
    healthy: {
      variant: "default",
      className: "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30",
      icon: CheckCircle2,
    },
    warming: {
      variant: "outline",
      className: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",
      icon: Loader2,
    },
    degraded: {
      variant: "secondary",
      className: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/30",
      icon: AlertTriangle,
    },
    stale: {
      variant: "destructive",
      className: "bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-500/30",
      icon: Clock,
    },
    missing: {
      variant: "destructive",
      className: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
      icon: XCircle,
    },
    failed: {
      variant: "destructive",
      className: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
      icon: XCircle,
    },
    stopped: {
      variant: "secondary",
      className: "bg-gray-500/15 text-gray-700 dark:text-gray-400 border-gray-500/30",
      icon: Square,
    },
  };
  const cfg = config[health] ?? {
    variant: "outline" as const,
    className: "",
    icon: Clock,
  };
  const Icon = cfg.icon;
  return (
    <Badge variant={cfg.variant} className={`gap-1 ${cfg.className}`}>
      <Icon className={`h-3 w-3 ${health === "warming" ? "animate-spin" : ""}`} />
      {health}
    </Badge>
  );
}

function ContainerStatusBadge({ status }: { status: string }) {
  const map: Record<
    string,
    {
      variant: "default" | "secondary" | "destructive" | "outline";
      className: string;
    }
  > = {
    running: {
      variant: "default",
      className: "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30",
    },
    stopped: {
      variant: "secondary",
      className: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/30",
    },
    error: {
      variant: "destructive",
      className: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
    },
    provisioning: {
      variant: "outline",
      className: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",
    },
    pending: {
      variant: "outline",
      className: "bg-purple-500/15 text-purple-700 dark:text-purple-400 border-purple-500/30",
    },
    disconnected: {
      variant: "secondary",
      className: "bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-500/30",
    },
    // Ghost container states
    exited: {
      variant: "secondary",
      className: "bg-gray-500/15 text-gray-700 dark:text-gray-400 border-gray-500/30",
    },
    dead: {
      variant: "destructive",
      className: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
    },
    created: {
      variant: "outline",
      className: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",
    },
    restarting: {
      variant: "outline",
      className: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/30",
    },
  };
  const cfg = map[status] ?? { variant: "outline" as const, className: "" };
  return (
    <Badge variant={cfg.variant} className={cfg.className}>
      {status}
    </Badge>
  );
}

type SortField = "containerName" | "agentName" | "nodeId" | "status" | "liveHealth" | "createdAt";
type SortDirection = "asc" | "desc";

/** Minimal type for docker inspect data to avoid unchecked casts throughout */
interface DockerInspectData {
  Config?: {
    Image?: string;
    Env?: string[];
  };
  Image?: string;
  State?: {
    Status?: string;
    StartedAt?: string;
  };
  RestartCount?: number;
  Platform?: string;
  Driver?: string;
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
  [key: string]: unknown;
}

/** Sortable table header — extracted to module scope to avoid re-creating on every render */
function SortableHeader({
  field,
  label,
  sortField,
  sortDirection,
  toggleSort,
}: {
  field: SortField;
  label: string;
  sortField: SortField;
  sortDirection: SortDirection;
  toggleSort: (field: SortField) => void;
}) {
  const isActive = sortField === field;
  return (
    <TableHead
      className="cursor-pointer select-none hover:text-foreground"
      onClick={() => toggleSort(field)}
    >
      <div className="flex items-center gap-1">
        {label}
        {isActive ? (
          sortDirection === "asc" ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-30" />
        )}
      </div>
    </TableHead>
  );
}

/**
 * Mask sensitive environment variables in a docker inspect payload.
 * Returns a deep copy with Config.Env values redacted.
 */
function maskInspectForDisplay(data: DockerInspectData): DockerInspectData {
  const copy = JSON.parse(JSON.stringify(data)) as DockerInspectData;
  if (copy.Config?.Env) {
    copy.Config.Env = copy.Config.Env.map((env: string) => {
      const [key] = env.split("=");
      const isSensitive = /key|secret|password|token|api/i.test(key ?? "");
      return isSensitive ? `${key}=****` : env;
    });
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function InfrastructureDashboard() {
  useSetPageHeader({
    title: "Infrastructure",
    description: "Docker nodes, containers, and Headscale mesh management",
  });

  // ---- Data state ----
  const [nodes, setNodes] = useState<DockerNode[]>([]);
  const [infraSnapshot, setInfraSnapshot] = useState<InfraSnapshot | null>(null);
  const [headscale, setHeadscale] = useState<HeadscaleData | null>(null);

  // ---- Loading flags ----
  const [loadingNodes, setLoadingNodes] = useState(false);
  const [loadingInfra, setLoadingInfra] = useState(false);
  const [loadingHeadscale, setLoadingHeadscale] = useState(false);

  // ---- Container filters ----
  const [containerStatusFilter, setContainerStatusFilter] = useState<string>("all");
  const [containerNodeFilter, setContainerNodeFilter] = useState<string>("all");
  const [containerTypeFilter, setContainerTypeFilter] = useState<string>("all");
  const [containerSearchQuery, setContainerSearchQuery] = useState<string>("");

  // ---- Sorting ----
  const [sortField, setSortField] = useState<SortField>("nodeId");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  // ---- Expanded rows ----
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  // ---- Health check loading per node ----
  const [healthChecking, setHealthChecking] = useState<Record<string, boolean>>({});

  // ---- Add Node dialog ----
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [addNodeForm, setAddNodeForm] = useState({
    nodeId: "",
    hostname: "",
    sshPort: "22",
    capacity: "8",
    sshUser: "root",
  });
  const [addNodeLoading, setAddNodeLoading] = useState(false);

  // ---- Edit Node dialog ----
  const [editNodeOpen, setEditNodeOpen] = useState(false);
  const [editNodeTarget, setEditNodeTarget] = useState<DockerNode | null>(null);
  const [editNodeForm, setEditNodeForm] = useState({
    capacity: "",
    hostname: "",
    sshPort: "",
    enabled: true,
  });
  const [editNodeLoading, setEditNodeLoading] = useState(false);

  // ---- Delete Node confirm ----
  const [deleteNodeTarget, setDeleteNodeTarget] = useState<DockerNode | null>(null);
  const [deleteNodeLoading, setDeleteNodeLoading] = useState(false);

  // ---- Container logs dialog ----
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsTarget, setLogsTarget] = useState<ContainerRow | null>(null);
  const [logsContent, setLogsContent] = useState<string>("");
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsLines, setLogsLines] = useState<string>("200");

  // ---- Container details dialog ----
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsTarget, setDetailsTarget] = useState<ContainerRow | null>(null);
  const [detailsData, setDetailsData] = useState<DockerInspectData | null>(null);
  const [detailsResources, setDetailsResources] = useState<Record<string, string> | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

  // ---- Container action loading ----
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});

  // ---- Incidents collapsed ----
  const [incidentsExpanded, setIncidentsExpanded] = useState(false);

  // ---- Audit dialog ----
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditResult, setAuditResult] = useState<AuditResult | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);

  // ---- Post-action refresh timer (cleaned up on unmount) ----
  const actionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (actionRefreshTimerRef.current !== null) {
        clearTimeout(actionRefreshTimerRef.current);
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Data fetchers
  // ---------------------------------------------------------------------------

  const loadNodes = useCallback(async () => {
    setLoadingNodes(true);
    try {
      const res = await fetch("/api/v1/admin/docker-nodes");
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      setNodes(json.data?.nodes ?? []);
    } catch (err) {
      toast.error(`Failed to load nodes: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingNodes(false);
    }
  }, []);

  const loadInfraSnapshot = useCallback(async () => {
    setLoadingInfra(true);
    try {
      const res = await fetch("/api/v1/admin/infrastructure");
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      setInfraSnapshot(json.data);
    } catch (err) {
      toast.error(
        `Failed to load infrastructure: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoadingInfra(false);
    }
  }, []);

  const loadHeadscale = useCallback(async () => {
    setLoadingHeadscale(true);
    try {
      const res = await fetch("/api/v1/admin/headscale");
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      setHeadscale(json.data);
    } catch (err) {
      toast.error(`Failed to load headscale: ${err instanceof Error ? err.message : String(err)}`);
      setHeadscale(null);
    } finally {
      setLoadingHeadscale(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadNodes();
    loadInfraSnapshot();
    loadHeadscale();
  }, [loadNodes, loadInfraSnapshot, loadHeadscale]);

  // ---------------------------------------------------------------------------
  // Build container rows from infrastructure snapshot
  // ---------------------------------------------------------------------------

  const containerRows: ContainerRow[] = useMemo(() => {
    if (!infraSnapshot) return [];
    const rows: ContainerRow[] = [];

    for (const node of infraSnapshot.nodes) {
      // DB-tracked containers
      for (const c of node.containers) {
        rows.push({
          key: c.id,
          type: "tracked",
          containerName: c.containerName ?? c.sandboxId ?? c.id.slice(0, 12),
          agentName: c.agentName,
          nodeId: node.nodeId,
          nodeHostname: node.hostname,
          status: c.dbStatus,
          liveHealth: c.liveHealth,
          liveHealthSeverity: c.liveHealthSeverity,
          liveHealthReason: c.liveHealthReason,
          runtimeState: c.runtimeState,
          runtimeStatus: c.runtimeStatus,
          dockerImage: c.dockerImage,
          bridgePort: c.bridgePort,
          webUiPort: c.webUiPort,
          headscaleIp: c.headscaleIp,
          bridgeUrl: c.bridgeUrl,
          healthUrl: c.healthUrl,
          lastHeartbeatAt: c.lastHeartbeatAt,
          heartbeatAgeMinutes: c.heartbeatAgeMinutes,
          errorMessage: c.errorMessage,
          errorCount: c.errorCount,
          sandboxId: c.sandboxId,
          createdAt: c.createdAt,
          sshUser: node.sshUser,
          sshPort: node.sshPort,
        });
      }

      // Ghost containers (running on node but not in DB)
      for (const g of node.ghostContainers) {
        rows.push({
          key: `ghost-${node.nodeId}-${g.name}`,
          type: "ghost",
          containerName: g.name,
          agentName: null,
          nodeId: node.nodeId,
          nodeHostname: node.hostname,
          status: g.state,
          liveHealth:
            g.state === "running" ? "healthy" : g.state === "exited" ? "stopped" : "degraded",
          liveHealthSeverity: g.state === "running" ? "info" : "warning",
          liveHealthReason: g.status || g.state,
          runtimeState: g.state,
          runtimeStatus: g.status,
          dockerImage: null,
          bridgePort: null,
          webUiPort: null,
          headscaleIp: null,
          bridgeUrl: null,
          healthUrl: null,
          lastHeartbeatAt: null,
          heartbeatAgeMinutes: null,
          errorMessage: null,
          errorCount: 0,
          sandboxId: null,
          createdAt: "",
          sshUser: node.sshUser,
          sshPort: node.sshPort,
        });
      }
    }

    // Unassigned containers (no node)
    for (const c of infraSnapshot.containers) {
      if (!c.nodeId && !rows.some((r) => r.key === c.id)) {
        rows.push({
          key: c.id,
          type: "tracked",
          containerName: c.containerName ?? c.sandboxId ?? c.id.slice(0, 12),
          agentName: c.agentName,
          nodeId: "unassigned",
          nodeHostname: "—",
          status: c.dbStatus,
          liveHealth: c.liveHealth,
          liveHealthSeverity: c.liveHealthSeverity,
          liveHealthReason: c.liveHealthReason,
          runtimeState: c.runtimeState,
          runtimeStatus: c.runtimeStatus,
          dockerImage: c.dockerImage,
          bridgePort: c.bridgePort,
          webUiPort: c.webUiPort,
          headscaleIp: c.headscaleIp,
          bridgeUrl: c.bridgeUrl,
          healthUrl: c.healthUrl,
          lastHeartbeatAt: c.lastHeartbeatAt,
          heartbeatAgeMinutes: c.heartbeatAgeMinutes,
          errorMessage: c.errorMessage,
          errorCount: c.errorCount,
          sandboxId: c.sandboxId,
          createdAt: c.createdAt,
          sshUser: "",
          sshPort: 22,
        });
      }
    }

    return rows;
  }, [infraSnapshot]);

  // ---------------------------------------------------------------------------
  // Filtered & sorted container rows
  // ---------------------------------------------------------------------------

  const filteredContainerRows = useMemo(() => {
    let rows = containerRows;

    if (containerStatusFilter !== "all") {
      rows = rows.filter(
        (r) => r.status === containerStatusFilter || r.liveHealth === containerStatusFilter,
      );
    }
    if (containerNodeFilter !== "all") {
      rows = rows.filter((r) => r.nodeId === containerNodeFilter);
    }
    if (containerTypeFilter !== "all") {
      rows = rows.filter((r) => r.type === containerTypeFilter);
    }
    if (containerSearchQuery.trim()) {
      const q = containerSearchQuery.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.containerName.toLowerCase().includes(q) ||
          r.agentName?.toLowerCase().includes(q) ||
          r.nodeId.toLowerCase().includes(q) ||
          r.dockerImage?.toLowerCase().includes(q),
      );
    }

    // Sort
    rows = [...rows].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "containerName":
          cmp = a.containerName.localeCompare(b.containerName);
          break;
        case "agentName":
          cmp = (a.agentName ?? "").localeCompare(b.agentName ?? "");
          break;
        case "nodeId":
          cmp = a.nodeId.localeCompare(b.nodeId);
          break;
        case "status":
          cmp = a.status.localeCompare(b.status);
          break;
        case "liveHealth":
          cmp = a.liveHealth.localeCompare(b.liveHealth);
          break;
        case "createdAt":
          cmp = a.createdAt.localeCompare(b.createdAt);
          break;
        default:
          cmp = 0;
      }
      return sortDirection === "asc" ? cmp : -cmp;
    });

    return rows;
  }, [
    containerRows,
    containerStatusFilter,
    containerNodeFilter,
    containerTypeFilter,
    containerSearchQuery,
    sortField,
    sortDirection,
  ]);

  // Group by node for display
  const containersByNode = useMemo(() => {
    const groups = new Map<string, ContainerRow[]>();
    for (const row of filteredContainerRows) {
      const nodeKey = row.nodeId;
      if (!groups.has(nodeKey)) groups.set(nodeKey, []);
      groups.get(nodeKey)!.push(row);
    }
    return groups;
  }, [filteredContainerRows]);

  // Unique node IDs for filter dropdown
  const allNodeIds = useMemo(() => {
    const ids = new Set(containerRows.map((r) => r.nodeId));
    return Array.from(ids).sort();
  }, [containerRows]);

  // ---------------------------------------------------------------------------
  // Container Actions
  // ---------------------------------------------------------------------------

  const performContainerAction = useCallback(
    async (row: ContainerRow, action: "restart" | "stop" | "start" | "pull-image") => {
      if (row.nodeId === "unassigned") {
        toast.error("Cannot perform actions on unassigned containers");
        return;
      }
      const loadingKey = `${row.key}-${action}`;
      setActionLoading((prev) => ({ ...prev, [loadingKey]: true }));
      try {
        const res = await fetch("/api/v1/admin/infrastructure/containers/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            nodeId: row.nodeId,
            containerName: row.containerName,
          }),
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.error);
        toast.success(`${action} successful: ${row.containerName}`);
        // Refresh infrastructure snapshot after a short delay to let Docker settle.
        // Timer is tracked in a ref so it can be cleared if the component unmounts.
        if (actionRefreshTimerRef.current !== null) {
          clearTimeout(actionRefreshTimerRef.current);
        }
        actionRefreshTimerRef.current = setTimeout(() => {
          actionRefreshTimerRef.current = null;
          loadInfraSnapshot();
        }, 2000);
      } catch (err) {
        toast.error(`${action} failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setActionLoading((prev) => ({ ...prev, [loadingKey]: false }));
      }
    },
    [loadInfraSnapshot],
  );

  const viewContainerLogs = useCallback(async (row: ContainerRow, lines = 200) => {
    if (row.nodeId === "unassigned") {
      toast.error("Cannot fetch logs for unassigned containers");
      return;
    }
    setLogsTarget(row);
    setLogsContent("");
    setLogsOpen(true);
    setLogsLoading(true);
    try {
      const res = await fetch("/api/v1/admin/infrastructure/containers/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "logs",
          nodeId: row.nodeId,
          containerName: row.containerName,
          lines,
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      setLogsContent(json.data?.logs ?? "(no output)");
    } catch (err) {
      setLogsContent(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLogsLoading(false);
    }
  }, []);

  const viewContainerDetails = useCallback(async (row: ContainerRow) => {
    if (row.nodeId === "unassigned") {
      toast.error("Cannot inspect unassigned containers");
      return;
    }
    setDetailsTarget(row);
    setDetailsData(null);
    setDetailsResources(null);
    setDetailsOpen(true);
    setDetailsLoading(true);
    try {
      const res = await fetch("/api/v1/admin/infrastructure/containers/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "inspect",
          nodeId: row.nodeId,
          containerName: row.containerName,
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      setDetailsData(json.data?.inspect ?? null);
      setDetailsResources(json.data?.resourceUsage ?? null);
    } catch (err) {
      toast.error(`Inspect failed: ${err instanceof Error ? err.message : String(err)}`);
      setDetailsOpen(false);
    } finally {
      setDetailsLoading(false);
    }
  }, []);

  const toggleRowExpand = useCallback((key: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleSort = useCallback((field: SortField) => {
    setSortField((prev) => {
      if (prev === field) {
        setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
        return field;
      }
      setSortDirection("asc");
      return field;
    });
  }, []);

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success("Copied to clipboard"),
      () => toast.error("Failed to copy"),
    );
  }, []);

  // ---------------------------------------------------------------------------
  // Node Actions
  // ---------------------------------------------------------------------------

  const runHealthCheck = useCallback(
    async (node: DockerNode) => {
      setHealthChecking((prev) => ({ ...prev, [node.nodeId]: true }));
      try {
        const res = await fetch(`/api/v1/admin/docker-nodes/${node.nodeId}/health-check`, {
          method: "POST",
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.error);
        toast.success(`Health check complete: ${node.nodeId} is ${json.data?.status ?? "checked"}`);
        await loadNodes();
      } catch (err) {
        toast.error(`Health check failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setHealthChecking((prev) => ({ ...prev, [node.nodeId]: false }));
      }
    },
    [loadNodes],
  );

  const openEditNode = useCallback((node: DockerNode) => {
    setEditNodeTarget(node);
    setEditNodeForm({
      capacity: String(node.capacity),
      hostname: node.hostname,
      sshPort: String(node.sshPort),
      enabled: node.enabled,
    });
    setEditNodeOpen(true);
  }, []);

  const submitEditNode = useCallback(async () => {
    if (!editNodeTarget) return;
    setEditNodeLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/docker-nodes/${editNodeTarget.nodeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capacity: parseInt(editNodeForm.capacity, 10),
          hostname: editNodeForm.hostname,
          sshPort: parseInt(editNodeForm.sshPort, 10),
          enabled: editNodeForm.enabled,
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast.success(`Node ${editNodeTarget.nodeId} updated`);
      setEditNodeOpen(false);
      await loadNodes();
    } catch (err) {
      toast.error(`Failed to update node: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setEditNodeLoading(false);
    }
  }, [editNodeTarget, editNodeForm, loadNodes]);

  const submitDeleteNode = useCallback(async () => {
    if (!deleteNodeTarget) return;
    setDeleteNodeLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/docker-nodes/${deleteNodeTarget.nodeId}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast.success(`Node ${deleteNodeTarget.nodeId} deregistered`);
      setDeleteNodeTarget(null);
      await loadNodes();
    } catch (err) {
      toast.error(`Failed to delete node: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeleteNodeLoading(false);
    }
  }, [deleteNodeTarget, loadNodes]);

  const submitAddNode = useCallback(async () => {
    setAddNodeLoading(true);
    try {
      const res = await fetch("/api/v1/admin/docker-nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeId: addNodeForm.nodeId,
          hostname: addNodeForm.hostname,
          sshPort: parseInt(addNodeForm.sshPort, 10),
          capacity: parseInt(addNodeForm.capacity, 10),
          sshUser: addNodeForm.sshUser,
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast.success(`Node ${addNodeForm.nodeId} registered`);
      setAddNodeOpen(false);
      setAddNodeForm({
        nodeId: "",
        hostname: "",
        sshPort: "22",
        capacity: "8",
        sshUser: "root",
      });
      await loadNodes();
    } catch (err) {
      toast.error(`Failed to register node: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAddNodeLoading(false);
    }
  }, [addNodeForm, loadNodes]);

  const runAudit = useCallback(async () => {
    setAuditLoading(true);
    setAuditResult(null);
    setAuditOpen(true);
    try {
      const res = await fetch("/api/v1/admin/docker-containers/audit", {
        method: "POST",
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      setAuditResult(json.data);
    } catch (err) {
      toast.error(`Audit failed: ${err instanceof Error ? err.message : String(err)}`);
      setAuditOpen(false);
    } finally {
      setAuditLoading(false);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Overview stats from infrastructure snapshot
  // ---------------------------------------------------------------------------

  const summary = infraSnapshot?.summary;
  const nodesOnline = nodes.filter((n) => n.status === "healthy").length;
  const nodesOffline = nodes.filter(
    (n) => n.status === "offline" || n.status === "degraded",
  ).length;
  const nodesUnknown = nodes.filter((n) => n.status === "unknown").length;
  const totalCapacity = nodes.reduce((s, n) => s + n.capacity, 0);
  const totalAllocated = nodes.reduce((s, n) => s + n.allocatedCount, 0);
  const utilizationPct = totalCapacity > 0 ? Math.round((totalAllocated / totalCapacity) * 100) : 0;

  // ---------------------------------------------------------------------------
  // Refresh all
  // ---------------------------------------------------------------------------

  const refreshAll = useCallback(() => {
    loadNodes();
    loadInfraSnapshot();
    loadHeadscale();
  }, [loadNodes, loadInfraSnapshot, loadHeadscale]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Infrastructure</h1>
          <p className="text-muted-foreground">
            Docker nodes, containers, and Headscale mesh management
          </p>
          {infraSnapshot && (
            <p className="text-xs text-muted-foreground mt-1">
              Last refreshed: {formatRelativeTime(infraSnapshot.refreshedAt)}
            </p>
          )}
        </div>
        <Button variant="outline" onClick={refreshAll} disabled={loadingInfra}>
          {loadingInfra ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Refresh All
        </Button>
      </div>

      {/* Overview Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {/* Nodes card */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Docker Nodes</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{nodes.length}</div>
            <p className="text-xs text-muted-foreground">
              <span className="text-green-600">{nodesOnline} online</span>
              {nodesOffline > 0 && (
                <span className="ml-2 text-red-500">{nodesOffline} offline</span>
              )}
              {nodesUnknown > 0 && (
                <span className="ml-2 text-muted-foreground">{nodesUnknown} unchecked</span>
              )}
            </p>
          </CardContent>
        </Card>

        {/* Containers card */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Containers</CardTitle>
            <HardDrive className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{containerRows.length}</div>
            <p className="text-xs text-muted-foreground">
              <span className="text-green-600">
                {
                  containerRows.filter(
                    (r) =>
                      r.status === "running" ||
                      (r.type === "ghost" && r.runtimeState === "running"),
                  ).length
                }{" "}
                running
              </span>
              {containerRows.filter((r) => r.type === "ghost").length > 0 && (
                <span className="ml-2 text-amber-600">
                  {containerRows.filter((r) => r.type === "ghost").length} untracked
                </span>
              )}
              {summary?.errorContainers ? (
                <span className="ml-2 text-red-500">{summary.errorContainers} error</span>
              ) : null}
            </p>
          </CardContent>
        </Card>

        {/* Capacity card */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Capacity</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{utilizationPct}%</div>
            <p className="text-xs text-muted-foreground">
              {totalAllocated} / {totalCapacity} slots used
            </p>
            {totalCapacity > 0 && (
              <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    utilizationPct > 85
                      ? "bg-red-500"
                      : utilizationPct > 60
                        ? "bg-yellow-500"
                        : "bg-green-500"
                  }`}
                  style={{ width: `${utilizationPct}%` }}
                />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Headscale card */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Mesh (Headscale)</CardTitle>
            <Network className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loadingHeadscale ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : headscale ? (
              <>
                <div className="flex items-center gap-2">
                  <Wifi className="h-4 w-4 text-green-500" />
                  <span className="text-2xl font-bold">{headscale.summary.total}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  <span className="text-green-600">{headscale.summary.online} online</span>
                  {headscale.summary.offline > 0 && (
                    <span className="ml-2 text-muted-foreground">
                      {headscale.summary.offline} offline
                    </span>
                  )}{" "}
                  VPN nodes
                </p>
              </>
            ) : (
              <div className="flex items-center gap-2">
                <WifiOff className="h-4 w-4 text-red-500" />
                <span className="text-sm text-muted-foreground">Unavailable</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Warm Pool */}
      <WarmPoolPanel />

      {/* Incidents Banner — compact & collapsible */}
      {infraSnapshot &&
        infraSnapshot.incidents.length > 0 &&
        (() => {
          const criticalCount = infraSnapshot.incidents.filter(
            (i) => i.severity === "critical",
          ).length;
          const warningCount = infraSnapshot.incidents.filter(
            (i) => i.severity === "warning",
          ).length;
          const infoCount = infraSnapshot.incidents.filter((i) => i.severity === "info").length;
          const COLLAPSED_LIMIT = 3;
          const visibleIncidents = incidentsExpanded
            ? infraSnapshot.incidents
            : infraSnapshot.incidents.slice(0, COLLAPSED_LIMIT);
          const hasMore = infraSnapshot.incidents.length > COLLAPSED_LIMIT;

          return (
            <div
              className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 cursor-pointer"
              onClick={() => setIncidentsExpanded(!incidentsExpanded)}
            >
              <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">
                    {infraSnapshot.incidents.length} Active Incident
                    {infraSnapshot.incidents.length !== 1 ? "s" : ""}
                  </span>
                  {criticalCount > 0 && (
                    <Badge variant="destructive" className="text-xs py-0 h-5">
                      {criticalCount} critical
                    </Badge>
                  )}
                  {warningCount > 0 && (
                    <Badge variant="secondary" className="text-xs py-0 h-5">
                      {warningCount} warning
                    </Badge>
                  )}
                  {infoCount > 0 && (
                    <Badge variant="outline" className="text-xs py-0 h-5">
                      {infoCount} info
                    </Badge>
                  )}
                  {incidentsExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground ml-auto shrink-0" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground ml-auto shrink-0" />
                  )}
                </div>
                {!incidentsExpanded && hasMore && (
                  <p className="text-xs text-muted-foreground mt-1">
                    +{infraSnapshot.incidents.length - COLLAPSED_LIMIT} more — click to expand
                  </p>
                )}
                {incidentsExpanded && (
                  <div className="space-y-1 mt-2">
                    {visibleIncidents.map((incident, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        <Badge
                          variant={
                            incident.severity === "critical"
                              ? "destructive"
                              : incident.severity === "warning"
                                ? "secondary"
                                : "outline"
                          }
                          className="text-xs py-0 h-5 shrink-0"
                        >
                          {incident.severity}
                        </Badge>
                        <span className="font-medium truncate">{incident.title}</span>
                        <span className="text-muted-foreground text-xs truncate">
                          — {incident.detail}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

      {/* Tabs */}
      <Tabs defaultValue="nodes" className="space-y-4">
        <TabsList>
          <TabsTrigger value="nodes" onClick={loadNodes}>
            <Server className="mr-2 h-4 w-4" />
            Nodes
          </TabsTrigger>
          <TabsTrigger value="containers" onClick={loadInfraSnapshot}>
            <HardDrive className="mr-2 h-4 w-4" />
            Containers ({containerRows.length})
          </TabsTrigger>
          <TabsTrigger value="mesh" onClick={loadHeadscale}>
            <Network className="mr-2 h-4 w-4" />
            Mesh
          </TabsTrigger>
        </TabsList>

        {/* ------------------------------------------------------------------ */}
        {/* NODES TAB                                                           */}
        {/* ------------------------------------------------------------------ */}
        <TabsContent value="nodes" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Docker Nodes</CardTitle>
                <CardDescription>Registered Docker execution nodes</CardDescription>
              </div>
              <Button onClick={() => setAddNodeOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Add Node
              </Button>
            </CardHeader>
            <CardContent>
              {loadingNodes ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Node ID</TableHead>
                      <TableHead>Hostname</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Capacity</TableHead>
                      <TableHead className="text-right">Used / Avail</TableHead>
                      <TableHead>Last Health Check</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {nodes.map((node) => (
                      <TableRow key={node.id} className={!node.enabled ? "opacity-50" : ""}>
                        <TableCell className="font-mono text-xs">
                          {node.nodeId}
                          {!node.enabled && (
                            <Badge variant="outline" className="ml-2 text-xs">
                              disabled
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {node.hostname}
                          <span className="ml-1 text-xs text-muted-foreground">
                            :{node.sshPort}
                          </span>
                        </TableCell>
                        <TableCell>
                          <NodeStatusBadge status={node.status} />
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {node.capacity}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          <span
                            className={
                              node.allocatedCount > 0
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-muted-foreground"
                            }
                          >
                            {node.allocatedCount}
                          </span>
                          <span className="text-muted-foreground"> / </span>
                          <span
                            className={
                              node.availableSlots === 0
                                ? "text-red-500"
                                : "text-green-600 dark:text-green-400"
                            }
                          >
                            {node.availableSlots}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          <Clock className="mr-1 inline h-3 w-3" />
                          {formatRelativeTime(node.lastHealthCheck)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Run health check"
                              onClick={() => runHealthCheck(node)}
                              disabled={healthChecking[node.nodeId]}
                            >
                              {healthChecking[node.nodeId] ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Activity className="h-4 w-4" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Edit node"
                              onClick={() => openEditNode(node)}
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Delete node"
                              onClick={() => setDeleteNodeTarget(node)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {nodes.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                          No Docker nodes registered. Add one to get started.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ------------------------------------------------------------------ */}
        {/* CONTAINERS TAB                                                      */}
        {/* ------------------------------------------------------------------ */}
        <TabsContent value="containers" className="space-y-4">
          <TabErrorBoundary fallback="Containers tab crashed">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>All Containers</CardTitle>
                  <CardDescription>
                    Live view of all Docker containers across all nodes (via SSH inspection)
                    {infraSnapshot && (
                      <span className="ml-2 text-xs">
                        · {infraSnapshot.nodes.length} nodes scanned · {containerRows.length}{" "}
                        containers found
                      </span>
                    )}
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={runAudit}>
                    <Bug className="mr-2 h-4 w-4" />
                    Audit
                  </Button>
                  <Button variant="outline" onClick={loadInfraSnapshot} disabled={loadingInfra}>
                    {loadingInfra ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-2 h-4 w-4" />
                    )}
                    Refresh
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Filters */}
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Search className="h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search containers..."
                      value={containerSearchQuery}
                      onChange={(e) => setContainerSearchQuery(e.target.value)}
                      className="w-[200px] h-9"
                    />
                  </div>
                  <Select value={containerStatusFilter} onValueChange={setContainerStatusFilter}>
                    <SelectTrigger className="w-[160px]">
                      <SelectValue placeholder="All statuses" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      <SelectItem value="running">Running</SelectItem>
                      <SelectItem value="stopped">Stopped</SelectItem>
                      <SelectItem value="error">Error</SelectItem>
                      <SelectItem value="healthy">Healthy</SelectItem>
                      <SelectItem value="degraded">Degraded</SelectItem>
                      <SelectItem value="failed">Failed</SelectItem>
                      <SelectItem value="stale">Stale</SelectItem>
                      <SelectItem value="missing">Missing</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={containerNodeFilter} onValueChange={setContainerNodeFilter}>
                    <SelectTrigger className="w-[180px]">
                      <SelectValue placeholder="All nodes" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All nodes</SelectItem>
                      {allNodeIds.map((id) => (
                        <SelectItem key={id} value={id}>
                          {id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={containerTypeFilter} onValueChange={setContainerTypeFilter}>
                    <SelectTrigger className="w-[160px]">
                      <SelectValue placeholder="All types" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All types</SelectItem>
                      <SelectItem value="tracked">DB Tracked</SelectItem>
                      <SelectItem value="ghost">Untracked (Ghost)</SelectItem>
                    </SelectContent>
                  </Select>
                  {(containerStatusFilter !== "all" ||
                    containerNodeFilter !== "all" ||
                    containerTypeFilter !== "all" ||
                    containerSearchQuery) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setContainerStatusFilter("all");
                        setContainerNodeFilter("all");
                        setContainerTypeFilter("all");
                        setContainerSearchQuery("");
                      }}
                    >
                      Clear filters
                    </Button>
                  )}
                  <span className="text-xs text-muted-foreground ml-auto">
                    {filteredContainerRows.length} of {containerRows.length} containers
                  </span>
                </div>

                {/* Table */}
                {loadingInfra && !infraSnapshot ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <div className="space-y-6">
                    {Array.from(containersByNode.entries()).map(([nodeId, rows]) => {
                      const nodeInfo = infraSnapshot?.nodes.find((n) => n.nodeId === nodeId);
                      return (
                        <div key={nodeId} className="space-y-2">
                          {/* Node group header */}
                          <div className="flex items-center gap-3 px-2 py-1.5 bg-muted/40 rounded-md">
                            <Server className="h-4 w-4 text-muted-foreground" />
                            <span className="font-mono text-sm font-semibold">{nodeId}</span>
                            {nodeInfo && (
                              <>
                                <span className="text-xs text-muted-foreground">
                                  {nodeInfo.hostname}:{nodeInfo.sshPort}
                                </span>
                                <NodeStatusBadge status={nodeInfo.status} />
                                {nodeInfo.runtime.reachable && (
                                  <span className="text-xs text-muted-foreground">
                                    SSH: {nodeInfo.runtime.sshLatencyMs}ms
                                    {nodeInfo.runtime.diskUsedPercent !== null &&
                                      ` · Disk: ${nodeInfo.runtime.diskUsedPercent}%`}
                                    {nodeInfo.runtime.memoryUsedPercent !== null &&
                                      ` · Mem: ${nodeInfo.runtime.memoryUsedPercent}%`}
                                    {nodeInfo.runtime.loadAverage &&
                                      ` · Load: ${nodeInfo.runtime.loadAverage}`}
                                  </span>
                                )}
                                {!nodeInfo.runtime.reachable && (
                                  <Badge variant="destructive" className="text-xs">
                                    Unreachable
                                  </Badge>
                                )}
                              </>
                            )}
                            <span className="text-xs text-muted-foreground ml-auto">
                              {rows.length} container
                              {rows.length !== 1 ? "s" : ""}
                            </span>
                          </div>

                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-8" />
                                <SortableHeader
                                  field="containerName"
                                  label="Container"
                                  sortField={sortField}
                                  sortDirection={sortDirection}
                                  toggleSort={toggleSort}
                                />
                                <SortableHeader
                                  field="agentName"
                                  label="Agent"
                                  sortField={sortField}
                                  sortDirection={sortDirection}
                                  toggleSort={toggleSort}
                                />
                                <SortableHeader
                                  field="status"
                                  label="Status"
                                  sortField={sortField}
                                  sortDirection={sortDirection}
                                  toggleSort={toggleSort}
                                />
                                <SortableHeader
                                  field="liveHealth"
                                  label="Health"
                                  sortField={sortField}
                                  sortDirection={sortDirection}
                                  toggleSort={toggleSort}
                                />
                                <TableHead>Runtime</TableHead>
                                <TableHead>Heartbeat</TableHead>
                                <TableHead className="text-right">Actions</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {rows.map((row) => {
                                const isExpanded = expandedRows.has(row.key);
                                const isGhost = row.type === "ghost";
                                return (
                                  <>
                                    <TableRow
                                      key={row.key}
                                      className={`${isGhost ? "bg-amber-500/5 hover:bg-amber-500/10" : ""} cursor-pointer`}
                                      onClick={() => toggleRowExpand(row.key)}
                                    >
                                      <TableCell className="w-8 px-2">
                                        {isExpanded ? (
                                          <ChevronDown className="h-4 w-4" />
                                        ) : (
                                          <ChevronRight className="h-4 w-4" />
                                        )}
                                      </TableCell>
                                      <TableCell className="font-mono text-xs">
                                        <div className="flex items-center gap-1.5">
                                          {row.containerName}
                                          {isGhost && (
                                            <Badge
                                              variant="outline"
                                              className="text-xs bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30"
                                            >
                                              ghost
                                            </Badge>
                                          )}
                                        </div>
                                      </TableCell>
                                      <TableCell className="text-sm">
                                        {row.agentName ?? (
                                          <span className="text-muted-foreground text-xs">
                                            {row.sandboxId ? `${row.sandboxId.slice(0, 8)}…` : "—"}
                                          </span>
                                        )}
                                      </TableCell>
                                      <TableCell>
                                        <ContainerStatusBadge status={row.status} />
                                        {row.errorCount > 0 && (
                                          <span className="ml-1 text-xs text-red-500">
                                            ({row.errorCount}x)
                                          </span>
                                        )}
                                      </TableCell>
                                      <TableCell>
                                        <LiveHealthBadge
                                          health={row.liveHealth}
                                          severity={row.liveHealthSeverity}
                                        />
                                      </TableCell>
                                      <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                                        {row.runtimeStatus ?? "—"}
                                      </TableCell>
                                      <TableCell className="text-xs text-muted-foreground">
                                        {row.lastHeartbeatAt ? (
                                          <span
                                            className={
                                              row.heartbeatAgeMinutes !== null &&
                                              row.heartbeatAgeMinutes > 5
                                                ? "text-amber-600"
                                                : ""
                                            }
                                          >
                                            {formatRelativeTime(row.lastHeartbeatAt)}
                                          </span>
                                        ) : (
                                          "—"
                                        )}
                                      </TableCell>
                                      <TableCell
                                        className="text-right"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <div className="flex items-center justify-end gap-0.5">
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            title="View logs"
                                            onClick={() => viewContainerLogs(row)}
                                            disabled={row.nodeId === "unassigned"}
                                          >
                                            <FileText className="h-4 w-4" />
                                          </Button>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            title="Inspect details"
                                            onClick={() => viewContainerDetails(row)}
                                            disabled={row.nodeId === "unassigned"}
                                          >
                                            <Eye className="h-4 w-4" />
                                          </Button>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            title="Restart container"
                                            onClick={() => performContainerAction(row, "restart")}
                                            disabled={
                                              actionLoading[`${row.key}-restart`] ||
                                              row.nodeId === "unassigned"
                                            }
                                          >
                                            {actionLoading[`${row.key}-restart`] ? (
                                              <Loader2 className="h-4 w-4 animate-spin" />
                                            ) : (
                                              <RotateCcw className="h-4 w-4" />
                                            )}
                                          </Button>
                                          {row.runtimeState === "running" ? (
                                            <Button
                                              variant="ghost"
                                              size="sm"
                                              title="Stop container"
                                              onClick={() => performContainerAction(row, "stop")}
                                              disabled={
                                                actionLoading[`${row.key}-stop`] ||
                                                row.nodeId === "unassigned"
                                              }
                                            >
                                              {actionLoading[`${row.key}-stop`] ? (
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                              ) : (
                                                <Square className="h-4 w-4 text-destructive" />
                                              )}
                                            </Button>
                                          ) : (
                                            <Button
                                              variant="ghost"
                                              size="sm"
                                              title="Start container"
                                              onClick={() => performContainerAction(row, "start")}
                                              disabled={
                                                actionLoading[`${row.key}-start`] ||
                                                row.nodeId === "unassigned"
                                              }
                                            >
                                              {actionLoading[`${row.key}-start`] ? (
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                              ) : (
                                                <Play className="h-4 w-4 text-green-600" />
                                              )}
                                            </Button>
                                          )}
                                          {row.bridgeUrl && (
                                            <Button
                                              variant="ghost"
                                              size="sm"
                                              title="Open Web UI"
                                              asChild
                                            >
                                              <a
                                                href={row.bridgeUrl}
                                                target="_blank"
                                                rel="noreferrer"
                                              >
                                                <ExternalLink className="h-4 w-4" />
                                              </a>
                                            </Button>
                                          )}
                                        </div>
                                      </TableCell>
                                    </TableRow>
                                    {/* Expanded details row */}
                                    {isExpanded && (
                                      <TableRow
                                        key={`${row.key}-expanded`}
                                        className="bg-muted/20 hover:bg-muted/30"
                                      >
                                        <TableCell />
                                        <TableCell colSpan={7}>
                                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 py-2 text-xs">
                                            <div>
                                              <span className="text-muted-foreground">
                                                Docker Image
                                              </span>
                                              <p className="font-mono truncate">
                                                {row.dockerImage ?? "—"}
                                              </p>
                                            </div>
                                            <div>
                                              <span className="text-muted-foreground">VPN IP</span>
                                              <p className="font-mono">{row.headscaleIp ?? "—"}</p>
                                            </div>
                                            <div>
                                              <span className="text-muted-foreground">
                                                Bridge Port
                                              </span>
                                              <p className="font-mono">{row.bridgePort ?? "—"}</p>
                                            </div>
                                            <div>
                                              <span className="text-muted-foreground">
                                                Web UI Port
                                              </span>
                                              <p className="font-mono">{row.webUiPort ?? "—"}</p>
                                            </div>
                                            <div>
                                              <span className="text-muted-foreground">
                                                Health Reason
                                              </span>
                                              <p
                                                className={
                                                  row.liveHealthSeverity === "critical"
                                                    ? "text-red-500"
                                                    : row.liveHealthSeverity === "warning"
                                                      ? "text-amber-500"
                                                      : ""
                                                }
                                              >
                                                {row.liveHealthReason}
                                              </p>
                                            </div>
                                            <div>
                                              <span className="text-muted-foreground">Error</span>
                                              <p className="text-red-500 truncate">
                                                {row.errorMessage ?? "None"}
                                              </p>
                                            </div>
                                            <div>
                                              <span className="text-muted-foreground">Created</span>
                                              <p>
                                                {row.createdAt
                                                  ? new Date(row.createdAt).toLocaleString()
                                                  : "—"}
                                              </p>
                                            </div>
                                            <div>
                                              <span className="text-muted-foreground">
                                                Sandbox ID
                                              </span>
                                              <p className="font-mono truncate">
                                                {row.sandboxId ?? "—"}
                                              </p>
                                            </div>
                                            {/* SSH command */}
                                            <div className="col-span-2 md:col-span-4">
                                              <span className="text-muted-foreground">
                                                SSH Command
                                              </span>
                                              <div className="flex items-center gap-2 mt-1">
                                                <code className="bg-muted px-2 py-1 rounded text-xs font-mono">
                                                  ssh {row.sshUser}@{row.nodeHostname} -p{" "}
                                                  {row.sshPort} docker logs -f {row.containerName}
                                                </code>
                                                <Button
                                                  variant="ghost"
                                                  size="sm"
                                                  onClick={() =>
                                                    copyToClipboard(
                                                      `ssh ${row.sshUser}@${row.nodeHostname} -p ${row.sshPort} docker logs -f ${row.containerName}`,
                                                    )
                                                  }
                                                >
                                                  <Copy className="h-3 w-3" />
                                                </Button>
                                              </div>
                                            </div>
                                            {/* Quick links */}
                                            <div className="col-span-2 md:col-span-4 flex gap-2 pt-1">
                                              {row.bridgeUrl && (
                                                <Button variant="outline" size="sm" asChild>
                                                  <a
                                                    href={row.bridgeUrl}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                  >
                                                    <ExternalLink className="mr-1 h-3 w-3" /> Bridge
                                                    UI
                                                  </a>
                                                </Button>
                                              )}
                                              {row.healthUrl && (
                                                <Button variant="outline" size="sm" asChild>
                                                  <a
                                                    href={row.healthUrl}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                  >
                                                    <Activity className="mr-1 h-3 w-3" /> Health
                                                    Check
                                                  </a>
                                                </Button>
                                              )}
                                              {row.headscaleIp && row.webUiPort && (
                                                <Button variant="outline" size="sm" asChild>
                                                  <a
                                                    href={`http://${row.headscaleIp}:${row.webUiPort}`}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                  >
                                                    <ExternalLink className="mr-1 h-3 w-3" /> Agent
                                                    Web UI
                                                  </a>
                                                </Button>
                                              )}
                                              <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() =>
                                                  performContainerAction(row, "pull-image")
                                                }
                                                disabled={
                                                  actionLoading[`${row.key}-pull-image`] ||
                                                  row.nodeId === "unassigned"
                                                }
                                              >
                                                {actionLoading[`${row.key}-pull-image`] ? (
                                                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                                ) : (
                                                  <RefreshCw className="mr-1 h-3 w-3" />
                                                )}
                                                Pull Latest Image
                                              </Button>
                                            </div>
                                          </div>
                                        </TableCell>
                                      </TableRow>
                                    )}
                                  </>
                                );
                              })}
                            </TableBody>
                          </Table>
                        </div>
                      );
                    })}

                    {filteredContainerRows.length === 0 && (
                      <div className="text-center text-muted-foreground py-12">
                        {containerRows.length === 0
                          ? "No containers found. Infrastructure snapshot may still be loading."
                          : "No containers match the current filters."}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabErrorBoundary>
        </TabsContent>

        {/* ------------------------------------------------------------------ */}
        {/* MESH TAB                                                            */}
        {/* ------------------------------------------------------------------ */}
        <TabsContent value="mesh" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Headscale Mesh Network</CardTitle>
                <CardDescription>
                  VPN node connectivity via Tailscale-compatible Headscale
                </CardDescription>
              </div>
              <Button variant="outline" onClick={loadHeadscale} disabled={loadingHeadscale}>
                {loadingHeadscale ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Refresh
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              {loadingHeadscale && !headscale ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : headscale ? (
                <>
                  {/* Server status banner */}
                  <div className="flex items-center gap-3 rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3">
                    <Wifi className="h-5 w-5 text-green-500" />
                    <div>
                      <p className="text-sm font-medium text-green-700 dark:text-green-400">
                        Headscale server online
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Connected · User: {headscale.user} · Queried{" "}
                        {formatRelativeTime(headscale.queriedAt)}
                      </p>
                    </div>
                    <div className="ml-auto flex gap-4 text-sm">
                      <span>
                        <span className="font-semibold text-green-600">
                          {headscale.summary.online}
                        </span>
                        <span className="text-muted-foreground"> online</span>
                      </span>
                      <span>
                        <span className="font-semibold text-muted-foreground">
                          {headscale.summary.offline}
                        </span>
                        <span className="text-muted-foreground"> offline</span>
                      </span>
                    </div>
                  </div>

                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Given Name</TableHead>
                        <TableHead>IP Addresses</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Last Seen</TableHead>
                        <TableHead>Expiry</TableHead>
                        <TableHead>Tags</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {headscale.vpnNodes.map((vpn) => (
                        <TableRow key={vpn.id}>
                          <TableCell className="font-mono text-xs font-medium">
                            {vpn.name}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {vpn.givenName !== vpn.name ? vpn.givenName : "—"}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {vpn.ipAddresses.join(", ") || "—"}
                          </TableCell>
                          <TableCell>
                            {vpn.online ? (
                              <Badge className="gap-1 bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30">
                                <Wifi className="h-3 w-3" /> Online
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="gap-1">
                                <WifiOff className="h-3 w-3" /> Offline
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {formatRelativeTime(vpn.lastSeen)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {vpn.expiry
                              ? new Date(vpn.expiry).getFullYear() > 2099
                                ? "Never"
                                : new Date(vpn.expiry).toLocaleDateString()
                              : "—"}
                          </TableCell>
                          <TableCell>
                            {vpn.tags.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {vpn.tags.map((t) => (
                                  <Badge key={t} variant="outline" className="text-xs">
                                    {t}
                                  </Badge>
                                ))}
                              </div>
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                      {headscale.vpnNodes.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                            No VPN nodes registered in Headscale.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </>
              ) : (
                <div className="flex flex-col items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-8">
                  <WifiOff className="h-8 w-8 text-red-500" />
                  <p className="font-medium text-red-700 dark:text-red-400">
                    Headscale server unavailable
                  </p>
                  <p className="text-sm text-muted-foreground text-center">
                    Could not reach the Headscale API. Check HEADSCALE_API_KEY and server
                    connectivity.
                  </p>
                  <Button variant="outline" size="sm" onClick={loadHeadscale}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Retry
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* -------------------------------------------------------------------- */}
      {/* ADD NODE DIALOG                                                       */}
      {/* -------------------------------------------------------------------- */}
      <Dialog open={addNodeOpen} onOpenChange={setAddNodeOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Register Docker Node</DialogTitle>
            <DialogDescription>Add a new Docker execution node to the pool.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="nodeId">Node ID</Label>
              <Input
                id="nodeId"
                placeholder="node-01"
                value={addNodeForm.nodeId}
                onChange={(e) => setAddNodeForm((f) => ({ ...f, nodeId: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="hostname">Hostname / IP</Label>
              <Input
                id="hostname"
                placeholder="192.168.1.100"
                value={addNodeForm.hostname}
                onChange={(e) => setAddNodeForm((f) => ({ ...f, hostname: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="sshPort">SSH Port</Label>
                <Input
                  id="sshPort"
                  type="number"
                  min={1}
                  max={65535}
                  value={addNodeForm.sshPort}
                  onChange={(e) => setAddNodeForm((f) => ({ ...f, sshPort: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sshUser">SSH User</Label>
                <Input
                  id="sshUser"
                  placeholder="root"
                  value={addNodeForm.sshUser}
                  onChange={(e) => setAddNodeForm((f) => ({ ...f, sshUser: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="capacity">Container Capacity</Label>
              <Input
                id="capacity"
                type="number"
                min={1}
                value={addNodeForm.capacity}
                onChange={(e) => setAddNodeForm((f) => ({ ...f, capacity: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                Maximum number of containers this node can run.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddNodeOpen(false)}
              disabled={addNodeLoading}
            >
              Cancel
            </Button>
            <Button
              onClick={submitAddNode}
              disabled={addNodeLoading || !addNodeForm.nodeId || !addNodeForm.hostname}
            >
              {addNodeLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Register Node
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* -------------------------------------------------------------------- */}
      {/* EDIT NODE DIALOG                                                      */}
      {/* -------------------------------------------------------------------- */}
      <Dialog open={editNodeOpen} onOpenChange={setEditNodeOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Node: {editNodeTarget?.nodeId}</DialogTitle>
            <DialogDescription>Update node settings.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="editHostname">Hostname / IP</Label>
              <Input
                id="editHostname"
                value={editNodeForm.hostname}
                onChange={(e) => setEditNodeForm((f) => ({ ...f, hostname: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="editSshPort">SSH Port</Label>
                <Input
                  id="editSshPort"
                  type="number"
                  min={1}
                  max={65535}
                  value={editNodeForm.sshPort}
                  onChange={(e) => setEditNodeForm((f) => ({ ...f, sshPort: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="editCapacity">Capacity</Label>
                <Input
                  id="editCapacity"
                  type="number"
                  min={1}
                  value={editNodeForm.capacity}
                  onChange={(e) => setEditNodeForm((f) => ({ ...f, capacity: e.target.value }))}
                />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <input
                id="editEnabled"
                type="checkbox"
                className="h-4 w-4 rounded border-border"
                checked={editNodeForm.enabled}
                onChange={(e) => setEditNodeForm((f) => ({ ...f, enabled: e.target.checked }))}
              />
              <Label htmlFor="editEnabled">Node enabled</Label>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditNodeOpen(false)}
              disabled={editNodeLoading}
            >
              Cancel
            </Button>
            <Button onClick={submitEditNode} disabled={editNodeLoading}>
              {editNodeLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* -------------------------------------------------------------------- */}
      {/* DELETE NODE CONFIRM DIALOG                                            */}
      {/* -------------------------------------------------------------------- */}
      <Dialog open={!!deleteNodeTarget} onOpenChange={(open) => !open && setDeleteNodeTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Deregister Node</DialogTitle>
            <DialogDescription>
              Are you sure you want to deregister{" "}
              <span className="font-mono font-semibold">{deleteNodeTarget?.nodeId}</span>?
              {deleteNodeTarget && deleteNodeTarget.allocatedCount > 0 && (
                <span className="mt-1 block text-destructive">
                  ⚠ This node has {deleteNodeTarget.allocatedCount} active containers.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteNodeTarget(null)}
              disabled={deleteNodeLoading}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={submitDeleteNode} disabled={deleteNodeLoading}>
              {deleteNodeLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Deregister
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* -------------------------------------------------------------------- */}
      {/* CONTAINER LOGS DIALOG                                                 */}
      {/* -------------------------------------------------------------------- */}
      <Dialog open={logsOpen} onOpenChange={setLogsOpen}>
        <DialogContent className="max-w-4xl max-h-[85vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Logs: {logsTarget?.containerName}
            </DialogTitle>
            <DialogDescription>
              Node: {logsTarget?.nodeId ?? "unknown"}
              {logsTarget?.agentName && ` · Agent: ${logsTarget.agentName}`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 mb-2">
            <Label htmlFor="logLines" className="text-xs">
              Lines:
            </Label>
            <Input
              id="logLines"
              type="number"
              className="w-20 h-7 text-xs"
              value={logsLines}
              onChange={(e) => setLogsLines(e.target.value)}
              min={10}
              max={5000}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                logsTarget && viewContainerLogs(logsTarget, parseInt(logsLines, 10) || 200)
              }
              disabled={logsLoading}
            >
              {logsLoading ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3 w-3" />
              )}
              Reload
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => copyToClipboard(logsContent)}
              title="Copy logs"
            >
              <Copy className="h-3 w-3" />
            </Button>
          </div>
          <div className="max-h-[500px] overflow-auto rounded-md bg-muted/60 p-4">
            {logsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">
                {logsContent || "(no output)"}
              </pre>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLogsOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* -------------------------------------------------------------------- */}
      {/* CONTAINER DETAILS / INSPECT DIALOG                                    */}
      {/* -------------------------------------------------------------------- */}
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="max-w-4xl max-h-[85vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="h-4 w-4" />
              Container Details: {detailsTarget?.containerName}
            </DialogTitle>
            <DialogDescription>
              Node: {detailsTarget?.nodeId} · {detailsTarget?.nodeHostname}
            </DialogDescription>
          </DialogHeader>
          {detailsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-4 max-h-[60vh] overflow-auto">
              {/* Resource Usage */}
              {detailsResources && Object.keys(detailsResources).length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold mb-2">Resource Usage</h4>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {detailsResources.cpuPercent && (
                      <div className="rounded-md border p-3">
                        <p className="text-xs text-muted-foreground">CPU</p>
                        <p className="text-lg font-semibold">{detailsResources.cpuPercent}</p>
                      </div>
                    )}
                    {detailsResources.memUsage && (
                      <div className="rounded-md border p-3">
                        <p className="text-xs text-muted-foreground">Memory</p>
                        <p className="text-sm font-semibold">{detailsResources.memUsage}</p>
                        {detailsResources.memPercent && (
                          <p className="text-xs text-muted-foreground">
                            {detailsResources.memPercent} used
                          </p>
                        )}
                      </div>
                    )}
                    {detailsResources.netIO && (
                      <div className="rounded-md border p-3">
                        <p className="text-xs text-muted-foreground">Network I/O</p>
                        <p className="text-sm font-semibold">{detailsResources.netIO}</p>
                      </div>
                    )}
                    {detailsResources.blockIO && (
                      <div className="rounded-md border p-3">
                        <p className="text-xs text-muted-foreground">Block I/O</p>
                        <p className="text-sm font-semibold">{detailsResources.blockIO}</p>
                      </div>
                    )}
                    {detailsResources.pids && (
                      <div className="rounded-md border p-3">
                        <p className="text-xs text-muted-foreground">PIDs</p>
                        <p className="text-lg font-semibold">{detailsResources.pids}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Container Config */}
              {detailsData && (
                <div>
                  <h4 className="text-sm font-semibold mb-2">Container Configuration</h4>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                    <div>
                      <span className="text-muted-foreground">Image:</span>
                      <p className="font-mono">
                        {String(detailsData.Config?.Image ?? detailsData.Image ?? "—")}
                      </p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">State:</span>
                      <p>{String(detailsData.State?.Status ?? "—")}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Started:</span>
                      <p>
                        {detailsData.State?.StartedAt
                          ? new Date(detailsData.State.StartedAt).toLocaleString()
                          : "—"}
                      </p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Restart Count:</span>
                      <p>{String(detailsData.RestartCount ?? "—")}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Platform:</span>
                      <p>{String(detailsData.Platform ?? "—")}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Driver:</span>
                      <p>{String(detailsData.Driver ?? "—")}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Environment Variables */}
              {detailsData?.Config?.Env && (
                <div>
                  <h4 className="text-sm font-semibold mb-2">Environment Variables</h4>
                  <div className="max-h-[200px] overflow-auto rounded-md bg-muted/60 p-3">
                    <pre className="text-xs font-mono whitespace-pre-wrap">
                      {detailsData.Config.Env.map((env: string) => {
                        const [key] = env.split("=");
                        const isSensitive = /key|secret|password|token|api/i.test(key ?? "");
                        return isSensitive ? `${key}=****` : env;
                      }).join("\n")}
                    </pre>
                  </div>
                </div>
              )}

              {/* Port mappings */}
              {detailsData?.NetworkSettings?.Ports && (
                <div>
                  <h4 className="text-sm font-semibold mb-2">Port Mappings</h4>
                  <div className="text-xs font-mono space-y-1">
                    {Object.entries(detailsData.NetworkSettings.Ports).map(([port, bindings]) => (
                      <div key={port}>
                        <span className="text-muted-foreground">{port}</span>
                        {" → "}
                        {Array.isArray(bindings) && bindings.length > 0
                          ? bindings
                              .map(
                                (b: { HostIp?: string; HostPort?: string }) =>
                                  `${b.HostIp || "0.0.0.0"}:${b.HostPort}`,
                              )
                              .join(", ")
                          : "not mapped"}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Raw JSON (collapsed) — env vars masked to prevent leaking secrets */}
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Raw Docker Inspect JSON
                </summary>
                <div className="mt-2 max-h-[300px] overflow-auto rounded-md bg-muted/60 p-3">
                  <pre className="font-mono whitespace-pre-wrap">
                    {detailsData && JSON.stringify(maskInspectForDisplay(detailsData), null, 2)}
                  </pre>
                </div>
              </details>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailsOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* -------------------------------------------------------------------- */}
      {/* AUDIT RESULTS DIALOG                                                  */}
      {/* -------------------------------------------------------------------- */}
      <Dialog open={auditOpen} onOpenChange={setAuditOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bug className="h-4 w-4" />
              Container Audit Results
            </DialogTitle>
            <DialogDescription>
              Ghost containers (running on node but not in DB) and orphan records (in DB but not on
              node).
            </DialogDescription>
          </DialogHeader>
          {auditLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : auditResult ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Checked {auditResult.nodesChecked} node
                {auditResult.nodesChecked !== 1 ? "s" : ""}.
                {auditResult.message && ` ${auditResult.message}`}
              </p>
              {auditResult.auditedAt && (
                <span className="ml-2">· {formatRelativeTime(auditResult.auditedAt)}</span>
              )}

              <div>
                <h4 className="mb-2 text-sm font-medium flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  Ghost Containers (
                  {auditResult.ghostContainers.reduce((s, n) => s + n.names.length, 0)})
                  <span className="font-normal text-muted-foreground text-xs">
                    — running on node but not tracked in DB
                  </span>
                </h4>
                {auditResult.ghostContainers.length === 0 ? (
                  <p className="text-xs text-muted-foreground pl-6">None found ✓</p>
                ) : (
                  <div className="space-y-2">
                    {auditResult.ghostContainers.map((g) => (
                      <div
                        key={g.nodeId}
                        className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3"
                      >
                        <p className="text-xs font-medium text-muted-foreground mb-1">
                          Node: {g.nodeId} ({g.hostname})
                        </p>
                        {g.names.map((name) => (
                          <Badge key={name} variant="outline" className="mr-1 font-mono text-xs">
                            {name}
                          </Badge>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <h4 className="mb-2 text-sm font-medium flex items-center gap-2">
                  <XCircle className="h-4 w-4 text-red-500" />
                  Orphan DB Records ({auditResult.orphanRecords.length})
                  <span className="font-normal text-muted-foreground text-xs">
                    — in DB but not running on node
                  </span>
                </h4>
                {auditResult.orphanRecords.length === 0 ? (
                  <p className="text-xs text-muted-foreground pl-6">None found ✓</p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {auditResult.orphanRecords.map((r) => (
                      <Badge
                        key={r.id}
                        variant="outline"
                        className="font-mono text-xs text-red-600"
                      >
                        {r.containerName ?? r.id.slice(0, 8)}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAuditOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
