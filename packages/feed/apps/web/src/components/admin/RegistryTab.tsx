'use client';

import { cn, getActorProfileUrl, getProfileUrl } from '@babylon/shared';
import {
  AlertCircle,
  Ban,
  Bot,
  Building2,
  ExternalLink,
  Flag,
  Search,
  Star,
  TrendingUp,
  UserCircle,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { FeedbackForm } from '@/components/feedback/FeedbackForm';
import { Avatar } from '@/components/shared/Avatar';
import { SearchBar } from '@/components/shared/SearchBar';
import { Skeleton } from '@/components/shared/Skeleton';
import { getAuthToken } from '@/lib/auth';
import { apiUrl } from '@/utils/api-url';

/**
 * Registry entity schema for validation.
 */
const RegistryEntitySchema = z.object({
  type: z.enum(['user', 'actor', 'agent', 'app']),
  id: z.string(),
  name: z.string(),
  username: z.string().optional(),
  bio: z.string().optional(),
  description: z.string().optional(),
  imageUrl: z.string().optional(),
  isActor: z.boolean().optional(),
  nftTokenId: z.number().nullable().optional(),
  tokenId: z.number().optional(),
  metadataCID: z.string().optional(),
  mcpEndpoint: z.string().optional(),
  a2aEndpoint: z.string().optional(),
  balance: z.string().optional(),
  reputationPoints: z.number().optional(),
  reputationScore: z.number().optional(),
  averageFeedbackScore: z.number().optional(),
  totalFeedbackCount: z.number().optional(),
  isBanned: z.boolean().optional(),
  isScammer: z.boolean().optional(),
  isCSAM: z.boolean().optional(),
  tier: z.string().optional(),
  role: z.string().optional(),
  domain: z.array(z.string()).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  reputation: z
    .object({
      trustScore: z.number(),
      accuracyScore: z.number(),
      totalBets: z.number(),
      winningBets: z.number(),
    })
    .optional(),
  stats: z
    .object({
      positions: z.number().optional(),
      comments: z.number().optional(),
      reactions: z.number().optional(),
      followers: z.number().optional(),
      following: z.number().optional(),
      pools: z.number().optional(),
      trades: z.number().optional(),
    })
    .optional(),
  createdAt: z.string().optional(),
  registrationTimestamp: z.string().optional(),
});
type RegistryEntity = z.infer<typeof RegistryEntitySchema>;

/**
 * Registry data schema for validation.
 */
const RegistryDataSchema = z.object({
  users: z.array(RegistryEntitySchema),
  actors: z.array(RegistryEntitySchema),
  agents: z.array(RegistryEntitySchema),
  apps: z.array(RegistryEntitySchema),
  totals: z.object({
    users: z.number(),
    actors: z.number(),
    agents: z.number(),
    apps: z.number(),
    total: z.number(),
  }),
});
type RegistryData = z.infer<typeof RegistryDataSchema>;

/**
 * Registry tab component for viewing and managing registry entities.
 *
 * Displays all entities in the registry (users, actors, agents, apps) with
 * filtering, search, and on-chain filtering. Shows entity details including
 * reputation, statistics, and on-chain registration status. Includes feedback
 * form integration.
 *
 * Features:
 * - Entity list display (users, actors, agents, apps)
 * - Search functionality
 * - On-chain filter
 * - Entity details view
 * - Reputation display
 * - Statistics display
 * - Feedback form integration
 * - Loading states
 * - Error handling
 *
 * @returns Registry tab element
 */
export function RegistryTab() {
  const [data, setData] = useState<RegistryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<
    'all' | 'users' | 'actors' | 'agents' | 'apps'
  >('all');
  const [selectedEntity, setSelectedEntity] = useState<RegistryEntity | null>(
    null
  );
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [showBanModal, setShowBanModal] = useState(false);
  const [banReason, setBanReason] = useState('');
  const [isScammer, setIsScammer] = useState(false);
  const [isCSAM, setIsCSAM] = useState(false);
  const [isBanning, setIsBanning] = useState(false);

  const fetchRegistry = useCallback(() => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (search) params.set('search', search);

    fetch(apiUrl(`/api/registry/all?${params}`))
      .then((response) => {
        if (!response.ok) {
          return response.json().then((errorData) => {
            throw new Error(errorData.error || 'Failed to fetch registry data');
          });
        }
        return response.json();
      })
      .then((result) => {
        // The API returns data directly, not wrapped in { success, data }
        const validated = RegistryDataSchema.parse(result);
        setData(validated);
      })
      .catch((err: Error) => {
        setError(err.message || 'Failed to fetch registry data');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [search]);

  useEffect(() => {
    fetchRegistry();
  }, [fetchRegistry]);

  // Debounced re-fetch when search changes (with 300ms delay)
  useEffect(() => {
    if (!search) return; // Skip if no filters applied
    const timer = setTimeout(() => {
      fetchRegistry();
    }, 300);
    return () => clearTimeout(timer);
  }, [search, fetchRegistry]);

  const renderBadge = (
    _type: string,
    label: string,
    icon: React.ReactNode,
    color: string
  ) => {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full px-2 py-1 font-semibold text-xs',
          color
        )}
      >
        {icon}
        {label}
      </span>
    );
  };

  const renderEntityCard = (entity: RegistryEntity) => {
    const getBadgeColor = () => {
      switch (entity.type) {
        case 'user':
          return 'bg-blue-500/10 text-blue-500 border border-blue-500/20';
        case 'actor':
          return 'bg-purple-500/10 text-purple-500 border border-purple-500/20';
        case 'agent':
          return 'bg-green-500/10 text-green-500 border border-green-500/20';
        case 'app':
          return 'bg-orange-500/10 text-orange-500 border border-orange-500/20';
        default:
          return 'bg-muted text-muted-foreground';
      }
    };

    const getEntityProfileUrl = () => {
      if (entity.type === 'user') {
        return getProfileUrl(entity.id, entity.username);
      }
      if (entity.type === 'actor') {
        return getActorProfileUrl(entity.id);
      }
      return null;
    };

    const profileUrl = getEntityProfileUrl();

    const cardContent = (
      <>
        <div className="border-border border-b bg-muted/30 px-4 py-3">
          <div className="flex items-start gap-3">
            <Avatar
              src={entity.imageUrl}
              name={entity.name}
              size="lg"
              className="shrink-0"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-bold text-foreground text-lg">
                    {entity.name}
                  </h3>
                  {entity.username && (
                    <p className="text-muted-foreground text-sm">
                      @{entity.username}
                    </p>
                  )}
                </div>
                <div className="shrink-0">
                  {entity.type === 'user' &&
                    renderBadge(
                      'user',
                      'User',
                      <UserCircle className="h-3 w-3" />,
                      getBadgeColor()
                    )}
                  {entity.type === 'actor' &&
                    renderBadge(
                      'actor',
                      'Actor',
                      <Users className="h-3 w-3" />,
                      getBadgeColor()
                    )}
                  {entity.type === 'agent' &&
                    renderBadge(
                      'agent',
                      'Agent',
                      <Bot className="h-3 w-3" />,
                      getBadgeColor()
                    )}
                  {entity.type === 'app' &&
                    renderBadge(
                      'app',
                      'App',
                      <Building2 className="h-3 w-3" />,
                      getBadgeColor()
                    )}
                </div>
              </div>

              {(entity.bio || entity.description) && (
                <p className="mt-2 line-clamp-2 text-muted-foreground text-sm">
                  {entity.bio || entity.description}
                </p>
              )}

              {/* Moderation Flags */}
              <div className="mt-2 flex flex-wrap gap-1">
                {entity.isBanned && (
                  <span className="flex items-center gap-1 rounded bg-red-500/20 px-2 py-0.5 text-red-500 text-xs">
                    <Ban className="h-3 w-3" />
                    Banned
                  </span>
                )}
                {entity.isScammer && (
                  <span className="flex items-center gap-1 rounded bg-orange-500/20 px-2 py-0.5 text-orange-500 text-xs">
                    <Flag className="h-3 w-3" />
                    Scammer
                  </span>
                )}
                {entity.isCSAM && (
                  <span className="flex items-center gap-1 rounded bg-red-600/20 px-2 py-0.5 text-red-600 text-xs">
                    <AlertCircle className="h-3 w-3" />
                    CSAM
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-3 px-4 py-3">
          <div className="grid grid-cols-2 gap-2">
            {entity.balance && (
              <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm">
                <TrendingUp className="h-4 w-4 shrink-0 text-emerald-500" />
                <div className="min-w-0 flex-1">
                  <div className="text-muted-foreground text-xs">Balance</div>
                  <div className="truncate font-semibold text-foreground">
                    {parseFloat(entity.balance).toLocaleString()} BAB
                  </div>
                </div>
              </div>
            )}
            {(entity.reputationScore !== undefined ||
              entity.reputationPoints !== undefined) && (
              <div
                className={cn(
                  'flex items-center gap-2 rounded-xl border px-3 py-2 text-sm',
                  entity.reputationScore !== undefined &&
                    entity.reputationScore >= 80
                    ? 'border-green-500/20 bg-green-500/5'
                    : entity.reputationScore !== undefined &&
                        entity.reputationScore >= 60
                      ? 'border-yellow-500/20 bg-yellow-500/5'
                      : entity.reputationScore !== undefined &&
                          entity.reputationScore >= 40
                        ? 'border-orange-500/20 bg-orange-500/5'
                        : entity.reputationScore !== undefined &&
                            entity.reputationScore < 40
                          ? 'border-red-500/20 bg-red-500/5'
                          : 'border-purple-500/20 bg-purple-500/5'
                )}
              >
                <Star
                  className={cn(
                    'h-4 w-4 shrink-0',
                    entity.reputationScore !== undefined &&
                      entity.reputationScore >= 80
                      ? 'text-green-500'
                      : entity.reputationScore !== undefined &&
                          entity.reputationScore >= 60
                        ? 'text-yellow-500'
                        : entity.reputationScore !== undefined &&
                            entity.reputationScore >= 40
                          ? 'text-orange-500'
                          : entity.reputationScore !== undefined &&
                              entity.reputationScore < 40
                            ? 'text-red-500'
                            : 'text-purple-500'
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-muted-foreground text-xs">
                    Reputation
                  </div>
                  <div
                    className={cn(
                      'truncate font-semibold',
                      entity.reputationScore !== undefined &&
                        entity.reputationScore >= 80
                        ? 'text-green-500'
                        : entity.reputationScore !== undefined &&
                            entity.reputationScore >= 60
                          ? 'text-yellow-500'
                          : entity.reputationScore !== undefined &&
                              entity.reputationScore >= 40
                            ? 'text-orange-500'
                            : entity.reputationScore !== undefined &&
                                entity.reputationScore < 40
                              ? 'text-red-500'
                              : 'text-foreground'
                    )}
                  >
                    {entity.reputationScore !== undefined
                      ? `${Math.round(entity.reputationScore)}/100`
                      : `${entity.reputationPoints?.toLocaleString() || 0} pts`}
                  </div>
                  {entity.totalFeedbackCount !== undefined &&
                    entity.totalFeedbackCount > 0 && (
                      <div className="mt-0.5 text-muted-foreground text-xs">
                        {entity.totalFeedbackCount} reviews
                      </div>
                    )}
                </div>
              </div>
            )}
          </div>

          {entity.reputation && (
            <div className="grid grid-cols-2 gap-2 border-border border-t pt-2">
              <div className="text-sm">
                <div className="mb-1 text-muted-foreground text-xs">
                  Trust Score
                </div>
                <div className="font-semibold text-foreground">
                  {entity.reputation.trustScore.toFixed(2)}
                </div>
              </div>
              <div className="text-sm">
                <div className="mb-1 text-muted-foreground text-xs">
                  Accuracy
                </div>
                <div className="font-semibold text-foreground">
                  {entity.reputation.accuracyScore.toFixed(2)}%
                </div>
              </div>
            </div>
          )}

          {entity.stats && Object.keys(entity.stats).length > 0 && (
            <div className="grid grid-cols-2 gap-2 border-border border-t pt-2 text-sm">
              {entity.stats.followers !== undefined && (
                <div>
                  <span className="text-muted-foreground">Followers:</span>{' '}
                  <span className="font-semibold text-foreground">
                    {entity.stats.followers}
                  </span>
                </div>
              )}
              {entity.stats.positions !== undefined && (
                <div>
                  <span className="text-muted-foreground">Positions:</span>{' '}
                  <span className="font-semibold text-foreground">
                    {entity.stats.positions}
                  </span>
                </div>
              )}
              {entity.stats.pools !== undefined && (
                <div>
                  <span className="text-muted-foreground">Pools:</span>{' '}
                  <span className="font-semibold text-foreground">
                    {entity.stats.pools}
                  </span>
                </div>
              )}
              {entity.stats.trades !== undefined && (
                <div>
                  <span className="text-muted-foreground">Trades:</span>{' '}
                  <span className="font-semibold text-foreground">
                    {entity.stats.trades}
                  </span>
                </div>
              )}
            </div>
          )}

          {entity.tier && (
            <div className="pt-2">
              <span className="inline-block rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 font-bold text-amber-500 text-xs">
                {entity.tier}
              </span>
            </div>
          )}

          {entity.domain && entity.domain.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-2">
              {entity.domain.slice(0, 3).map((d: string) => (
                <span
                  key={d}
                  className="rounded-lg bg-muted px-2 py-1 text-muted-foreground text-xs"
                >
                  {d}
                </span>
              ))}
              {entity.domain.length > 3 && (
                <span className="rounded-lg bg-muted px-2 py-1 text-muted-foreground text-xs">
                  +{entity.domain.length - 3} more
                </span>
              )}
            </div>
          )}

          {(entity.a2aEndpoint || entity.mcpEndpoint) && (
            <div className="space-y-1 border-border border-t pt-2 text-xs">
              {entity.a2aEndpoint && (
                <div className="flex items-center gap-2">
                  <span className="font-medium text-muted-foreground">
                    A2A:
                  </span>
                  <a
                    href={entity.a2aEndpoint}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-1 truncate text-blue-500 transition-colors hover:text-blue-400"
                  >
                    <span className="truncate">{entity.a2aEndpoint}</span>
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                </div>
              )}
              {entity.mcpEndpoint && (
                <div className="flex items-center gap-2">
                  <span className="font-medium text-muted-foreground">
                    MCP:
                  </span>
                  <a
                    href={entity.mcpEndpoint}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-1 truncate text-blue-500 transition-colors hover:text-blue-400"
                  >
                    <span className="truncate">{entity.mcpEndpoint}</span>
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                </div>
              )}
            </div>
          )}

          {/* Admin Actions */}
          {entity.type === 'user' && !entity.isActor && (
            <div className="flex gap-2 border-border border-t pt-3">
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setSelectedEntity(entity);
                  setShowBanModal(true);
                }}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1 rounded-lg px-3 py-2 font-medium text-sm transition-colors',
                  entity.isBanned
                    ? 'bg-green-500/20 text-green-500 hover:bg-green-500/30'
                    : 'bg-red-500/20 text-red-500 hover:bg-red-500/30'
                )}
                title={entity.isBanned ? 'Unban user' : 'Ban user'}
              >
                <Ban className="h-4 w-4" />
                {entity.isBanned ? 'Unban' : 'Ban'}
              </button>
            </div>
          )}
        </div>
      </>
    );

    if (profileUrl) {
      return (
        <Link
          key={entity.id}
          href={profileUrl}
          className={cn(
            'block overflow-hidden rounded-2xl border border-border bg-card transition-all duration-200',
            'cursor-pointer hover:border-primary/50 hover:shadow-lg'
          )}
        >
          {cardContent}
        </Link>
      );
    }

    return (
      <div
        key={entity.id}
        className="block overflow-hidden rounded-2xl border border-border bg-card transition-all duration-200 hover:border-primary/50 hover:shadow-lg"
      >
        {cardContent}
      </div>
    );
  };

  const handleBanUser = async (
    entity: RegistryEntity,
    action: 'ban' | 'unban'
  ) => {
    if (action === 'ban' && !banReason.trim()) {
      toast.error('Please provide a reason for banning');
      return;
    }

    setIsBanning(true);
    const token = getAuthToken();
    const response = await fetch(apiUrl(`/api/admin/users/${entity.id}/ban`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        action,
        reason: action === 'ban' ? banReason : undefined,
        isScammer: action === 'ban' ? isScammer : false,
        isCSAM: action === 'ban' ? isCSAM : false,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      setIsBanning(false);
      toast.error(error.message || 'Failed to update user');
      return;
    }

    toast.success(
      action === 'ban'
        ? 'User banned successfully'
        : 'User unbanned successfully'
    );
    setShowBanModal(false);
    setBanReason('');
    setIsScammer(false);
    setIsCSAM(false);
    setSelectedEntity(null);
    fetchRegistry();
    setIsBanning(false);
  };

  const allEntities = data
    ? [...data.users, ...data.actors, ...data.agents, ...data.apps]
    : [];

  const getActiveEntities = () => {
    if (!data) return [];
    switch (activeTab) {
      case 'users':
        return data.users;
      case 'actors':
        return data.actors;
      case 'agents':
        return data.agents;
      case 'apps':
        return data.apps;
      default:
        return allEntities;
    }
  };

  const activeEntities = getActiveEntities();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-2 font-bold text-3xl text-foreground">
          ERC8004 Registry
        </h2>
        <p className="text-muted-foreground">
          Browse all registered entities in the Babylon ecosystem
        </p>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="flex-1">
          <SearchBar
            value={search}
            onChange={setSearch}
            placeholder="Search by name, username, or description..."
          />
        </div>
      </div>

      {data && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          <div className="rounded-2xl border border-border bg-card px-4 py-3">
            <div className="mb-1 text-muted-foreground text-sm">Total</div>
            <div className="font-bold text-3xl text-foreground">
              {data.totals.total}
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-card px-4 py-3">
            <div className="mb-1 flex items-center gap-1 text-muted-foreground text-sm">
              <UserCircle className="h-4 w-4" />
              <span>Users</span>
            </div>
            <div className="font-bold text-3xl text-foreground">
              {data.totals.users}
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-card px-4 py-3">
            <div className="mb-1 flex items-center gap-1 text-muted-foreground text-sm">
              <Users className="h-4 w-4" />
              <span>Actors</span>
            </div>
            <div className="font-bold text-3xl text-foreground">
              {data.totals.actors}
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-card px-4 py-3">
            <div className="mb-1 flex items-center gap-1 text-muted-foreground text-sm">
              <Bot className="h-4 w-4" />
              <span>Agents</span>
            </div>
            <div className="font-bold text-3xl text-foreground">
              {data.totals.agents}
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-card px-4 py-3">
            <div className="mb-1 flex items-center gap-1 text-muted-foreground text-sm">
              <Building2 className="h-4 w-4" />
              <span>Apps</span>
            </div>
            <div className="font-bold text-3xl text-foreground">
              {data.totals.apps}
            </div>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="w-full max-w-2xl space-y-4 text-center">
            <Skeleton className="mx-auto h-8 w-48" />
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              <Skeleton className="h-48 w-full" />
              <Skeleton className="h-48 w-full" />
              <Skeleton className="h-48 w-full" />
            </div>
          </div>
        </div>
      )}

      {error && !loading && (
        <div className="flex items-center justify-center py-20">
          <div className="max-w-md text-center">
            <AlertCircle className="mx-auto mb-4 h-12 w-12 text-red-500" />
            <h3 className="mb-2 font-semibold text-foreground text-lg">
              Failed to load registry
            </h3>
            <p className="mb-4 text-muted-foreground">{error}</p>
            <button
              onClick={fetchRegistry}
              className="rounded-lg bg-primary px-4 py-2 text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Try Again
            </button>
          </div>
        </div>
      )}

      {!loading && !error && data && (
        <>
          <div className="mb-2 flex gap-2 overflow-x-auto pb-2">
            <button
              onClick={() => setActiveTab('all')}
              className={cn(
                'whitespace-nowrap rounded-lg px-4 py-3 font-semibold transition-all duration-200',
                activeTab === 'all'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              )}
            >
              All ({data.totals.total})
            </button>
            <button
              onClick={() => setActiveTab('users')}
              className={cn(
                'flex items-center gap-2 whitespace-nowrap rounded-lg px-4 py-3 font-semibold transition-all duration-200',
                activeTab === 'users'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              )}
            >
              <UserCircle className="h-4 w-4" />
              Users ({data.totals.users})
            </button>
            <button
              onClick={() => setActiveTab('actors')}
              className={cn(
                'flex items-center gap-2 whitespace-nowrap rounded-lg px-4 py-3 font-semibold transition-all duration-200',
                activeTab === 'actors'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              )}
            >
              <Users className="h-4 w-4" />
              Actors ({data.totals.actors})
            </button>
            <button
              onClick={() => setActiveTab('agents')}
              className={cn(
                'flex items-center gap-2 whitespace-nowrap rounded-lg px-4 py-3 font-semibold transition-all duration-200',
                activeTab === 'agents'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              )}
            >
              <Bot className="h-4 w-4" />
              Agents ({data.totals.agents})
            </button>
            <button
              onClick={() => setActiveTab('apps')}
              className={cn(
                'flex items-center gap-2 whitespace-nowrap rounded-lg px-4 py-3 font-semibold transition-all duration-200',
                activeTab === 'apps'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              )}
            >
              <Building2 className="h-4 w-4" />
              Apps ({data.totals.apps})
            </button>
          </div>

          {activeEntities.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {activeEntities.map((entity) => renderEntityCard(entity))}
            </div>
          ) : (
            <div className="py-20 text-center">
              <Search className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
              <h3 className="mb-2 font-semibold text-foreground text-lg">
                No entities found
              </h3>
              <p className="text-muted-foreground">
                Try adjusting your search or filters
              </p>
            </div>
          )}
        </>
      )}

      {/* Feedback Modal */}
      {showFeedbackModal && selectedEntity && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6">
            <h2 className="mb-4 font-bold text-xl">Give Feedback</h2>
            <p className="mb-4 text-muted-foreground">
              Rate <strong>{selectedEntity.name}</strong>
            </p>

            <FeedbackForm
              toUserId={selectedEntity.id}
              toUserName={selectedEntity.name}
              category="general"
              onSuccess={() => {
                setShowFeedbackModal(false);
                setSelectedEntity(null);
                fetchRegistry();
              }}
              onCancel={() => {
                setShowFeedbackModal(false);
                setSelectedEntity(null);
              }}
            />
          </div>
        </div>
      )}

      {/* Ban Modal */}
      {showBanModal && selectedEntity && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6">
            <h2 className="mb-4 font-bold text-xl">
              {selectedEntity.isBanned ? 'Unban User' : 'Ban User'}
            </h2>
            <p className="mb-4 text-muted-foreground">
              {selectedEntity.isBanned
                ? `Are you sure you want to unban ${selectedEntity.name}?`
                : `Are you sure you want to ban ${selectedEntity.name}?`}
            </p>

            {!selectedEntity.isBanned && (
              <>
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
                        This user is engaging in fraudulent or deceptive
                        behavior
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
              </>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowBanModal(false);
                  setBanReason('');
                  setIsScammer(false);
                  setIsCSAM(false);
                  setSelectedEntity(null);
                }}
                className="flex-1 rounded-lg bg-muted px-4 py-2 text-foreground transition-colors hover:bg-muted/80"
              >
                Cancel
              </button>
              <button
                onClick={() =>
                  handleBanUser(
                    selectedEntity,
                    selectedEntity.isBanned ? 'unban' : 'ban'
                  )
                }
                disabled={
                  isBanning || (!selectedEntity.isBanned && !banReason.trim())
                }
                className={cn(
                  'flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 transition-colors disabled:opacity-50',
                  selectedEntity.isBanned
                    ? 'bg-green-500 text-white hover:bg-green-600'
                    : 'bg-red-500 text-white hover:bg-red-600'
                )}
              >
                <Ban className="h-4 w-4" />
                {isBanning
                  ? 'Processing...'
                  : selectedEntity.isBanned
                    ? 'Unban User'
                    : 'Ban User'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
