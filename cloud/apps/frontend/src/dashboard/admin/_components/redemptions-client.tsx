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
} from "@elizaos/cloud-ui";
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
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

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

interface SystemStatus {
  operational: boolean;
  networks: Record<string, { available: boolean; balance?: string }>;
  wallets: {
    evm: { configured: boolean; address?: string };
    solana: { configured: boolean; address?: string };
  };
}

interface Stats {
  pending: number;
  approved: number;
  processing: number;
  completed: number;
  failed: number;
  totalPendingUsd: number;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  approved: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  processing: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  completed: "bg-green-500/20 text-green-400 border-green-500/30",
  failed: "bg-red-500/20 text-red-400 border-red-500/30",
  rejected: "bg-red-500/20 text-red-400 border-red-500/30",
};

const STATUS_OPTIONS = [
  { value: "all", label: "All Status" },
  { value: "pending", label: "Pending Review" },
  { value: "approved", label: "Approved" },
  { value: "processing", label: "Processing" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "rejected", label: "Rejected" },
];

export function AdminRedemptionsClient() {
  const [redemptions, setRedemptions] = useState<RedemptionData[]>([]);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  // Filters
  const [statusFilter, setStatusFilter] = useState("pending");
  const [networkFilter, setNetworkFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Action dialogs
  const [selectedRedemption, setSelectedRedemption] = useState<RedemptionData | null>(null);
  const [showDetailsDialog, setShowDetailsDialog] = useState(false);
  const [showApproveDialog, setShowApproveDialog] = useState(false);
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  // Fetch redemptions
  const fetchRedemptions = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (networkFilter !== "all") params.set("network", networkFilter);
    if (searchQuery) params.set("search", searchQuery);
    params.set("limit", "50");

    const res = await fetch(`/api/admin/redemptions?${params}`);
    if (res.ok) {
      const data = await res.json();
      setRedemptions(data.redemptions || []);
      setStats(data.stats || null);
    }
    setLoading(false);
  }, [statusFilter, networkFilter, searchQuery]);

  // Fetch system status
  const fetchSystemStatus = useCallback(async () => {
    const res = await fetch("/api/v1/redemptions/status");
    if (res.ok) {
      const data = await res.json();
      setSystemStatus(data);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (cancelled) return;
      await fetchRedemptions();
      await fetchSystemStatus();
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [fetchRedemptions, fetchSystemStatus]);

  // Approve redemption
  const handleApprove = async () => {
    if (!selectedRedemption) return;
    setActionLoading(true);

    const res = await fetch("/api/admin/redemptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redemptionId: selectedRedemption.id,
        action: "approve",
      }),
    });

    if (res.ok) {
      toast.success("Redemption approved", {
        description: "The redemption will be processed in the next batch.",
      });
      setShowApproveDialog(false);
      setSelectedRedemption(null);
      fetchRedemptions();
    } else {
      const error = await res.json();
      toast.error("Failed to approve", { description: error.error });
    }
    setActionLoading(false);
  };

  // Reject redemption
  const handleReject = async () => {
    if (!selectedRedemption || !rejectionReason.trim()) return;
    setActionLoading(true);

    const res = await fetch("/api/admin/redemptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redemptionId: selectedRedemption.id,
        action: "reject",
        reason: rejectionReason,
      }),
    });

    if (res.ok) {
      toast.success("Redemption rejected", {
        description: "The user's balance has been refunded.",
      });
      setShowRejectDialog(false);
      setSelectedRedemption(null);
      setRejectionReason("");
      fetchRedemptions();
    } else {
      const error = await res.json();
      toast.error("Failed to reject", { description: error.error });
    }
    setActionLoading(false);
  };

  const formatCurrency = (value: number | string) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(typeof value === "string" ? parseFloat(value) : value);
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
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
            <h3 className="text-lg font-semibold text-white">System Status</h3>
            <Badge
              className={
                systemStatus?.operational
                  ? "bg-green-500/20 text-green-400"
                  : "bg-red-500/20 text-red-400"
              }
            >
              {systemStatus?.operational ? "Operational" : "Limited"}
            </Badge>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-white/60">EVM Wallet</span>
              <span className="text-white font-mono text-xs">
                {systemStatus?.wallets?.evm?.configured
                  ? truncateAddress(systemStatus.wallets.evm.address || "")
                  : "Not configured"}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-white/60">Solana Wallet</span>
              <span className="text-white font-mono text-xs">
                {systemStatus?.wallets?.solana?.configured
                  ? truncateAddress(systemStatus.wallets.solana.address || "")
                  : "Not configured"}
              </span>
            </div>
          </div>
        </BrandCard>

        {/* Stats */}
        <BrandCard corners={false}>
          <h3 className="text-lg font-semibold text-white mb-4">Queue Stats</h3>
          <div className="grid grid-cols-3 gap-4">
            <div className="text-center">
              <p className="text-2xl font-bold text-yellow-400">{stats?.pending || 0}</p>
              <p className="text-xs text-white/60">Pending</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-purple-400">{stats?.processing || 0}</p>
              <p className="text-xs text-white/60">Processing</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-[#FF5800]">
                {formatCurrency(stats?.totalPendingUsd || 0)}
              </p>
              <p className="text-xs text-white/60">Pending Value</p>
            </div>
          </div>
        </BrandCard>
      </div>

      {/* Filters */}
      <BrandCard corners={false}>
        <div className="flex flex-wrap gap-4 items-center">
          <div className="flex-1 min-w-[200px]">
            <Input
              placeholder="Search by user ID or address..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-white/5 border-white/10 text-white"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[180px] bg-white/5 border-white/10 text-white">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent className="bg-zinc-900 border-white/10">
              {STATUS_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-white">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={networkFilter} onValueChange={setNetworkFilter}>
            <SelectTrigger className="w-[150px] bg-white/5 border-white/10 text-white">
              <SelectValue placeholder="Network" />
            </SelectTrigger>
            <SelectContent className="bg-zinc-900 border-white/10">
              <SelectItem value="all" className="text-white">
                All Networks
              </SelectItem>
              <SelectItem value="base" className="text-white">
                Base
              </SelectItem>
              <SelectItem value="solana" className="text-white">
                Solana
              </SelectItem>
              <SelectItem value="ethereum" className="text-white">
                Ethereum
              </SelectItem>
              <SelectItem value="bnb" className="text-white">
                BNB
              </SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              fetchRedemptions();
              fetchSystemStatus();
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
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        ) : redemptions.length === 0 ? (
          <div className="text-center py-12 text-white/40">
            <Wallet className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p>No redemptions found</p>
            <p className="text-sm">Try adjusting your filters</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-white/10">
                <TableHead className="text-white/60">Date</TableHead>
                <TableHead className="text-white/60">User</TableHead>
                <TableHead className="text-white/60">Amount</TableHead>
                <TableHead className="text-white/60">Network</TableHead>
                <TableHead className="text-white/60">Address</TableHead>
                <TableHead className="text-white/60">Status</TableHead>
                <TableHead className="text-white/60">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {redemptions.map((r) => (
                <TableRow key={r.id} className="border-white/10">
                  <TableCell className="text-white/80 text-sm">
                    {formatDate(r.created_at)}
                  </TableCell>
                  <TableCell>
                    <button
                      onClick={() => copyToClipboard(r.user_id)}
                      className="text-white/80 text-xs hover:text-[#FF5800] flex items-center gap-1"
                    >
                      {truncateAddress(r.user_id)}
                      <Copy className="h-3 w-3 opacity-50" />
                    </button>
                  </TableCell>
                  <TableCell>
                    <div>
                      <p className="text-white font-semibold">{formatCurrency(r.usd_value)}</p>
                      <p className="text-xs text-white/40">
                        {parseFloat(r.eliza_amount).toFixed(2)} elizaOS
                      </p>
                    </div>
                  </TableCell>
                  <TableCell className="capitalize text-white/80">{r.network}</TableCell>
                  <TableCell>
                    <button
                      onClick={() => copyToClipboard(r.payout_address)}
                      className="text-white/80 text-xs hover:text-[#FF5800] flex items-center gap-1"
                    >
                      {truncateAddress(r.payout_address)}
                      <Copy className="h-3 w-3 opacity-50" />
                    </button>
                  </TableCell>
                  <TableCell>
                    <Badge className={STATUS_COLORS[r.status] || STATUS_COLORS.pending}>
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
                          className="h-8 w-8 flex items-center justify-center text-[#FF5800] hover:text-[#FF5800]/80"
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
        <DialogContent className="sm:max-w-lg bg-zinc-900 border-white/10">
          <DialogHeader>
            <DialogTitle className="text-white">Redemption Details</DialogTitle>
          </DialogHeader>
          {selectedRedemption && (
            <div className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-white/40 mb-1">ID</p>
                  <p className="text-sm text-white font-mono break-all">{selectedRedemption.id}</p>
                </div>
                <div>
                  <p className="text-xs text-white/40 mb-1">Status</p>
                  <Badge className={STATUS_COLORS[selectedRedemption.status]}>
                    {selectedRedemption.status}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-white/40 mb-1">User ID</p>
                  <p className="text-sm text-white font-mono break-all">
                    {selectedRedemption.user_id}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-white/40 mb-1">Network</p>
                  <p className="text-sm text-white capitalize">{selectedRedemption.network}</p>
                </div>
                <div>
                  <p className="text-xs text-white/40 mb-1">USD Value</p>
                  <p className="text-sm text-white font-semibold">
                    {formatCurrency(selectedRedemption.usd_value)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-white/40 mb-1">elizaOS Amount</p>
                  <p className="text-sm text-[#FF5800] font-semibold">
                    {parseFloat(selectedRedemption.eliza_amount).toFixed(4)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-white/40 mb-1">Price</p>
                  <p className="text-sm text-white">
                    ${parseFloat(selectedRedemption.eliza_price_usd).toFixed(6)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-white/40 mb-1">Created</p>
                  <p className="text-sm text-white">{formatDate(selectedRedemption.created_at)}</p>
                </div>
              </div>
              <div>
                <p className="text-xs text-white/40 mb-1">Payout Address</p>
                <p className="text-sm text-white break-all">{selectedRedemption.payout_address}</p>
              </div>
              {selectedRedemption.tx_hash && (
                <div>
                  <p className="text-xs text-white/40 mb-1">Transaction Hash</p>
                  <a
                    href={getExplorerUrl(selectedRedemption.network, selectedRedemption.tx_hash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-[#FF5800] font-mono break-all hover:underline flex items-center gap-1"
                  >
                    {selectedRedemption.tx_hash}
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                </div>
              )}
              {selectedRedemption.failure_reason && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                  <p className="text-xs text-red-400 mb-1">Failure Reason</p>
                  <p className="text-sm text-red-400">{selectedRedemption.failure_reason}</p>
                </div>
              )}
              {selectedRedemption.rejection_reason && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                  <p className="text-xs text-red-400 mb-1">Rejection Reason</p>
                  <p className="text-sm text-red-400">{selectedRedemption.rejection_reason}</p>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDetailsDialog(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Approve Confirmation */}
      <AlertDialog open={showApproveDialog} onOpenChange={setShowApproveDialog}>
        <AlertDialogContent className="bg-zinc-900 border-white/10">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white">Approve Redemption?</AlertDialogTitle>
            <AlertDialogDescription className="text-white/60">
              This will approve the redemption of{" "}
              <span className="text-[#FF5800] font-semibold">
                {selectedRedemption && formatCurrency(selectedRedemption.usd_value)}
              </span>{" "}
              ({selectedRedemption && parseFloat(selectedRedemption.eliza_amount).toFixed(2)}{" "}
              elizaOS) to{" "}
              <span className="font-mono text-white">
                {selectedRedemption && truncateAddress(selectedRedemption.payout_address)}
              </span>{" "}
              on {selectedRedemption?.network}.
              <br />
              <br />
              The tokens will be sent in the next processing batch.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-white/60">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleApprove}
              disabled={actionLoading}
              className="bg-green-600 hover:bg-green-700"
            >
              {actionLoading ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <CheckCircle className="mr-2 h-4 w-4" />
                  Approve
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reject Dialog */}
      <Dialog open={showRejectDialog} onOpenChange={setShowRejectDialog}>
        <DialogContent className="sm:max-w-md bg-zinc-900 border-white/10">
          <DialogHeader>
            <DialogTitle className="text-white">Reject Redemption</DialogTitle>
            <DialogDescription className="text-white/60">
              The user&apos;s balance will be refunded. Please provide a reason.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Textarea
              placeholder="Reason for rejection (required)"
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              className="bg-white/5 border-white/10 text-white min-h-[100px]"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowRejectDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleReject}
              disabled={actionLoading || !rejectionReason.trim()}
              className="bg-red-600 hover:bg-red-700"
            >
              {actionLoading ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <XCircle className="mr-2 h-4 w-4" />
                  Reject & Refund
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
