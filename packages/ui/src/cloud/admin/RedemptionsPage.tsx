/**
 * /dashboard/admin/redemptions — review and approve token redemption requests.
 *
 * The redemption queue + payout system status come from the admin redemptions
 * endpoint (`/api/admin/redemptions`) and the public redemptions status probe
 * (`/api/v1/redemptions/status`). The route-level {@link AdminGate} owns the
 * role gate; this body assumes it is past the gate.
 */

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
  BrandCard,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@elizaos/ui/cloud-ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Check,
  CheckCircle,
  Copy,
  ExternalLink,
  Eye,
  RefreshCw,
  Wallet,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "../lib/api-client";
import { formatUsd as formatCurrency } from "../lib/format-usd";
import { useDocumentTitle } from "../lib/use-document-title";
import { useCloudT } from "../shell/CloudI18nProvider";

type TFn = ReturnType<typeof useCloudT>;

interface RedemptionData {
  id: string;
  user_id: string;
  status: string;
  usd_value: string;
  eliza_amount: string;
  eliza_price_usd: string;
  network: string;
  payout_address: string;
  created_at: string;
  updated_at: string;
  approved_at?: string;
  approved_by?: string;
  completed_at?: string;
  rejected_at?: string;
  rejected_by?: string;
  rejection_reason?: string;
  tx_hash?: string;
  failure_reason?: string;
  metadata?: Record<string, unknown>;
}

interface RedemptionStats {
  pending: number;
  approved: number;
  processing: number;
  completed: number;
  failed: number;
  totalPendingUsd: number;
}

interface RedemptionsListResponse {
  redemptions?: RedemptionData[];
  stats?: RedemptionStats | null;
}

interface SystemStatus {
  operational: boolean;
  networks: Record<string, { available: boolean; balance?: string }>;
  wallets: {
    evm: { configured: boolean; address?: string };
    solana: { configured: boolean; address?: string };
  };
}

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  approved: "bg-white/10 text-white/80 border-white/20",
  processing: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  completed: "bg-green-500/20 text-green-400 border-green-500/30",
  failed: "bg-red-500/20 text-red-400 border-red-500/30",
  rejected: "bg-red-500/20 text-red-400 border-red-500/30",
};

const buildStatusOptions = (t: TFn) => [
  {
    value: "all",
    label: t("cloud.redemptions.statusAll", { defaultValue: "All Status" }),
  },
  {
    value: "pending",
    label: t("cloud.redemptions.statusPendingReview", {
      defaultValue: "Pending Review",
    }),
  },
  {
    value: "approved",
    label: t("cloud.redemptions.statusApproved", { defaultValue: "Approved" }),
  },
  {
    value: "processing",
    label: t("cloud.redemptions.statusProcessing", {
      defaultValue: "Processing",
    }),
  },
  {
    value: "completed",
    label: t("cloud.redemptions.statusCompleted", {
      defaultValue: "Completed",
    }),
  },
  {
    value: "failed",
    label: t("cloud.redemptions.statusFailed", { defaultValue: "Failed" }),
  },
  {
    value: "rejected",
    label: t("cloud.redemptions.statusRejected", { defaultValue: "Rejected" }),
  },
];

export default function RedemptionsPage(): React.JSX.Element {
  const t = useCloudT();
  useDocumentTitle(
    t("cloud.admin.redemptionsPage.metaTitle", {
      defaultValue: "Admin: Redemption Management · Eliza Cloud",
    }),
  );
  const queryClient = useQueryClient();
  const STATUS_OPTIONS = buildStatusOptions(t);

  // Filters
  const [statusFilter, setStatusFilter] = useState("pending");
  const [networkFilter, setNetworkFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Action dialogs
  const [selectedRedemption, setSelectedRedemption] =
    useState<RedemptionData | null>(null);
  const [showDetailsDialog, setShowDetailsDialog] = useState(false);
  const [showApproveDialog, setShowApproveDialog] = useState(false);
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");

  const redemptionsKey = [
    "admin",
    "redemptions",
    statusFilter,
    networkFilter,
    searchQuery,
  ] as const;

  const { data, isFetching, refetch } = useQuery<RedemptionsListResponse>({
    queryKey: redemptionsKey,
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (networkFilter !== "all") params.set("network", networkFilter);
      if (searchQuery) params.set("search", searchQuery);
      params.set("limit", "50");
      return api<RedemptionsListResponse>(`/api/admin/redemptions?${params}`);
    },
  });
  const redemptions = data?.redemptions ?? [];
  const stats = data?.stats ?? null;
  const loading = isFetching;

  const { data: systemStatus, refetch: refetchStatus } = useQuery<SystemStatus>(
    {
      queryKey: ["admin", "redemptions", "status"],
      queryFn: () => api<SystemStatus>("/api/v1/redemptions/status"),
    },
  );

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["admin", "redemptions"] });

  const approveMutation = useMutation({
    mutationFn: (redemptionId: string) =>
      api("/api/admin/redemptions", {
        method: "POST",
        json: { redemptionId, action: "approve" },
      }),
    onSuccess: () => {
      toast.success(
        t("cloud.redemptions.approvedTitle", {
          defaultValue: "Redemption approved",
        }),
        {
          description: t("cloud.redemptions.approvedDescription", {
            defaultValue: "The redemption will be processed in the next batch.",
          }),
        },
      );
      setShowApproveDialog(false);
      setSelectedRedemption(null);
      invalidate();
    },
    onError: (error) => {
      toast.error(
        t("cloud.redemptions.approveFailed", {
          defaultValue: "Failed to approve",
        }),
        {
          description:
            error instanceof ApiError
              ? error.message
              : error instanceof Error
                ? error.message
                : undefined,
        },
      );
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api("/api/admin/redemptions", {
        method: "POST",
        json: { redemptionId: id, action: "reject", reason },
      }),
    onSuccess: () => {
      toast.success(
        t("cloud.redemptions.rejectedTitle", {
          defaultValue: "Redemption rejected",
        }),
        {
          description: t("cloud.redemptions.rejectedDescription", {
            defaultValue: "The user's balance has been refunded.",
          }),
        },
      );
      setShowRejectDialog(false);
      setSelectedRedemption(null);
      setRejectionReason("");
      invalidate();
    },
    onError: (error) => {
      toast.error(
        t("cloud.redemptions.rejectFailed", {
          defaultValue: "Failed to reject",
        }),
        {
          description:
            error instanceof ApiError
              ? error.message
              : error instanceof Error
                ? error.message
                : undefined,
        },
      );
    },
  });

  const actionLoading = approveMutation.isPending || rejectMutation.isPending;

  const handleApprove = () => {
    if (!selectedRedemption) return;
    approveMutation.mutate(selectedRedemption.id);
  };

  const handleReject = () => {
    if (!selectedRedemption || !rejectionReason.trim()) return;
    rejectMutation.mutate({
      id: selectedRedemption.id,
      reason: rejectionReason,
    });
  };

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success(
      t("cloud.redemptions.copiedToClipboard", {
        defaultValue: "Copied to clipboard",
      }),
    );
  };

  const getExplorerUrl = (network: string, txHash: string) => {
    const explorers: Record<string, string> = {
      base: `https://basescan.org/tx/${txHash}`,
      ethereum: `https://etherscan.io/tx/${txHash}`,
      bnb: `https://bscscan.com/tx/${txHash}`,
      solana: `https://solscan.io/tx/${txHash}`,
    };
    return explorers[network] || "#";
  };

  const truncateAddress = (address: string) => {
    if (!address) return "-";
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  return (
    <div className="flex flex-col gap-6 max-w-7xl mx-auto">
      {/* System Status */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <BrandCard corners={false}>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-txt-strong">
              {t("cloud.redemptions.systemStatus", {
                defaultValue: "System Status",
              })}
            </h3>
            <Badge
              className={
                systemStatus?.operational
                  ? "bg-green-500/20 text-green-400"
                  : "bg-red-500/20 text-red-400"
              }
            >
              {systemStatus?.operational
                ? t("cloud.redemptions.operational", {
                    defaultValue: "Operational",
                  })
                : t("cloud.redemptions.limited", { defaultValue: "Limited" })}
            </Badge>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {t("cloud.redemptions.evmWallet", {
                  defaultValue: "EVM Wallet",
                })}
              </span>
              <span className="text-txt-strong font-mono text-xs">
                {systemStatus?.wallets?.evm?.configured
                  ? truncateAddress(systemStatus.wallets.evm.address || "")
                  : t("cloud.redemptions.notConfigured", {
                      defaultValue: "Not configured",
                    })}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {t("cloud.redemptions.solanaWallet", {
                  defaultValue: "Solana Wallet",
                })}
              </span>
              <span className="text-txt-strong font-mono text-xs">
                {systemStatus?.wallets?.solana?.configured
                  ? truncateAddress(systemStatus.wallets.solana.address || "")
                  : t("cloud.redemptions.notConfigured", {
                      defaultValue: "Not configured",
                    })}
              </span>
            </div>
          </div>
        </BrandCard>

        {/* Stats */}
        <BrandCard corners={false}>
          <h3 className="text-lg font-semibold text-txt-strong mb-4">
            {t("cloud.redemptions.queueStats", { defaultValue: "Queue Stats" })}
          </h3>
          <div className="grid grid-cols-3 gap-4">
            <div className="text-center">
              <p className="text-2xl font-bold text-yellow-400">
                {stats?.pending || 0}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("cloud.redemptions.pending", { defaultValue: "Pending" })}
              </p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-purple-400">
                {stats?.processing || 0}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("cloud.redemptions.processing", {
                  defaultValue: "Processing",
                })}
              </p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-accent">
                {formatCurrency(stats?.totalPendingUsd || 0)}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("cloud.redemptions.pendingValue", {
                  defaultValue: "Pending Value",
                })}
              </p>
            </div>
          </div>
        </BrandCard>
      </div>

      {/* Filters */}
      <BrandCard corners={false}>
        <div className="flex flex-wrap gap-4 items-center">
          <div className="flex-1 min-w-[200px]">
            <Input
              placeholder={t("cloud.redemptions.searchPlaceholder", {
                defaultValue: "Search by user ID or address...",
              })}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue
                placeholder={t("cloud.redemptions.filterByStatus", {
                  defaultValue: "Filter by status",
                })}
              />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={networkFilter} onValueChange={setNetworkFilter}>
            <SelectTrigger className="w-[150px]">
              <SelectValue
                placeholder={t("cloud.redemptions.network", {
                  defaultValue: "Network",
                })}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {t("cloud.redemptions.allNetworks", {
                  defaultValue: "All Networks",
                })}
              </SelectItem>
              <SelectItem value="base">
                {t("cloud.redemptions.networkBase", { defaultValue: "Base" })}
              </SelectItem>
              <SelectItem value="solana">
                {t("cloud.redemptions.networkSolana", {
                  defaultValue: "Solana",
                })}
              </SelectItem>
              <SelectItem value="ethereum">
                {t("cloud.redemptions.networkEthereum", {
                  defaultValue: "Ethereum",
                })}
              </SelectItem>
              <SelectItem value="bnb">
                {t("cloud.redemptions.networkBnb", { defaultValue: "BNB" })}
              </SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              refetch();
              refetchStatus();
            }}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </BrandCard>

      {/* Redemptions Table */}
      <BrandCard corners={false}>
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-16 rounded-sm" />
            ))}
          </div>
        ) : redemptions.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Wallet className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p>
              {t("cloud.redemptions.noRedemptions", {
                defaultValue: "No redemptions found",
              })}
            </p>
            <p className="text-sm">
              {t("cloud.redemptions.adjustFilters", {
                defaultValue: "Try adjusting your filters",
              })}
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("cloud.redemptions.colDate", { defaultValue: "Date" })}
                </TableHead>
                <TableHead>
                  {t("cloud.redemptions.colUser", { defaultValue: "User" })}
                </TableHead>
                <TableHead>
                  {t("cloud.redemptions.colAmount", { defaultValue: "Amount" })}
                </TableHead>
                <TableHead>
                  {t("cloud.redemptions.colNetwork", {
                    defaultValue: "Network",
                  })}
                </TableHead>
                <TableHead>
                  {t("cloud.redemptions.colAddress", {
                    defaultValue: "Address",
                  })}
                </TableHead>
                <TableHead>
                  {t("cloud.redemptions.colStatus", { defaultValue: "Status" })}
                </TableHead>
                <TableHead>
                  {t("cloud.redemptions.colActions", {
                    defaultValue: "Actions",
                  })}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {redemptions.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-sm">
                    {formatDate(r.created_at)}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => copyToClipboard(r.user_id)}
                      className="text-xs text-muted-foreground hover:text-txt-strong flex items-center gap-1"
                    >
                      {truncateAddress(r.user_id)}
                      <Copy className="h-3 w-3 opacity-50" />
                    </Button>
                  </TableCell>
                  <TableCell>
                    <div>
                      <p className="text-txt-strong font-semibold">
                        {formatCurrency(r.usd_value)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {Number.parseFloat(r.eliza_amount).toFixed(2)} elizaOS
                      </p>
                    </div>
                  </TableCell>
                  <TableCell className="capitalize">{r.network}</TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => copyToClipboard(r.payout_address)}
                      className="text-xs text-muted-foreground hover:text-txt-strong flex items-center gap-1"
                    >
                      {truncateAddress(r.payout_address)}
                      <Copy className="h-3 w-3 opacity-50" />
                    </Button>
                  </TableCell>
                  <TableCell>
                    <Badge
                      className={
                        STATUS_COLORS[r.status] || STATUS_COLORS.pending
                      }
                    >
                      {r.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => {
                          setSelectedRedemption(r);
                          setShowDetailsDialog(true);
                        }}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      {r.status === "pending" && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-green-400 hover:text-green-300"
                            onClick={() => {
                              setSelectedRedemption(r);
                              setShowApproveDialog(true);
                            }}
                          >
                            <Check className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-red-400 hover:text-red-300"
                            onClick={() => {
                              setSelectedRedemption(r);
                              setShowRejectDialog(true);
                            }}
                          >
                            <Ban className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                      {r.tx_hash && (
                        <a
                          href={getExplorerUrl(r.network, r.tx_hash)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="h-8 w-8 flex items-center justify-center text-muted-foreground hover:text-txt-strong transition-colors"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </BrandCard>

      {/* Details Dialog */}
      <Dialog open={showDetailsDialog} onOpenChange={setShowDetailsDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t("cloud.redemptions.detailsTitle", {
                defaultValue: "Redemption Details",
              })}
            </DialogTitle>
          </DialogHeader>
          {selectedRedemption && (
            <div className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">
                    {t("cloud.redemptions.labelId", { defaultValue: "ID" })}
                  </p>
                  <p className="text-sm font-mono break-all">
                    {selectedRedemption.id}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">
                    {t("cloud.redemptions.labelStatus", {
                      defaultValue: "Status",
                    })}
                  </p>
                  <Badge className={STATUS_COLORS[selectedRedemption.status]}>
                    {selectedRedemption.status}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">
                    {t("cloud.redemptions.labelUserId", {
                      defaultValue: "User ID",
                    })}
                  </p>
                  <p className="text-sm font-mono break-all">
                    {selectedRedemption.user_id}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">
                    {t("cloud.redemptions.labelNetwork", {
                      defaultValue: "Network",
                    })}
                  </p>
                  <p className="text-sm capitalize">
                    {selectedRedemption.network}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">
                    {t("cloud.redemptions.labelUsdValue", {
                      defaultValue: "USD Value",
                    })}
                  </p>
                  <p className="text-sm font-semibold">
                    {formatCurrency(selectedRedemption.usd_value)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">
                    {t("cloud.redemptions.labelElizaAmount", {
                      defaultValue: "elizaOS Amount",
                    })}
                  </p>
                  <p className="text-sm text-accent font-semibold">
                    {Number.parseFloat(selectedRedemption.eliza_amount).toFixed(
                      4,
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">
                    {t("cloud.redemptions.labelPrice", {
                      defaultValue: "Price",
                    })}
                  </p>
                  <p className="text-sm">
                    $
                    {Number.parseFloat(
                      selectedRedemption.eliza_price_usd,
                    ).toFixed(6)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">
                    {t("cloud.redemptions.labelCreated", {
                      defaultValue: "Created",
                    })}
                  </p>
                  <p className="text-sm">
                    {formatDate(selectedRedemption.created_at)}
                  </p>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">
                  {t("cloud.redemptions.labelPayoutAddress", {
                    defaultValue: "Payout Address",
                  })}
                </p>
                <p className="text-sm break-all">
                  {selectedRedemption.payout_address}
                </p>
              </div>
              {selectedRedemption.tx_hash && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">
                    {t("cloud.redemptions.labelTxHash", {
                      defaultValue: "Transaction Hash",
                    })}
                  </p>
                  <a
                    href={getExplorerUrl(
                      selectedRedemption.network,
                      selectedRedemption.tx_hash,
                    )}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-accent font-mono break-all hover:underline flex items-center gap-1"
                  >
                    {selectedRedemption.tx_hash}
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                </div>
              )}
              {selectedRedemption.failure_reason && (
                <div className="p-3 rounded-sm bg-red-500/10 border border-red-500/30">
                  <p className="text-xs text-red-400 mb-1">
                    {t("cloud.redemptions.labelFailureReason", {
                      defaultValue: "Failure Reason",
                    })}
                  </p>
                  <p className="text-sm text-red-400">
                    {selectedRedemption.failure_reason}
                  </p>
                </div>
              )}
              {selectedRedemption.rejection_reason && (
                <div className="p-3 rounded-sm bg-red-500/10 border border-red-500/30">
                  <p className="text-xs text-red-400 mb-1">
                    {t("cloud.redemptions.labelRejectionReason", {
                      defaultValue: "Rejection Reason",
                    })}
                  </p>
                  <p className="text-sm text-red-400">
                    {selectedRedemption.rejection_reason}
                  </p>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDetailsDialog(false)}>
              {t("cloud.redemptions.close", { defaultValue: "Close" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Approve Confirmation */}
      <AlertDialog open={showApproveDialog} onOpenChange={setShowApproveDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("cloud.redemptions.approveQuestion", {
                defaultValue: "Approve Redemption?",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("cloud.redemptions.approveIntro", {
                defaultValue: "This will approve the redemption of",
              })}{" "}
              <span className="text-accent font-semibold">
                {selectedRedemption &&
                  formatCurrency(selectedRedemption.usd_value)}
              </span>{" "}
              (
              {selectedRedemption &&
                Number.parseFloat(selectedRedemption.eliza_amount).toFixed(
                  2,
                )}{" "}
              {t("cloud.redemptions.elizaToken", { defaultValue: "elizaOS" })}){" "}
              {t("cloud.redemptions.approveTo", { defaultValue: "to" })}{" "}
              <span className="font-mono text-txt-strong">
                {selectedRedemption &&
                  truncateAddress(selectedRedemption.payout_address)}
              </span>{" "}
              {t("cloud.redemptions.approveOn", {
                network: selectedRedemption?.network ?? "",
                defaultValue: "on {{network}}.",
              })}
              <br />
              <br />
              {t("cloud.redemptions.approveBatchNote", {
                defaultValue:
                  "The tokens will be sent in the next processing batch.",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("cloud.redemptions.cancel", { defaultValue: "Cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleApprove} disabled={actionLoading}>
              {actionLoading ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <CheckCircle className="mr-2 h-4 w-4" />
                  {t("cloud.redemptions.approve", { defaultValue: "Approve" })}
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reject Dialog */}
      <Dialog open={showRejectDialog} onOpenChange={setShowRejectDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("cloud.redemptions.rejectTitle", {
                defaultValue: "Reject Redemption",
              })}
            </DialogTitle>
            <DialogDescription>
              {t("cloud.redemptions.rejectDescription", {
                defaultValue:
                  "The user's balance will be refunded. Please provide a reason.",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Textarea
              placeholder={t("cloud.redemptions.rejectReasonPlaceholder", {
                defaultValue: "Reason for rejection (required)",
              })}
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              className="min-h-[100px]"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowRejectDialog(false)}>
              {t("cloud.redemptions.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={actionLoading || !rejectionReason.trim()}
            >
              {actionLoading ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <XCircle className="mr-2 h-4 w-4" />
                  {t("cloud.redemptions.rejectAndRefund", {
                    defaultValue: "Reject & Refund",
                  })}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
