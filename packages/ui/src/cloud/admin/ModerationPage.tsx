/**
 * /dashboard/admin — moderation panel.
 *
 * Lifted from `@elizaos/cloud-frontend/src/dashboard/admin/Page.tsx`. Rewired:
 *   - DTOs from `@elizaos/cloud-shared/lib/types/cloud-api` (was `@/lib/types/cloud-api`).
 *   - `api` / `ApiError` from the app cloud client (`../lib/api-client`).
 *   - `useCloudT` (was the cloud-frontend `useT`); `useDocumentTitle` (was Helmet).
 *   - the admin role comes from the consolidated {@link useAdminGate} (was the
 *     now-removed `useAdminModerationStatus` hook).
 *
 * The route-level role gate ({@link AdminGate}) decides visibility; this body
 * assumes it is already past the gate and reads the role only to scope
 * super-admin-only controls (add / revoke admin).
 */

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
} from "@elizaos/cloud-shared/lib/types/cloud-api";
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
} from "@elizaos/ui/cloud-ui";
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
import { toast } from "sonner";
import { ApiError, api } from "../lib/api-client";
import { useCloudT } from "../shell/CloudI18nProvider";
import { useAdminGate } from "./data/use-admin-gate";
import { useDocumentTitle } from "./use-document-title";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : fallback;
}

function isAdminRole(value: string): value is AdminRole {
  return value === "super_admin" || value === "moderator" || value === "viewer";
}

export default function ModerationPage(): React.JSX.Element {
  const t = useCloudT();
  useDocumentTitle(
    t("cloud.admin.metaTitle", { defaultValue: "Admin Panel · Eliza Cloud" }),
  );
  const { role: adminRole } = useAdminGate();

  const [overview, setOverview] =
    useState<AdminModerationOverviewResponse | null>(null);
  const [admins, setAdmins] = useState<AdminUserDto[]>([]);
  const [flaggedUsers, setFlaggedUsers] = useState<
    AdminModerationUserStatusDto[]
  >([]);
  const [bannedUsers, setBannedUsers] = useState<
    AdminModerationUserStatusDto[]
  >([]);
  const [violations, setViolations] = useState<AdminModerationViolationDto[]>(
    [],
  );

  const [addAdminOpen, setAddAdminOpen] = useState(false);
  const [newAdminWallet, setNewAdminWallet] = useState("");
  const [newAdminRole, setNewAdminRole] = useState<AdminRole>("moderator");
  const [actionLoading, setActionLoading] = useState(false);

  const [userDetailOpen, setUserDetailOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [userDetail, setUserDetail] =
    useState<AdminModerationUserDetailResponse | null>(null);

  const requestFailed = t("cloud.admin.error.requestFailed", {
    defaultValue: "Request failed",
  });

  const loadAdmins = useCallback(async () => {
    try {
      const data = await api<AdminModerationAdminsResponse>(
        "/api/v1/admin/moderation?view=admins",
      );
      setAdmins(data.admins);
    } catch (error) {
      toast.error(
        `${t("cloud.admin.toast.loadAdminsFailed", { defaultValue: "Failed to load admins" })}: ${errorMessage(error, requestFailed)}`,
      );
    }
  }, [t, requestFailed]);

  const loadUsers = useCallback(async () => {
    try {
      const data = await api<AdminModerationUsersResponse>(
        "/api/v1/admin/moderation?view=users",
      );
      setFlaggedUsers(data.flaggedUsers);
      setBannedUsers(data.bannedUsers);
    } catch (error) {
      toast.error(
        `${t("cloud.admin.toast.loadUsersFailed", { defaultValue: "Failed to load users" })}: ${errorMessage(error, requestFailed)}`,
      );
    }
  }, [t, requestFailed]);

  const loadViolations = useCallback(async () => {
    try {
      const data = await api<AdminModerationViolationsResponse>(
        "/api/v1/admin/moderation?view=violations&limit=100",
      );
      setViolations(data.violations);
    } catch (error) {
      toast.error(
        `${t("cloud.admin.toast.loadViolationsFailed", { defaultValue: "Failed to load violations" })}: ${errorMessage(error, requestFailed)}`,
      );
    }
  }, [t, requestFailed]);

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
      toast.error(
        `${t("cloud.admin.toast.loadPanelFailed", { defaultValue: "Failed to load admin panel" })}: ${errorMessage(error, requestFailed)}`,
      );
    }
  }, [t, requestFailed]);

  const loadUserDetail = useCallback(
    async (userId: string) => {
      setSelectedUserId(userId);
      setUserDetailOpen(true);
      try {
        setUserDetail(
          await api<AdminModerationUserDetailResponse>(
            `/api/v1/admin/moderation?view=user-detail&userId=${encodeURIComponent(userId)}`,
          ),
        );
      } catch (error) {
        toast.error(
          `${t("cloud.admin.toast.loadUserDetailFailed", { defaultValue: "Failed to load user details" })}: ${errorMessage(error, requestFailed)}`,
        );
      }
    },
    [t, requestFailed],
  );

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
      toast.error(
        `${t("cloud.admin.toast.actionFailed", { defaultValue: "Action failed" })}: ${errorMessage(error, requestFailed)}`,
      );
      return false;
    } finally {
      setActionLoading(false);
    }

    toast.success(
      t("cloud.admin.toast.actionSuccess", {
        defaultValue: "Action completed successfully",
      }),
    );
    loadAll();
    return true;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {t("cloud.admin.title", { defaultValue: "Admin Panel" })}
          </h1>
          <p className="text-muted-foreground">
            {t("cloud.admin.subtitle", {
              defaultValue: "Moderation and user management",
            })}
            {adminRole ? ` • ${adminRole}` : ""}
          </p>
        </div>
        <Button variant="outline" onClick={loadAll}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {t("cloud.admin.refresh", { defaultValue: "Refresh" })}
        </Button>
      </div>

      {overview && (
        <div className="grid gap-4 md:grid-cols-4">
          <DashboardStatCard
            label={t("cloud.admin.stat.totalViolations", {
              defaultValue: "Total Violations",
            })}
            value={overview.totalViolations}
            icon={<AlertTriangle className="h-4 w-4 text-warn" />}
            accent="amber"
          />
          <DashboardStatCard
            label={t("cloud.admin.stat.flaggedUsers", {
              defaultValue: "Flagged Users",
            })}
            value={overview.flaggedUsers}
            icon={<UserX className="h-4 w-4 text-accent" />}
            accent="orange"
          />
          <DashboardStatCard
            label={t("cloud.admin.stat.bannedUsers", {
              defaultValue: "Banned Users",
            })}
            value={overview.bannedUsers}
            icon={<Ban className="h-4 w-4 text-danger" />}
            accent="red"
          />
          <DashboardStatCard
            label={t("cloud.admin.stat.admins", { defaultValue: "Admins" })}
            value={overview.adminCount}
            icon={<Shield className="h-4 w-4 text-txt-strong/70" />}
            accent="white"
          />
        </div>
      )}

      <Tabs defaultValue="violations" className="space-y-4">
        <TabsList>
          <TabsTrigger value="violations" onClick={loadViolations}>
            <AlertTriangle className="mr-2 h-4 w-4" />
            {t("cloud.admin.tab.violations", { defaultValue: "Violations" })}
          </TabsTrigger>
          <TabsTrigger value="users" onClick={loadUsers}>
            <Users className="mr-2 h-4 w-4" />
            {t("cloud.admin.tab.users", { defaultValue: "Users" })}
          </TabsTrigger>
          <TabsTrigger value="admins" onClick={loadAdmins}>
            <Shield className="mr-2 h-4 w-4" />
            {t("cloud.admin.tab.admins", { defaultValue: "Admins" })}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="violations" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>
                {t("cloud.admin.violations.cardTitle", {
                  defaultValue: "Recent Violations",
                })}
              </CardTitle>
              <CardDescription>
                {t("cloud.admin.violations.cardDesc", {
                  defaultValue:
                    "Content moderation violations detected by the system",
                })}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      {t("cloud.admin.col.time", { defaultValue: "Time" })}
                    </TableHead>
                    <TableHead>
                      {t("cloud.admin.col.user", { defaultValue: "User" })}
                    </TableHead>
                    <TableHead>
                      {t("cloud.admin.col.categories", {
                        defaultValue: "Categories",
                      })}
                    </TableHead>
                    <TableHead>
                      {t("cloud.admin.col.action", {
                        defaultValue: "Action",
                      })}
                    </TableHead>
                    <TableHead>
                      {t("cloud.admin.col.content", {
                        defaultValue: "Content",
                      })}
                    </TableHead>
                    <TableHead />
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
                        {t("cloud.admin.violations.empty", {
                          defaultValue: "No violations found",
                        })}
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
                  <UserX className="h-5 w-5 text-accent" />
                  {t("cloud.admin.flagged.title", {
                    defaultValue: "Flagged Users",
                  })}
                </CardTitle>
                <CardDescription>
                  {t("cloud.admin.flagged.desc", {
                    defaultValue: "Users with violations requiring review",
                  })}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {flaggedUsers.map((u) => (
                    <div
                      key={u.id}
                      className="flex items-center justify-between rounded-sm border p-3"
                    >
                      <div>
                        <p className="text-sm">{u.userId.slice(0, 12)}...</p>
                        <div className="flex gap-2 text-xs text-muted-foreground">
                          <span>
                            {u.totalViolations}{" "}
                            {t("cloud.admin.violationsLabel", {
                              defaultValue: "violations",
                            })}
                          </span>
                          <span>•</span>
                          <span>
                            {t("cloud.admin.riskLabel", {
                              defaultValue: "Risk",
                            })}
                            : {u.riskScore}
                          </span>
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
                              reason: t("cloud.admin.banReasonDefault", {
                                defaultValue: "Admin review",
                              }),
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
                      {t("cloud.admin.flagged.empty", {
                        defaultValue: "No flagged users",
                      })}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Ban className="h-5 w-5 text-danger" />
                  {t("cloud.admin.banned.title", {
                    defaultValue: "Banned Users",
                  })}
                </CardTitle>
                <CardDescription>
                  {t("cloud.admin.banned.desc", {
                    defaultValue: "Users currently banned from the platform",
                  })}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {bannedUsers.map((u) => (
                    <div
                      key={u.id}
                      className="flex items-center justify-between rounded-sm border border-destructive/20 bg-destructive/5 p-3"
                    >
                      <div>
                        <p className="text-sm">{u.userId.slice(0, 12)}...</p>
                        <p className="text-xs text-muted-foreground">
                          {u.banReason ??
                            t("cloud.admin.noReasonProvided", {
                              defaultValue: "No reason provided",
                            })}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          performAction("unban", { userId: u.userId })
                        }
                      >
                        {t("cloud.admin.unban", { defaultValue: "Unban" })}
                      </Button>
                    </div>
                  ))}
                  {bannedUsers.length === 0 && (
                    <p className="text-center text-sm text-muted-foreground">
                      {t("cloud.admin.banned.empty", {
                        defaultValue: "No banned users",
                      })}
                    </p>
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
                <CardTitle>
                  {t("cloud.admin.adminUsers.title", {
                    defaultValue: "Admin Users",
                  })}
                </CardTitle>
                <CardDescription>
                  {t("cloud.admin.adminUsers.desc", {
                    defaultValue: "Manage admin privileges",
                  })}
                </CardDescription>
              </div>
              {adminRole === "super_admin" && (
                <Button onClick={() => setAddAdminOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  {t("cloud.admin.addAdmin", { defaultValue: "Add Admin" })}
                </Button>
              )}
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      {t("cloud.admin.col.wallet", {
                        defaultValue: "Wallet",
                      })}
                    </TableHead>
                    <TableHead>
                      {t("cloud.admin.col.role", { defaultValue: "Role" })}
                    </TableHead>
                    <TableHead>
                      {t("cloud.admin.col.added", { defaultValue: "Added" })}
                    </TableHead>
                    <TableHead>
                      {t("cloud.admin.col.notes", { defaultValue: "Notes" })}
                    </TableHead>
                    <TableHead />
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
                              <Trash2 className="h-4 w-4 text-danger" />
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
            <DialogTitle>
              {t("cloud.admin.addAdminDialog.title", {
                defaultValue: "Add Admin",
              })}
            </DialogTitle>
            <DialogDescription>
              {t("cloud.admin.addAdminDialog.desc", {
                defaultValue: "Grant admin privileges to a wallet address",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>
                {t("cloud.admin.walletAddress", {
                  defaultValue: "Wallet Address",
                })}
              </Label>
              <Input
                placeholder="0x..."
                value={newAdminWallet}
                onChange={(e) => setNewAdminWallet(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>
                {t("cloud.admin.col.role", { defaultValue: "Role" })}
              </Label>
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
                  <SelectItem value="super_admin">
                    {t("cloud.admin.role.superAdmin", {
                      defaultValue: "Super Admin",
                    })}
                  </SelectItem>
                  <SelectItem value="moderator">
                    {t("cloud.admin.role.moderator", {
                      defaultValue: "Moderator",
                    })}
                  </SelectItem>
                  <SelectItem value="viewer">
                    {t("cloud.admin.role.viewer", { defaultValue: "Viewer" })}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddAdminOpen(false)}>
              {t("cloud.admin.cancel", { defaultValue: "Cancel" })}
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
              {t("cloud.admin.addAdmin", { defaultValue: "Add Admin" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={userDetailOpen} onOpenChange={setUserDetailOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t("cloud.admin.userDetails.title", {
                defaultValue: "User Details",
              })}
            </DialogTitle>
            <DialogDescription>
              {t("cloud.admin.userDetails.desc", {
                defaultValue: "Detailed information and moderation actions",
              })}
            </DialogDescription>
          </DialogHeader>
          {userDetail ? (
            <div className="space-y-4">
              <div className="rounded-sm border p-4">
                <h4 className="font-medium mb-2">
                  {t("cloud.admin.userInfo", { defaultValue: "User Info" })}
                </h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">
                      {t("cloud.admin.field.id", { defaultValue: "ID" })}:
                    </span>{" "}
                    <span>{userDetail.user?.id}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">
                      {t("cloud.admin.field.email", {
                        defaultValue: "Email",
                      })}
                      :
                    </span>{" "}
                    {userDetail.user?.email || "-"}
                  </div>
                  <div>
                    <span className="text-muted-foreground">
                      {t("cloud.admin.field.wallet", {
                        defaultValue: "Wallet",
                      })}
                      :
                    </span>{" "}
                    <span>
                      {userDetail.user?.wallet_address?.slice(0, 10)}...
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">
                      {t("cloud.admin.field.generations", {
                        defaultValue: "Generations",
                      })}
                      :
                    </span>{" "}
                    {userDetail.generationsCount}
                  </div>
                </div>
              </div>

              {userDetail.moderationStatus && (
                <div className="rounded-sm border p-4">
                  <h4 className="font-medium mb-2">
                    {t("cloud.admin.moderationStatus", {
                      defaultValue: "Moderation Status",
                    })}
                  </h4>
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
                      {t("cloud.admin.violationsCount", {
                        defaultValue: "Violations",
                      })}
                      : {userDetail.moderationStatus.totalViolations}
                    </span>
                    <span>
                      {t("cloud.admin.riskScore", {
                        defaultValue: "Risk Score",
                      })}
                      : {userDetail.moderationStatus.riskScore}
                    </span>
                  </div>
                </div>
              )}

              <div className="rounded-sm border p-4">
                <h4 className="font-medium mb-2">
                  {t("cloud.admin.recentViolationsCount", {
                    defaultValue: "Recent Violations",
                  })}{" "}
                  ({userDetail.violations.length})
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

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() =>
                    selectedUserId &&
                    performAction("mark_spammer", { userId: selectedUserId })
                  }
                  disabled={actionLoading || !selectedUserId}
                >
                  {t("cloud.admin.markSpammer", {
                    defaultValue: "Mark as Spammer",
                  })}
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    selectedUserId &&
                    performAction("mark_scammer", { userId: selectedUserId })
                  }
                  disabled={actionLoading || !selectedUserId}
                >
                  {t("cloud.admin.markScammer", {
                    defaultValue: "Mark as Scammer",
                  })}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() =>
                    selectedUserId &&
                    performAction("ban", {
                      userId: selectedUserId,
                      reason: t("cloud.admin.banReasonDefault", {
                        defaultValue: "Admin review",
                      }),
                    })
                  }
                  disabled={actionLoading || !selectedUserId}
                >
                  <Ban className="mr-2 h-4 w-4" />
                  {t("cloud.admin.banUser", { defaultValue: "Ban User" })}
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
