"use client";

import { useState, useEffect, useCallback } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import {
  Shield,
  Users,
  AlertTriangle,
  Ban,
  UserX,
  RefreshCw,
  Plus,
  Trash2,
  Eye,
  ChevronRight,
  Loader2,
  Search,
  Clock,
  Activity,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";

interface AdminOverview {
  recentViolations: Array<{
    id: string;
    userId: string;
    categories: string[];
    action: string;
    createdAt: string;
    messageText: string;
  }>;
  totalViolations: number;
  flaggedUsers: number;
  bannedUsers: number;
  adminCount: number;
  currentAdmin: {
    wallet: string;
    role: string;
  };
}

interface AdminUser {
  id: string;
  walletAddress: string;
  role: "super_admin" | "moderator" | "viewer";
  isActive: boolean;
  createdAt: string;
  notes?: string;
}

interface FlaggedUser {
  id: string;
  userId: string;
  status: string;
  totalViolations: number;
  warningCount: number;
  riskScore: number;
  bannedAt?: string;
  banReason?: string;
}

interface Violation {
  id: string;
  userId: string;
  roomId?: string;
  messageText: string;
  categories: string[];
  scores: Record<string, number>;
  action: string;
  createdAt: string;
}

export default function AdminPage() {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const router = useRouter();

  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [adminRole, setAdminRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [flaggedUsers, setFlaggedUsers] = useState<FlaggedUser[]>([]);
  const [bannedUsers, setBannedUsers] = useState<FlaggedUser[]>([]);
  const [violations, setViolations] = useState<Violation[]>([]);

  // Dialog states
  const [addAdminOpen, setAddAdminOpen] = useState(false);
  const [newAdminWallet, setNewAdminWallet] = useState("");
  const [newAdminRole, setNewAdminRole] = useState<
    "super_admin" | "moderator" | "viewer"
  >("moderator");
  const [actionLoading, setActionLoading] = useState(false);

  const [userDetailOpen, setUserDetailOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [userDetail, setUserDetail] = useState<{
    user: {
      id: string;
      email?: string;
      wallet_address?: string;
      name?: string;
      created_at: string;
    } | null;
    moderationStatus: FlaggedUser | null;
    violations: Violation[];
    generationsCount: number;
  } | null>(null);

  // Check admin status
  useEffect(() => {
    async function checkAdmin() {
      if (!ready || !authenticated) return;

      const response = await fetch("/api/v1/admin/moderation", {
        method: "HEAD",
      });

      // Check the X-Is-Admin header, not response.ok (HEAD always returns 200)
      const isAdminHeader = response.headers.get("X-Is-Admin") === "true";
      setIsAdmin(isAdminHeader);
      setAdminRole(response.headers.get("X-Admin-Role"));
      setLoading(false);
    }

    checkAdmin();
  }, [ready, authenticated]);

  // Load overview data
  const loadOverview = useCallback(async () => {
    const response = await fetch("/api/v1/admin/moderation?view=overview");
    if (!response.ok) {
      const error = await response.json();
      toast.error(`Failed to load overview: ${error.error}`);
      return;
    }
    setOverview(await response.json());
  }, []);

  // Load admins
  const loadAdmins = useCallback(async () => {
    const response = await fetch("/api/v1/admin/moderation?view=admins");
    if (!response.ok) {
      const error = await response.json();
      toast.error(`Failed to load admins: ${error.error}`);
      return;
    }
    const data = await response.json();
    setAdmins(data.admins);
  }, []);

  // Load users
  const loadUsers = useCallback(async () => {
    const response = await fetch("/api/v1/admin/moderation?view=users");
    if (!response.ok) {
      const error = await response.json();
      toast.error(`Failed to load users: ${error.error}`);
      return;
    }
    const data = await response.json();
    setFlaggedUsers(data.flaggedUsers);
    setBannedUsers(data.bannedUsers);
  }, []);

  // Load violations
  const loadViolations = useCallback(async () => {
    const response = await fetch(
      "/api/v1/admin/moderation?view=violations&limit=100",
    );
    if (!response.ok) {
      const error = await response.json();
      toast.error(`Failed to load violations: ${error.error}`);
      return;
    }
    const data = await response.json();
    setViolations(data.violations);
  }, []);

  // Load user detail
  const loadUserDetail = useCallback(async (userId: string) => {
    setSelectedUserId(userId);
    setUserDetailOpen(true);

    const response = await fetch(
      `/api/v1/admin/moderation?view=user-detail&userId=${userId}`,
    );
    if (!response.ok) {
      const error = await response.json();
      toast.error(`Failed to load user details: ${error.error}`);
      return;
    }
    setUserDetail(await response.json());
  }, []);

  // Initial load - use queueMicrotask to avoid setState in effect body
  useEffect(() => {
    if (isAdmin) {
      queueMicrotask(() => loadOverview());
    }
  }, [isAdmin, loadOverview]);

  // Action helpers
  async function performAction(
    action: string,
    data: Record<string, string | undefined>,
  ) {
    setActionLoading(true);

    const response = await fetch("/api/v1/admin/moderation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...data }),
    });

    setActionLoading(false);

    if (!response.ok) {
      const error = await response.json();
      toast.error(`Action failed: ${error.error}`);
      return false;
    }

    toast.success("Action completed successfully");
    loadOverview();
    loadUsers();
    loadViolations();
    if (action === "add_admin" || action === "revoke_admin") {
      loadAdmins();
    }
    return true;
  }

  // Loading state
  if (!ready || loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // Not authenticated
  if (!authenticated) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <Shield className="h-16 w-16 text-muted-foreground" />
        <h1 className="text-2xl font-bold">Admin Access Required</h1>
        <p className="text-muted-foreground">
          Please connect your wallet to access the admin panel.
        </p>
        <Button
          onClick={() =>
            router.push(
              `/login?returnTo=${encodeURIComponent("/dashboard/admin")}`,
            )
          }
        >
          Connect Wallet
        </Button>
      </div>
    );
  }

  // Not admin
  if (!isAdmin) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <Ban className="h-16 w-16 text-destructive" />
        <h1 className="text-2xl font-bold">Access Denied</h1>
        <p className="text-muted-foreground">
          You don&apos;t have admin privileges.
        </p>
        <p className="text-xs text-muted-foreground">
          Current wallet: {wallets[0]?.address?.slice(0, 10)}...
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Admin Panel</h1>
          <p className="text-muted-foreground">
            Moderation and user management • {adminRole}
          </p>
        </div>
        <Button variant="outline" onClick={loadOverview}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      {overview && (
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Total Violations
              </CardTitle>
              <AlertTriangle className="h-4 w-4 text-amber-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {overview.totalViolations}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Flagged Users
              </CardTitle>
              <UserX className="h-4 w-4 text-orange-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{overview.flaggedUsers}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Banned Users
              </CardTitle>
              <Ban className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{overview.bannedUsers}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Admins</CardTitle>
              <Shield className="h-4 w-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{overview.adminCount}</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Tabs */}
      <Tabs defaultValue="violations" className="space-y-4">
        <TabsList>
          <TabsTrigger value="violations" onClick={loadViolations}>
            <AlertTriangle className="mr-2 h-4 w-4" />
            Violations
          </TabsTrigger>
          <TabsTrigger value="users" onClick={loadUsers}>
            <Users className="mr-2 h-4 w-4" />
            Users
          </TabsTrigger>
          <TabsTrigger value="admins" onClick={loadAdmins}>
            <Shield className="mr-2 h-4 w-4" />
            Admins
          </TabsTrigger>
        </TabsList>

        {/* Violations Tab */}
        <TabsContent value="violations" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Recent Violations</CardTitle>
              <CardDescription>
                Content moderation violations detected by the system
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Categories</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Content</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {violations.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(v.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs">
                        {v.userId.slice(0, 8)}...
                      </TableCell>
                      <TableCell>
                        {v.categories.map((c) => (
                          <Badge
                            key={c}
                            variant="destructive"
                            className="mr-1 text-xs"
                          >
                            {c}
                          </Badge>
                        ))}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            v.action === "flagged_for_ban"
                              ? "destructive"
                              : "secondary"
                          }
                        >
                          {v.action}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate text-xs">
                        {v.messageText}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => loadUserDetail(v.userId)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {violations.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="text-center text-muted-foreground"
                      >
                        No violations found
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Users Tab */}
        <TabsContent value="users" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            {/* Flagged Users */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <UserX className="h-5 w-5 text-orange-500" />
                  Flagged Users
                </CardTitle>
                <CardDescription>
                  Users with violations requiring review
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {flaggedUsers.map((u) => (
                    <div
                      key={u.id}
                      className="flex items-center justify-between rounded-lg border p-3"
                    >
                      <div>
                        <p className="text-sm">{u.userId.slice(0, 12)}...</p>
                        <div className="flex gap-2 text-xs text-muted-foreground">
                          <span>{u.totalViolations} violations</span>
                          <span>•</span>
                          <span>Risk: {u.riskScore}</span>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => loadUserDetail(u.userId)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() =>
                            performAction("ban", {
                              userId: u.userId,
                              reason: "Admin review",
                            })
                          }
                        >
                          <Ban className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                  {flaggedUsers.length === 0 && (
                    <p className="text-center text-sm text-muted-foreground">
                      No flagged users
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Banned Users */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Ban className="h-5 w-5 text-red-500" />
                  Banned Users
                </CardTitle>
                <CardDescription>
                  Users currently banned from the platform
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {bannedUsers.map((u) => (
                    <div
                      key={u.id}
                      className="flex items-center justify-between rounded-lg border border-destructive/20 bg-destructive/5 p-3"
                    >
                      <div>
                        <p className="text-sm">{u.userId.slice(0, 12)}...</p>
                        <p className="text-xs text-muted-foreground">
                          {u.banReason || "No reason provided"}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          performAction("unban", { userId: u.userId })
                        }
                      >
                        Unban
                      </Button>
                    </div>
                  ))}
                  {bannedUsers.length === 0 && (
                    <p className="text-center text-sm text-muted-foreground">
                      No banned users
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Admins Tab */}
        <TabsContent value="admins" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Admin Users</CardTitle>
                <CardDescription>Manage admin privileges</CardDescription>
              </div>
              {adminRole === "super_admin" && (
                <Button onClick={() => setAddAdminOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Admin
                </Button>
              )}
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Wallet</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Added</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {admins.map((admin) => (
                    <TableRow key={admin.id}>
                      <TableCell className="text-sm">
                        {admin.walletAddress.slice(0, 10)}...
                        {admin.walletAddress.slice(-8)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            admin.role === "super_admin"
                              ? "default"
                              : admin.role === "moderator"
                                ? "secondary"
                                : "outline"
                          }
                        >
                          {admin.role}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(admin.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {admin.notes || "-"}
                      </TableCell>
                      <TableCell>
                        {adminRole === "super_admin" &&
                          admin.id !== "anvil-default" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                performAction("revoke_admin", {
                                  walletAddress: admin.walletAddress,
                                })
                              }
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Add Admin Dialog */}
      <Dialog open={addAdminOpen} onOpenChange={setAddAdminOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Admin</DialogTitle>
            <DialogDescription>
              Grant admin privileges to a wallet address
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Wallet Address</Label>
              <Input
                placeholder="0x..."
                value={newAdminWallet}
                onChange={(e) => setNewAdminWallet(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <Select
                value={newAdminRole}
                onValueChange={(v) => setNewAdminRole(v as typeof newAdminRole)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="super_admin">Super Admin</SelectItem>
                  <SelectItem value="moderator">Moderator</SelectItem>
                  <SelectItem value="viewer">Viewer</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddAdminOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                const success = await performAction("add_admin", {
                  walletAddress: newAdminWallet,
                  role: newAdminRole,
                });
                if (success) {
                  setAddAdminOpen(false);
                  setNewAdminWallet("");
                }
              }}
              disabled={actionLoading || !newAdminWallet}
            >
              {actionLoading && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Add Admin
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* User Detail Dialog */}
      <Dialog open={userDetailOpen} onOpenChange={setUserDetailOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>User Details</DialogTitle>
            <DialogDescription>
              Detailed information and moderation actions
            </DialogDescription>
          </DialogHeader>
          {userDetail ? (
            <div className="space-y-4">
              {/* User Info */}
              <div className="rounded-lg border p-4">
                <h4 className="font-medium mb-2">User Info</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">ID:</span>{" "}
                    <span>{userDetail.user?.id}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Email:</span>{" "}
                    {userDetail.user?.email || "-"}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Wallet:</span>{" "}
                    <span>
                      {userDetail.user?.wallet_address?.slice(0, 10)}...
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Generations:</span>{" "}
                    {userDetail.generationsCount}
                  </div>
                </div>
              </div>

              {/* Moderation Status */}
              {userDetail.moderationStatus && (
                <div className="rounded-lg border p-4">
                  <h4 className="font-medium mb-2">Moderation Status</h4>
                  <div className="flex flex-wrap gap-4 text-sm">
                    <Badge
                      variant={
                        userDetail.moderationStatus.status === "banned"
                          ? "destructive"
                          : "secondary"
                      }
                    >
                      {userDetail.moderationStatus.status}
                    </Badge>
                    <span>
                      Violations: {userDetail.moderationStatus.totalViolations}
                    </span>
                    <span>
                      Risk Score: {userDetail.moderationStatus.riskScore}
                    </span>
                  </div>
                </div>
              )}

              {/* Recent Violations */}
              <div className="rounded-lg border p-4">
                <h4 className="font-medium mb-2">
                  Recent Violations ({userDetail.violations.length})
                </h4>
                <div className="max-h-[200px] overflow-y-auto space-y-2">
                  {userDetail.violations.slice(0, 10).map((v) => (
                    <div key={v.id} className="text-sm border-b pb-2">
                      <div className="flex gap-2">
                        {v.categories.map((c) => (
                          <Badge
                            key={c}
                            variant="destructive"
                            className="text-xs"
                          >
                            {c}
                          </Badge>
                        ))}
                      </div>
                      <p className="text-muted-foreground truncate">
                        {v.messageText}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() =>
                    performAction("mark_spammer", { userId: selectedUserId! })
                  }
                  disabled={actionLoading}
                >
                  Mark as Spammer
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    performAction("mark_scammer", { userId: selectedUserId! })
                  }
                  disabled={actionLoading}
                >
                  Mark as Scammer
                </Button>
                <Button
                  variant="destructive"
                  onClick={() =>
                    performAction("ban", {
                      userId: selectedUserId!,
                      reason: "Admin review",
                    })
                  }
                  disabled={actionLoading}
                >
                  <Ban className="mr-2 h-4 w-4" />
                  Ban User
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
