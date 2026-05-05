import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DashboardStatCard,
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
} from "@elizaos/cloud-ui";
import {
  AlertTriangle,
  Ban,
  Eye,
  Loader2,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  Users,
  UserX,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import { toast } from "sonner";
import type {
  AdminModerationActionName,
  AdminModerationActionRequest,
  AdminModerationAdminsResponse,
  AdminModerationCombinedResponse,
  AdminModerationOverviewResponse,
  AdminModerationUserDetailResponse,
  AdminModerationUserStatusDto,
  AdminModerationUsersResponse,
  AdminModerationViolationDto,
  AdminModerationViolationsResponse,
  AdminRole,
  AdminUserDto,
} from "@/lib/types/cloud-api";
import { ApiError, api } from "../../lib/api-client";
import { useAdminModerationStatus } from "../../lib/data/admin";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "Request failed";
}

function isAdminRole(value: string): value is AdminRole {
  return value === "super_admin" || value === "moderator" || value === "viewer";
}

export default function AdminPage() {
  const { data: status } = useAdminModerationStatus();
  const adminRole = status?.role ?? null;

  const [overview, setOverview] = useState<AdminModerationOverviewResponse | null>(null);
  const [admins, setAdmins] = useState<AdminUserDto[]>([]);
  const [flaggedUsers, setFlaggedUsers] = useState<AdminModerationUserStatusDto[]>([]);
  const [bannedUsers, setBannedUsers] = useState<AdminModerationUserStatusDto[]>([]);
  const [violations, setViolations] = useState<AdminModerationViolationDto[]>([]);

  const [addAdminOpen, setAddAdminOpen] = useState(false);
  const [newAdminWallet, setNewAdminWallet] = useState("");
  const [newAdminRole, setNewAdminRole] = useState<AdminRole>("moderator");
  const [actionLoading, setActionLoading] = useState(false);

  const [userDetailOpen, setUserDetailOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [userDetail, setUserDetail] = useState<AdminModerationUserDetailResponse | null>(null);

  const loadAdmins = useCallback(async () => {
    try {
      const data = await api<AdminModerationAdminsResponse>("/api/v1/admin/moderation?view=admins");
      setAdmins(data.admins);
    } catch (error) {
      toast.error(`Failed to load admins: ${errorMessage(error)}`);
    }
  }, []);

  const loadUsers = useCallback(async () => {
    try {
      const data = await api<AdminModerationUsersResponse>("/api/v1/admin/moderation?view=users");
      setFlaggedUsers(data.flaggedUsers);
      setBannedUsers(data.bannedUsers);
    } catch (error) {
      toast.error(`Failed to load users: ${errorMessage(error)}`);
    }
  }, []);

  const loadViolations = useCallback(async () => {
    try {
      const data = await api<AdminModerationViolationsResponse>(
        "/api/v1/admin/moderation?view=violations&limit=100",
      );
      setViolations(data.violations);
    } catch (error) {
      toast.error(`Failed to load violations: ${errorMessage(error)}`);
    }
  }, []);

  // Initial load: pull all four panels in a single round trip via the
  // multi-view endpoint. Per-tab refresh still issues targeted calls when the
  // user explicitly clicks a tab, so the slim DTOs keep doing their job.
  const loadAll = useCallback(async () => {
    try {
      const data = await api<AdminModerationCombinedResponse>(
        "/api/v1/admin/moderation?view=overview,admins,users,violations&limit=100",
      );
      if (data.overview) setOverview(data.overview);
      if (data.admins) setAdmins(data.admins.admins);
      if (data.users) {
        setFlaggedUsers(data.users.flaggedUsers);
        setBannedUsers(data.users.bannedUsers);
      }
      if (data.violations) setViolations(data.violations.violations);
    } catch (error) {
      toast.error(`Failed to load admin panel: ${errorMessage(error)}`);
    }
  }, []);

  const loadUserDetail = useCallback(async (userId: string) => {
    setSelectedUserId(userId);
    setUserDetailOpen(true);
    try {
      setUserDetail(
        await api<AdminModerationUserDetailResponse>(
          `/api/v1/admin/moderation?view=user-detail&userId=${encodeURIComponent(userId)}`,
        ),
      );
    } catch (error) {
      toast.error(`Failed to load user details: ${errorMessage(error)}`);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => loadAll());
  }, [loadAll]);

  async function performAction(
    action: AdminModerationActionName,
    data: Omit<AdminModerationActionRequest, "action">,
  ) {
    setActionLoading(true);
    try {
      await api("/api/v1/admin/moderation", {
        method: "POST",
        json: { action, ...data } satisfies AdminModerationActionRequest,
      });
    } catch (error) {
      toast.error(`Action failed: ${errorMessage(error)}`);
      return false;
    } finally {
      setActionLoading(false);
    }

    toast.success("Action completed successfully");
    loadAll();
    return true;
  }

  return (
    <>
      <Helmet>
        <title>Admin Panel</title>
        <meta
          name="description"
          content="Admin moderation panel for managing users, reviewing violations, and configuring platform settings."
        />
      </Helmet>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Admin Panel</h1>
            <p className="text-muted-foreground">Moderation and user management • {adminRole}</p>
          </div>
          <Button variant="outline" onClick={loadAll}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>

        {overview && (
          <div className="grid gap-4 md:grid-cols-4">
            <DashboardStatCard
              label="Total Violations"
              value={overview.totalViolations}
              icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
              accent="amber"
            />
            <DashboardStatCard
              label="Flagged Users"
              value={overview.flaggedUsers}
              icon={<UserX className="h-4 w-4 text-[#FF5800]" />}
              accent="orange"
            />
            <DashboardStatCard
              label="Banned Users"
              value={overview.bannedUsers}
              icon={<Ban className="h-4 w-4 text-red-500" />}
              accent="red"
            />
            <DashboardStatCard
              label="Admins"
              value={overview.adminCount}
              icon={<Shield className="h-4 w-4 text-blue-400" />}
              accent="blue"
            />
          </div>
        )}

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
                        <TableCell className="text-xs">{v.userId.slice(0, 8)}...</TableCell>
                        <TableCell>
                          {v.categories.map((c) => (
                            <Badge key={c} variant="destructive" className="mr-1 text-xs">
                              {c}
                            </Badge>
                          ))}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={v.action === "flagged_for_ban" ? "destructive" : "secondary"}
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
                        <TableCell colSpan={6} className="text-center text-muted-foreground">
                          No violations found
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="users" className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <UserX className="h-5 w-5 text-orange-500" />
                    Flagged Users
                  </CardTitle>
                  <CardDescription>Users with violations requiring review</CardDescription>
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
                      <p className="text-center text-sm text-muted-foreground">No flagged users</p>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Ban className="h-5 w-5 text-red-500" />
                    Banned Users
                  </CardTitle>
                  <CardDescription>Users currently banned from the platform</CardDescription>
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
                            {u.banReason ?? "No reason provided"}
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => performAction("unban", { userId: u.userId })}
                        >
                          Unban
                        </Button>
                      </div>
                    ))}
                    {bannedUsers.length === 0 && (
                      <p className="text-center text-sm text-muted-foreground">No banned users</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

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
                          {admin.notes ?? "-"}
                        </TableCell>
                        <TableCell>
                          {adminRole === "super_admin" && admin.id !== "anvil-default" && (
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

        <Dialog open={addAdminOpen} onOpenChange={setAddAdminOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Admin</DialogTitle>
              <DialogDescription>Grant admin privileges to a wallet address</DialogDescription>
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
                  onValueChange={(value) => {
                    if (isAdminRole(value)) setNewAdminRole(value);
                  }}
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
                {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Add Admin
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={userDetailOpen} onOpenChange={setUserDetailOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>User Details</DialogTitle>
              <DialogDescription>Detailed information and moderation actions</DialogDescription>
            </DialogHeader>
            {userDetail ? (
              <div className="space-y-4">
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
                      <span>{userDetail.user?.wallet_address?.slice(0, 10)}...</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Generations:</span>{" "}
                      {userDetail.generationsCount}
                    </div>
                  </div>
                </div>

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
                      <span>Violations: {userDetail.moderationStatus.totalViolations}</span>
                      <span>Risk Score: {userDetail.moderationStatus.riskScore}</span>
                    </div>
                  </div>
                )}

                <div className="rounded-lg border p-4">
                  <h4 className="font-medium mb-2">
                    Recent Violations ({userDetail.violations.length})
                  </h4>
                  <div className="max-h-[200px] overflow-y-auto space-y-2">
                    {userDetail.violations.slice(0, 10).map((v) => (
                      <div key={v.id} className="text-sm border-b pb-2">
                        <div className="flex gap-2">
                          {v.categories.map((c) => (
                            <Badge key={c} variant="destructive" className="text-xs">
                              {c}
                            </Badge>
                          ))}
                        </div>
                        <p className="text-muted-foreground truncate">{v.messageText}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() =>
                      selectedUserId && performAction("mark_spammer", { userId: selectedUserId })
                    }
                    disabled={actionLoading || !selectedUserId}
                  >
                    Mark as Spammer
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      selectedUserId && performAction("mark_scammer", { userId: selectedUserId })
                    }
                    disabled={actionLoading || !selectedUserId}
                  >
                    Mark as Scammer
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() =>
                      selectedUserId &&
                      performAction("ban", {
                        userId: selectedUserId,
                        reason: "Admin review",
                      })
                    }
                    disabled={actionLoading || !selectedUserId}
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
    </>
  );
}
