'use client';

import { cn, formatDate } from '@babylon/shared';
import {
  AlertTriangle,
  RefreshCw,
  Search,
  Shield,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Avatar } from '@/components/shared/Avatar';
import { Skeleton } from '@/components/shared/Skeleton';
import { apiUrl } from '@/utils/api-url';

/**
 * Admin user structure for admin management tab.
 */
interface AdminUser {
  id: string;
  username: string | null;
  displayName: string | null;
  walletAddress: string | null;
  profileImageUrl: string | null;
  isActor: boolean;
  isAdmin: boolean;
  createdAt: string;
  updatedAt: string;
  hasFarcaster: boolean;
  hasTwitter: boolean;
}

/**
 * Available user structure for adding admins.
 */
interface AvailableUser {
  id: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  walletAddress: string | null;
  isActor: boolean;
}

/**
 * Admin management tab component for managing admin users.
 *
 * Provides interface for viewing, adding, and removing admin users.
 * Includes search functionality to find users to promote to admin.
 * Shows admin list with user details and admin status indicators.
 *
 * Features:
 * - Admin list display
 * - Add admin functionality
 * - Remove admin functionality
 * - User search
 * - Loading states
 * - Error handling
 *
 * @returns Admin management tab element
 */
export function AdminManagementTab() {
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showRemoveModal, setShowRemoveModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [availableUsers, setAvailableUsers] = useState<AvailableUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [processing, setProcessing] = useState(false);

  const fetchAdmins = useCallback(async (showRefreshing = false) => {
    if (showRefreshing) setRefreshing(true);
    const response = await fetch(apiUrl('/api/admin/admins'));
    if (!response.ok) throw new Error('Failed to fetch admins');
    const data = await response.json();
    setAdmins(data.admins || []);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void fetchAdmins();
  }, [fetchAdmins]);

  const searchUsers = async (query: string) => {
    if (!query.trim()) {
      setAvailableUsers([]);
      return;
    }

    setLoadingUsers(true);
    const params = new URLSearchParams({
      search: query,
      limit: '10',
      filter: 'users', // Only real users, not actors
    });
    const response = await fetch(apiUrl(`/api/admin/users?${params}`));
    if (!response.ok) {
      setAvailableUsers([]);
      setLoadingUsers(false);
      return;
    }
    const data = await response.json();

    // Filter out users who are already admins
    const adminIds = new Set(admins.map((a) => a.id));
    const nonAdminUsers = (data.users || []).filter(
      (u: AvailableUser) => !adminIds.has(u.id) && !u.isActor
    );

    setAvailableUsers(nonAdminUsers);
    setLoadingUsers(false);
  };

  const handleAddAdmin = async (userId: string) => {
    setProcessing(true);
    const response = await fetch(apiUrl(`/api/admin/admins/${userId}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'promote' }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to add admin');
    }

    await response.json();
    setShowAddModal(false);
    setSearchQuery('');
    setAvailableUsers([]);
    fetchAdmins(true);
    setProcessing(false);
  };

  const handleRemoveAdmin = async () => {
    if (!selectedUser) return;

    setProcessing(true);
    const response = await fetch(
      apiUrl(`/api/admin/admins/${selectedUser.id}`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'demote' }),
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to remove admin');
    }

    await response.json();
    setShowRemoveModal(false);
    setSelectedUser(null);
    fetchAdmins(true);
    setProcessing(false);
  };

  const AdminRow = ({ admin }: { admin: AdminUser }) => {
    const displayName = admin.displayName || admin.username || 'Anonymous';

    return (
      <div className="rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/50">
        <div className="flex items-start gap-4">
          {/* Avatar and Basic Info */}
          <Avatar
            src={admin.profileImageUrl || undefined}
            alt={displayName}
            size="md"
          />

          <div className="min-w-0 flex-1 space-y-2">
            {/* Name and Badges */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-bold text-lg">{displayName}</span>
              {admin.username && admin.displayName !== admin.username && (
                <span className="text-muted-foreground text-sm">
                  @{admin.username}
                </span>
              )}
              <span className="flex items-center gap-1 rounded bg-orange-500/20 px-2 py-0.5 text-orange-500 text-xs">
                <Shield className="h-3 w-3" />
                Admin
              </span>
            </div>

            {/* Stats */}
            <div className="flex flex-wrap gap-4 text-muted-foreground text-sm">
              {admin.hasFarcaster && (
                <span className="flex items-center gap-1">
                  <span className="text-purple-500">●</span>
                  Farcaster
                </span>
              )}
              {admin.hasTwitter && (
                <span className="flex items-center gap-1">
                  <span className="text-blue-500">●</span>
                  Twitter
                </span>
              )}
              <span>Joined: {formatDate(admin.createdAt)}</span>
            </div>

            {/* Wallet Address */}
            {admin.walletAddress && (
              <div className="truncate font-mono text-muted-foreground text-xs">
                {admin.walletAddress}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2">
            <button
              onClick={() => {
                setSelectedUser(admin);
                setShowRemoveModal(true);
              }}
              disabled={processing}
              className="flex items-center gap-1 whitespace-nowrap rounded bg-red-500/20 px-3 py-1.5 font-medium text-red-500 text-sm transition-colors hover:bg-red-500/30 disabled:opacity-50"
            >
              <UserMinus className="h-4 w-4" />
              Remove Admin
            </button>
          </div>
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
      {/* Header with Actions */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 font-semibold text-xl">
            <Shield className="h-5 w-5 text-orange-500" />
            Admin Management
          </h2>
          <p className="mt-1 text-muted-foreground text-sm">
            {admins.length} {admins.length === 1 ? 'admin' : 'admins'} with full
            system access
          </p>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => fetchAdmins(true)}
            disabled={refreshing}
            className="flex items-center gap-2 rounded bg-muted px-3 py-2 font-medium text-sm transition-colors hover:bg-muted/80 disabled:opacity-50"
          >
            <RefreshCw
              className={cn('h-4 w-4', refreshing && 'animate-spin')}
            />
            Refresh
          </button>

          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 rounded bg-primary px-4 py-2 font-medium text-primary-foreground text-sm transition-colors hover:bg-primary/90"
          >
            <UserPlus className="h-4 w-4" />
            Add Admin
          </button>
        </div>
      </div>

      {/* Admins List */}
      {admins.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card py-12 text-center text-muted-foreground">
          <Shield className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p>No admins found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {admins.map((admin) => (
            <AdminRow key={admin.id} admin={admin} />
          ))}
        </div>
      )}

      {/* Add Admin Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl border border-border bg-card p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-bold text-xl">Add Admin</h2>
              <button
                onClick={() => {
                  setShowAddModal(false);
                  setSearchQuery('');
                  setAvailableUsers([]);
                }}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="mb-4 text-muted-foreground text-sm">
              Search for a user to grant admin privileges. Admins have full
              access to all system functions.
            </p>

            {/* Search Input */}
            <div className="relative mb-4">
              <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search by username, display name, or wallet..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  searchUsers(e.target.value);
                }}
                className="w-full rounded-lg border border-border bg-background py-2 pr-4 pl-10 focus:border-primary focus:outline-none"
                autoFocus
              />
            </div>

            {/* Search Results */}
            <div className="flex-1 space-y-2 overflow-auto">
              {loadingUsers && (
                <div className="py-4 text-center text-muted-foreground">
                  <RefreshCw className="mx-auto mb-2 h-5 w-5 animate-spin" />
                  Searching...
                </div>
              )}

              {!loadingUsers && searchQuery && availableUsers.length === 0 && (
                <div className="py-4 text-center text-muted-foreground">
                  No users found
                </div>
              )}

              {!loadingUsers &&
                availableUsers.map((user) => (
                  <div
                    key={user.id}
                    className="flex items-center gap-3 rounded-lg border border-border bg-background p-3 transition-colors hover:border-primary/50"
                  >
                    <Avatar
                      src={user.profileImageUrl || undefined}
                      alt={user.displayName || user.username || 'User'}
                      size="sm"
                    />

                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {user.displayName || user.username || 'Anonymous'}
                      </div>
                      {user.username && user.displayName !== user.username && (
                        <div className="text-muted-foreground text-xs">
                          @{user.username}
                        </div>
                      )}
                    </div>

                    <button
                      onClick={() => handleAddAdmin(user.id)}
                      disabled={processing}
                      className="rounded bg-primary px-3 py-1.5 font-medium text-primary-foreground text-sm transition-colors hover:bg-primary/90 disabled:opacity-50"
                    >
                      {processing ? 'Adding...' : 'Add'}
                    </button>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* Remove Admin Confirmation Modal */}
      {showRemoveModal && selectedUser && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6">
            <div className="mb-4 flex items-center gap-3 text-orange-500">
              <AlertTriangle className="h-6 w-6" />
              <h2 className="font-bold text-xl">Remove Admin Privileges</h2>
            </div>

            <p className="mb-4 text-muted-foreground">
              Are you sure you want to remove admin privileges from{' '}
              <strong className="text-foreground">
                {selectedUser.displayName ||
                  selectedUser.username ||
                  'this user'}
              </strong>
              ?
            </p>

            <div className="mb-4 rounded-lg border border-orange-500/20 bg-orange-500/10 p-3">
              <p className="text-muted-foreground text-sm">
                This user will lose access to all admin functions including user
                management, system stats, and configuration settings.
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowRemoveModal(false);
                  setSelectedUser(null);
                }}
                disabled={processing}
                className="flex-1 rounded-lg bg-muted px-4 py-2 text-foreground transition-colors hover:bg-muted/80 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleRemoveAdmin}
                disabled={processing}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-primary-foreground transition-colors hover:bg-red-600 disabled:opacity-50"
              >
                {processing ? (
                  'Removing...'
                ) : (
                  <>
                    <UserMinus className="h-4 w-4" />
                    Remove Admin
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
