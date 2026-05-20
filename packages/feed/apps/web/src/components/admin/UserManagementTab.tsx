'use client';

import { cn, formatDate } from '@feed/shared';
import {
  Ban,
  CheckCircle,
  RefreshCw,
  Search,
  Shield,
  Users,
  VolumeX,
} from 'lucide-react';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { BlockUserModal } from '@/components/moderation/BlockUserModal';
import { MuteUserModal } from '@/components/moderation/MuteUserModal';
import { Avatar } from '@/components/shared/Avatar';
import { Skeleton } from '@/components/shared/Skeleton';
import { formatCurrencyCompact } from '@/lib/format';
import { getUserDisplayName } from '@/lib/user-display';
import { apiUrl } from '@/utils/api-url';

/**
 * User schema for validation.
 */
const UserSchema = z.object({
  id: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  profileImageUrl: z.string().nullable(),
  isActor: z.boolean(),
  isAdmin: z.boolean(),
  isBanned: z.boolean(),
  isWhitelisted: z.boolean().optional(),
  bannedAt: z.string().nullable(),
  bannedReason: z.string().nullable(),
  bannedBy: z.string().nullable(),
  virtualBalance: z.string(),
  totalDeposited: z.string(),
  totalWithdrawn: z.string(),
  lifetimePnL: z.string(),
  reputationPoints: z.number(),
  referralCount: z.number(),
  nftTokenId: z.number().nullable(),
  hasFarcaster: z.boolean(),
  hasTwitter: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  _count: z
    .object({
      comments: z.number(),
      reactions: z.number(),
      positions: z.number(),
      following: z.number(),
      followedBy: z.number(),
      reportsReceived: z.number().optional(),
      blocksReceived: z.number().optional(),
      mutesReceived: z.number().optional(),
      reportsSent: z.number().optional(),
    })
    .optional(),
  _moderation: z
    .object({
      reportsReceived: z.number(),
      blocksReceived: z.number(),
      mutesReceived: z.number(),
      reportsSent: z.number(),
      reportRatio: z.number(),
      blockRatio: z.number(),
      muteRatio: z.number(),
      badUserScore: z.number(),
    })
    .optional(),
});
type User = z.infer<typeof UserSchema>;

/**
 * Filter type for user management tab.
 */
type FilterType = 'all' | 'actors' | 'users' | 'banned' | 'admins';
/**
 * Sort by type for user management tab.
 */
type SortByType =
  | 'created'
  | 'balance'
  | 'reputation'
  | 'username'
  | 'reports_received'
  | 'blocks_received'
  | 'mutes_received'
  | 'report_ratio'
  | 'block_ratio'
  | 'bad_user_score';

/**
 * User management tab component for managing users and actors.
 *
 * Displays a comprehensive list of users and actors with filtering, sorting,
 * and search functionality. Provides user management actions including ban,
 * mute, block, and send money. Shows user statistics and moderation metrics.
 *
 * Features:
 * - User/actor list display
 * - Filtering (all, actors, users, banned, admins)
 * - Sorting by various metrics
 * - Search functionality
 * - User details view
 * - Ban functionality
 * - Mute/block functionality
 * - Send money functionality
 * - Moderation metrics display
 * - Loading states
 * - Error handling
 *
 * @returns User management tab element
 */
export function UserManagementTab() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, startRefresh] = useTransition();
  const [filter, setFilter] = useState<FilterType>('all');
  const [sortBy, setSortBy] = useState<SortByType>('created');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [showBanModal, setShowBanModal] = useState(false);
  const [showMuteModal, setShowMuteModal] = useState(false);
  const [showBlockModal, setShowBlockModal] = useState(false);
  const [banReason, setBanReason] = useState('');
  const [isScammer, setIsScammer] = useState(false);
  const [isCSAM, setIsCSAM] = useState(false);
  const [isBanning, startBanning] = useTransition();
  const [whitelistingUserId, setWhitelistingUserId] = useState<string | null>(
    null
  );

  const fetchUsers = useCallback(
    (showRefreshing = false) => {
      const fetchLogic = async () => {
        const params = new URLSearchParams({
          limit: '50',
          filter,
          sortBy,
          sortOrder: 'desc',
        });
        if (searchQuery) params.set('search', searchQuery);

        const response = await fetch(apiUrl(`/api/admin/users?${params}`));
        if (!response.ok) throw new Error('Failed to fetch users');
        const data = await response.json();
        const validation = z.array(UserSchema).safeParse(data.users);
        if (!validation.success) {
          throw new Error('Invalid user data structure');
        }
        setUsers(validation.data || []);
        setLoading(false);
      };

      if (showRefreshing) {
        startRefresh(fetchLogic);
      } else {
        void fetchLogic();
      }
    },
    [filter, sortBy, searchQuery]
  );

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleBanUser = (user: User, action: 'ban' | 'unban') => {
    if (action === 'ban' && !banReason.trim()) {
      toast.error('Please provide a reason for banning');
      return;
    }

    startBanning(async () => {
      const response = await fetch(apiUrl(`/api/admin/users/${user.id}/ban`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          reason: action === 'ban' ? banReason : undefined,
          isScammer: action === 'ban' ? isScammer : false,
          isCSAM: action === 'ban' ? isCSAM : false,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to update user');
      }

      setShowBanModal(false);
      setBanReason('');
      setIsScammer(false);
      setIsCSAM(false);
      setSelectedUser(null);
      fetchUsers(true);
    });
  };

  const handleWhitelistUser = async (userId: string) => {
    setWhitelistingUserId(userId);
    try {
      const res = await fetch(apiUrl('/api/admin/whitelist'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, source: 'admin_manual' }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 409) {
          toast.info('User is already whitelisted');
        } else {
          toast.error(data.error ?? 'Failed to whitelist user');
        }
        return;
      }
    } catch {
      toast.error('Failed to whitelist user');
    } finally {
      setWhitelistingUserId(null);
    }
  };

  const formatCurrency = formatCurrencyCompact;

  const UserRow = ({ user }: { user: User }) => {
    const displayName = getUserDisplayName(user, 'Anonymous');

    return (
      <div className="rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/50">
        <div className="flex items-start gap-4">
          {/* Avatar and Basic Info */}
          <Avatar
            src={user.profileImageUrl || undefined}
            alt={displayName}
            size="md"
          />

          <div className="min-w-0 flex-1 space-y-2">
            {/* Name and Badges */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-bold text-lg">{displayName}</span>
              {user.username && user.displayName !== user.username && (
                <span className="text-muted-foreground text-sm">
                  @{user.username}
                </span>
              )}
              {user.isAdmin && (
                <span className="flex items-center gap-1 rounded bg-orange-500/20 px-2 py-0.5 text-orange-500 text-xs">
                  <Shield className="h-3 w-3" />
                  Admin
                </span>
              )}
              {user.isActor && (
                <span className="rounded bg-purple-500/20 px-2 py-0.5 text-purple-500 text-xs">
                  NPC
                </span>
              )}
              {user.isBanned && (
                <span className="flex items-center gap-1 rounded bg-red-500/20 px-2 py-0.5 text-red-500 text-xs">
                  <Ban className="h-3 w-3" />
                  Banned
                </span>
              )}
              {user.isWhitelisted && (
                <span className="flex items-center gap-1 rounded bg-emerald-500/20 px-2 py-0.5 text-emerald-500 text-xs">
                  <Shield className="h-3 w-3" />
                  Whitelisted
                </span>
              )}
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div>
                <div className="text-muted-foreground text-xs">Balance</div>
                <div className="font-bold text-green-600">
                  {formatCurrency(user.virtualBalance)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">P&L</div>
                <div
                  className={cn(
                    'font-bold',
                    parseFloat(user.lifetimePnL) >= 0
                      ? 'text-green-600'
                      : 'text-red-600'
                  )}
                >
                  {formatCurrency(user.lifetimePnL)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Reputation</div>
                <div className="font-bold">{user.reputationPoints}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Joined</div>
                <div className="font-medium">{formatDate(user.createdAt)}</div>
              </div>
            </div>

            {/* Activity Stats */}
            <div className="flex gap-4 text-muted-foreground text-xs">
              <span>Posts: {user._count?.comments ?? 0}</span>
              <span>Reactions: {user._count?.reactions ?? 0}</span>
              <span>Positions: {user._count?.positions ?? 0}</span>
              <span>Followers: {user._count?.followedBy ?? 0}</span>
              <span>Following: {user._count?.following ?? 0}</span>
            </div>

            {/* Moderation Metrics */}
            {user._moderation &&
              (user._moderation.reportsReceived > 0 ||
                user._moderation.blocksReceived > 0 ||
                user._moderation.mutesReceived > 0) && (
                <div className="space-y-2 rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-3">
                  <div className="flex items-center gap-2 font-medium text-xs text-yellow-600">
                    <Shield className="h-3 w-3" />
                    Moderation Metrics
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                    <div>
                      <div className="text-muted-foreground">Reports</div>
                      <div className="font-bold text-red-500">
                        {user._moderation.reportsReceived}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Blocks</div>
                      <div className="font-bold text-orange-500">
                        {user._moderation.blocksReceived}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Mutes</div>
                      <div className="font-bold text-yellow-600">
                        {user._moderation.mutesReceived}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Bad Score</div>
                      <div
                        className={cn(
                          'font-bold',
                          user._moderation.badUserScore > 10
                            ? 'text-red-500'
                            : user._moderation.badUserScore > 5
                              ? 'text-orange-500'
                              : 'text-yellow-600'
                        )}
                      >
                        {user._moderation.badUserScore.toFixed(1)}
                      </div>
                    </div>
                  </div>
                  {(user._moderation.reportRatio > 0 ||
                    user._moderation.blockRatio > 0) && (
                    <div className="flex gap-3 border-yellow-500/20 border-t pt-1 text-muted-foreground text-xs">
                      <span>
                        Report Ratio: {user._moderation.reportRatio.toFixed(2)}
                      </span>
                      <span>
                        Block Ratio: {user._moderation.blockRatio.toFixed(2)}
                      </span>
                    </div>
                  )}
                </div>
              )}

            {/* Ban Info */}
            {user.isBanned && user.bannedReason && (
              <div className="rounded border border-red-500/20 bg-red-500/10 p-2 text-sm">
                <div className="font-medium text-red-500">Ban Reason:</div>
                <div className="text-muted-foreground text-xs">
                  {user.bannedReason}
                </div>
                {user.bannedAt && (
                  <div className="mt-1 text-muted-foreground text-xs">
                    Banned on {formatDate(user.bannedAt)}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Actions */}
          {!user.isActor && (
            <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  setSelectedUser(user);
                  setShowMuteModal(true);
                }}
                className="flex items-center gap-1 rounded bg-blue-500/20 px-3 py-1.5 font-medium text-blue-500 text-sm transition-colors hover:bg-blue-500/30"
                title="Mute user"
              >
                <VolumeX className="h-4 w-4" />
                Mute
              </button>
              <button
                onClick={() => {
                  setSelectedUser(user);
                  setShowBlockModal(true);
                }}
                className="flex items-center gap-1 rounded bg-orange-500/20 px-3 py-1.5 font-medium text-orange-500 text-sm transition-colors hover:bg-orange-500/30"
                title="Block user"
              >
                <Ban className="h-4 w-4" />
                Block
              </button>
              <button
                onClick={() => handleWhitelistUser(user.id)}
                disabled={whitelistingUserId === user.id}
                className="flex items-center gap-1 rounded bg-emerald-500/20 px-3 py-1.5 font-medium text-emerald-500 text-sm transition-colors hover:bg-emerald-500/30 disabled:opacity-50"
                title="Whitelist user — allow them to bypass gating"
              >
                {whitelistingUserId === user.id ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Shield className="h-4 w-4" />
                )}
                Whitelist
              </button>
              {user.isBanned ? (
                <button
                  onClick={() => handleBanUser(user, 'unban')}
                  disabled={isBanning}
                  className="flex items-center gap-1 rounded bg-green-500/20 px-3 py-1.5 font-medium text-green-500 text-sm transition-colors hover:bg-green-500/30 disabled:opacity-50"
                >
                  <CheckCircle className="h-4 w-4" />
                  Unban
                </button>
              ) : (
                <button
                  onClick={() => {
                    setSelectedUser(user);
                    setShowBanModal(true);
                  }}
                  disabled={isBanning}
                  className="flex items-center gap-1 rounded bg-red-500/20 px-3 py-1.5 font-medium text-red-500 text-sm transition-colors hover:bg-red-500/30 disabled:opacity-50"
                >
                  <Ban className="h-4 w-4" />
                  Ban
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="w-full space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters and Search */}
      <div className="space-y-3">
        {/* Search */}
        <div className="relative">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by username, display name, or wallet address..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-border bg-card py-2 pr-4 pl-10 focus:border-border focus:outline-none"
          />
        </div>

        {/* Filter and Sort */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-2">
            {(['all', 'users', 'actors', 'banned', 'admins'] as const).map(
              (f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    'rounded px-3 py-1.5 font-medium text-sm transition-colors',
                    filter === f
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  )}
                >
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              )
            )}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-sm">Sort by:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortByType)}
              className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm focus:border-border focus:outline-none"
            >
              <optgroup label="General">
                <option value="created">Join Date</option>
                <option value="balance">Balance</option>
                <option value="reputation">Reputation</option>
                <option value="username">Username</option>
              </optgroup>
              <optgroup label="Moderation">
                <option value="bad_user_score">Bad User Score</option>
                <option value="reports_received">Reports Received</option>
                <option value="blocks_received">Blocks Received</option>
                <option value="mutes_received">Mutes Received</option>
                <option value="report_ratio">Report Ratio</option>
                <option value="block_ratio">Block Ratio</option>
              </optgroup>
            </select>
          </div>

          <button
            onClick={() => fetchUsers(true)}
            disabled={isRefreshing}
            className="ml-auto flex items-center gap-2 rounded bg-muted px-3 py-1.5 font-medium text-sm transition-colors hover:bg-muted/80 disabled:opacity-50"
          >
            <RefreshCw
              className={cn('h-4 w-4', isRefreshing && 'animate-spin')}
            />
            Refresh
          </button>
        </div>
      </div>

      {/* Users List */}
      {users.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          <Users className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p>No users found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {users.map((user) => (
            <UserRow key={user.id} user={user} />
          ))}
        </div>
      )}

      {/* Block Modal */}
      {showBlockModal && selectedUser && (
        <BlockUserModal
          isOpen={showBlockModal}
          onClose={() => {
            setShowBlockModal(false);
            setSelectedUser(null);
          }}
          targetUserId={selectedUser.id}
          targetDisplayName={
            selectedUser.displayName || selectedUser.username || 'User'
          }
          onSuccess={() => {
            fetchUsers(true);
          }}
        />
      )}

      {/* Mute Modal */}
      {showMuteModal && selectedUser && (
        <MuteUserModal
          isOpen={showMuteModal}
          onClose={() => {
            setShowMuteModal(false);
            setSelectedUser(null);
          }}
          targetUserId={selectedUser.id}
          targetDisplayName={
            selectedUser.displayName || selectedUser.username || 'User'
          }
          onSuccess={() => {
            fetchUsers(true);
          }}
        />
      )}

      {/* Ban Modal */}
      {showBanModal && selectedUser && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6">
            <h2 className="mb-4 font-bold text-xl">Ban User</h2>
            <p className="mb-4 text-muted-foreground">
              Are you sure you want to ban{' '}
              <strong>
                {selectedUser.displayName || selectedUser.username}
              </strong>
              ?
            </p>

            <div className="mb-4">
              <label className="mb-2 block font-medium text-sm">
                Reason for ban <span className="text-red-500">*</span>
              </label>
              <textarea
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                placeholder="Explain why this user is being banned..."
                className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 focus:border-border focus:outline-none"
                rows={3}
              />
            </div>

            <div className="mb-4 space-y-3">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id="isScammer"
                  checked={isScammer}
                  onChange={(e) => setIsScammer(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-border text-red-500 focus:ring-red-500"
                />
                <label
                  htmlFor="isScammer"
                  className="cursor-pointer font-medium text-sm"
                >
                  Mark as Scammer
                  <p className="mt-1 text-muted-foreground text-xs">
                    This user is engaging in fraudulent or deceptive behavior
                  </p>
                </label>
              </div>

              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id="isCSAM"
                  checked={isCSAM}
                  onChange={(e) => setIsCSAM(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-border text-red-500 focus:ring-red-500"
                />
                <label
                  htmlFor="isCSAM"
                  className="cursor-pointer font-medium text-sm"
                >
                  Mark as CSAM (Child Sexual Abuse Material)
                  <p className="mt-1 text-muted-foreground text-xs">
                    This user is sharing or promoting child sexual abuse
                    material
                  </p>
                </label>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowBanModal(false);
                  setBanReason('');
                  setIsScammer(false);
                  setIsCSAM(false);
                  setSelectedUser(null);
                }}
                disabled={isBanning}
                className="flex-1 rounded-lg bg-muted px-4 py-2 text-foreground transition-colors hover:bg-muted/80 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleBanUser(selectedUser, 'ban')}
                disabled={isBanning || !banReason.trim()}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-primary-foreground transition-colors hover:bg-red-600 disabled:opacity-50"
              >
                {isBanning ? (
                  <>Banning...</>
                ) : (
                  <>
                    <Ban className="h-4 w-4" />
                    Ban User
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
