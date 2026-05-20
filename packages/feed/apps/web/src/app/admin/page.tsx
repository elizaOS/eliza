/**
 * Admin Dashboard Page
 *
 * @description Main admin dashboard providing access to various administrative tabs for managing
 * system statistics, game control, fees, users, groups, notifications, reports, AI models,
 * training data, agents, and escrow. Requires admin authentication.
 *
 * @page /admin
 * @access Admin only
 *
 * @features
 * - Admin authentication check
 * - Tabbed interface for different admin functions
 * - System statistics and monitoring
 * - Game engine control
 * - User management
 * - Moderation tools (reports, human review)
 * - AI model configuration
 * - Training data management
 * - Agent management
 * - Escrow management
 *
 * @example
 * ```tsx
 * // Accessible at /admin
 * // Requires admin privileges
 * <AdminDashboard />
 * ```
 */

'use client';

export const dynamic = 'force-dynamic';

import { cn, logger } from '@feed/shared';
import {
  Activity,
  BarChart,
  Bell,
  Bot,
  ChevronDown,
  Crown,
  Database,
  DollarSign,
  Eye,
  Flag,
  Gamepad2,
  Layers,
  LineChart,
  MessageCircle,
  MessageSquare,
  Scale,
  ScrollText,
  Server,
  Shield,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminManagementTab } from '@/components/admin/AdminManagementTab';
import { AgentsTab } from '@/components/admin/AgentsTab';
import { AIModelsTab } from '@/components/admin/AIModelsTab';
import { AlphaGroupsTab } from '@/components/admin/AlphaGroupsTab';
import { AnalyticsTab } from '@/components/admin/AnalyticsTab';
import { AuditLogsTab } from '@/components/admin/AuditLogsTab';
import { ContentModerationTab } from '@/components/admin/ContentModerationTab';
import { EscrowManagementTab } from '@/components/admin/EscrowManagementTab';
import { FeedbackTab } from '@/components/admin/FeedbackTab';
import { FeesTab } from '@/components/admin/FeesTab';
import { GameControlTab } from '@/components/admin/GameControlTab';
import { GroupsTab } from '@/components/admin/GroupsTab';
import { GrowthMetricsTab } from '@/components/admin/GrowthMetricsTab';
import { HumanReviewTab } from '@/components/admin/HumanReviewTab';
import { MarketOversightTab } from '@/components/admin/MarketOversightTab';
import { NotificationsTab } from '@/components/admin/NotificationsTab';
import { RegistryTab } from '@/components/admin/RegistryTab';
import { ReportsTab } from '@/components/admin/ReportsTab';
import { StatsTab } from '@/components/admin/StatsTab';
import { SystemHealthTab } from '@/components/admin/SystemHealthTab';
import { TradingFeedTab } from '@/components/admin/TradingFeedTab';
import { TrainingDataTab } from '@/components/admin/TrainingDataTab';
import { UserManagementTab } from '@/components/admin/UserManagementTab';
import { WhitelistTab } from '@/components/admin/WhitelistTab';
import { PageContainer } from '@/components/shared/PageContainer';
import { Skeleton } from '@/components/shared/Skeleton';
import { useAuth } from '@/hooks/useAuth';
import { useOnClickOutside } from '@/hooks/useOnClickOutside';
import { apiUrl } from '@/utils/api-url';

/**
 * Available admin dashboard tabs
 */
type Tab =
  | 'stats'
  | 'analytics'
  | 'growth'
  | 'system-health'
  | 'game-control'
  | 'fees'
  | 'trades'
  | 'markets'
  | 'users'
  | 'content-moderation'
  | 'registry'
  | 'groups'
  | 'notifications'
  | 'admins'
  | 'reports'
  | 'feedback'
  | 'human-review'
  | 'ai-models'
  | 'training-data'
  | 'agents'
  | 'escrow'
  | 'audit-logs'
  | 'alpha-groups'
  | 'whitelist';

/**
 * Admin Dashboard Component
 *
 * @description Main admin dashboard with tabbed interface for system management
 *
 * @returns {JSX.Element} Admin dashboard page
 */
export default function AdminDashboard() {
  const router = useRouter();
  const { authenticated, ready } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('stats');
  const [isAuthorized, setIsAuthorized] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  // IMPORTANT: All hooks must be declared before any conditional returns
  // to comply with React's Rules of Hooks
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const closeDropdown = useCallback(() => setIsDropdownOpen(false), []);
  useOnClickOutside(dropdownRef, closeDropdown);

  const checkAdminAccess = useCallback(async () => {
    if (!ready) {
      setLoading(true);
      return;
    }

    if (!authenticated) {
      // Don't redirect on localhost - let them see the login prompt
      const isLocalhost =
        typeof window !== 'undefined' &&
        (window.location.hostname === 'localhost' ||
          window.location.hostname === '127.0.0.1');

      if (!isLocalhost) {
        router.push('/');
        return;
      }

      setIsAuthorized(false);
      setLoading(false);
      return;
    }

    // Check if user is admin by trying to fetch admin stats
    const response = await fetch(apiUrl('/api/admin/stats')).catch(
      (error: Error) => {
        logger.error(
          'Admin access check failed',
          error instanceof Error ? error : { error },
          'AdminPage'
        );
        setIsAuthorized(false);
        setLoading(false);
        throw error;
      }
    );

    if (!response.ok) {
      setIsAuthorized(false);
      setLoading(false);
      return;
    }

    setIsAuthorized(true);
    setLoading(false);
  }, [authenticated, ready, router]);

  useEffect(() => {
    checkAdminAccess();
  }, [checkAdminAccess]);

  if (loading) {
    return (
      <PageContainer>
        <div className="flex h-full items-center justify-center">
          <div className="w-full max-w-md space-y-4">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
        </div>
      </PageContainer>
    );
  }

  if (!isAuthorized) {
    return (
      <PageContainer>
        <div className="flex h-full flex-col items-center justify-center">
          <Shield className="mb-4 h-16 w-16 text-muted-foreground" />
          <h1 className="mb-2 font-bold text-2xl">Access Denied</h1>
          <p className="text-muted-foreground">
            You don&apos;t have permission to access the admin dashboard.
          </p>
        </div>
      </PageContainer>
    );
  }

  // Navigation items organized by category
  const navCategories = [
    {
      name: 'Overview',
      items: [
        { id: 'stats' as const, label: 'Dashboard', icon: BarChart },
        { id: 'analytics' as const, label: 'Analytics', icon: LineChart },
        { id: 'growth' as const, label: 'Growth Metrics', icon: TrendingUp },
        { id: 'system-health' as const, label: 'System Health', icon: Server },
      ],
    },
    {
      name: 'Game & Markets',
      items: [
        { id: 'game-control' as const, label: 'Game Control', icon: Gamepad2 },
        { id: 'markets' as const, label: 'Markets', icon: TrendingUp },
        { id: 'fees' as const, label: 'Fees', icon: DollarSign },
        { id: 'trades' as const, label: 'Trades', icon: Activity },
        { id: 'escrow' as const, label: 'Escrow', icon: DollarSign },
      ],
    },
    {
      name: 'Users & Moderation',
      items: [
        { id: 'users' as const, label: 'Users', icon: Users },
        { id: 'admins' as const, label: 'Admin Management', icon: ShieldCheck },
        {
          id: 'content-moderation' as const,
          label: 'Content Moderation',
          icon: Eye,
        },
        { id: 'reports' as const, label: 'Reports', icon: Flag },
        {
          id: 'feedback' as const,
          label: 'Game Feedback',
          icon: MessageCircle,
        },
        { id: 'human-review' as const, label: 'Human Review', icon: Scale },
      ],
    },
    {
      name: 'Platform',
      items: [
        { id: 'registry' as const, label: 'Registry', icon: Layers },
        { id: 'groups' as const, label: 'Groups', icon: MessageSquare },
        { id: 'alpha-groups' as const, label: 'Alpha Groups', icon: Crown },
        { id: 'notifications' as const, label: 'Notifications', icon: Bell },
        { id: 'whitelist' as const, label: 'Whitelist', icon: Shield },
      ],
    },
    {
      name: 'AI & Agents',
      items: [
        { id: 'agents' as const, label: 'Agents', icon: Bot },
        { id: 'ai-models' as const, label: 'AI Models', icon: Sparkles },
        {
          id: 'training-data' as const,
          label: 'Training Data',
          icon: Database,
        },
      ],
    },
    {
      name: 'Audit',
      items: [
        { id: 'audit-logs' as const, label: 'Audit Logs', icon: ScrollText },
      ],
    },
  ];

  // Default tab for fallback (should never be needed since activeTab is always a valid Tab)
  const defaultTab = {
    id: 'stats' as const,
    label: 'Dashboard',
    icon: BarChart,
  };

  // Get current tab info by searching through categories
  const getCurrentTab = () => {
    for (const category of navCategories) {
      for (const item of category.items) {
        if (item.id === activeTab) {
          return item;
        }
      }
    }
    // Fallback should never trigger since activeTab is typed as Tab
    return defaultTab;
  };
  const currentTab = getCurrentTab();
  const CurrentIcon = currentTab.icon;

  return (
    <PageContainer className="flex flex-col pt-6" data-testid="admin-dashboard">
      {/* Header with Dropdown Navigation */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Shield className="h-7 w-7 text-primary" />
          <div>
            <h1 className="font-bold text-xl sm:text-2xl">Admin Dashboard</h1>
            <p className="text-muted-foreground text-xs sm:text-sm">
              System management and monitoring
            </p>
          </div>
        </div>

        {/* Navigation Dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            data-testid="admin-nav-dropdown"
            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
            className={cn(
              'flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 font-medium transition-all sm:w-auto sm:min-w-[220px]',
              'hover:border-primary/50 hover:bg-card/80',
              isDropdownOpen && 'border-primary ring-2 ring-primary/20'
            )}
          >
            <div className="flex items-center gap-2">
              <CurrentIcon className="h-4 w-4 text-primary" />
              <span>{currentTab.label}</span>
            </div>
            <ChevronDown
              className={cn(
                'h-4 w-4 text-muted-foreground transition-transform',
                isDropdownOpen && 'rotate-180'
              )}
            />
          </button>

          {/* Dropdown Menu */}
          <div
            className={cn(
              'absolute z-50 mt-2 max-h-[70vh] w-full min-w-[280px] overflow-y-auto rounded-xl border border-border bg-card shadow-xl sm:w-auto',
              isDropdownOpen
                ? 'pointer-events-auto right-0 opacity-100'
                : 'pointer-events-none right-0 opacity-0'
            )}
          >
            {navCategories.map((category, categoryIndex) => (
              <div key={category.name}>
                {categoryIndex > 0 && (
                  <div className="mx-3 border-border border-t" />
                )}
                <div className="px-3 py-2">
                  <div className="mb-1 px-2 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                    {category.name}
                  </div>
                  {category.items.map((item) => {
                    const Icon = item.icon;
                    const isActive = activeTab === item.id;
                    return (
                      <button
                        key={item.id}
                        data-testid={`admin-tab-${item.id}`}
                        onClick={() => {
                          setActiveTab(item.id);
                          setIsDropdownOpen(false);
                        }}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                          isActive
                            ? 'bg-primary/10 font-medium text-primary'
                            : 'text-foreground hover:bg-muted'
                        )}
                      >
                        <Icon
                          className={cn(
                            'h-4 w-4',
                            isActive ? 'text-primary' : 'text-muted-foreground'
                          )}
                        />
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'stats' && <StatsTab />}
        {activeTab === 'analytics' && <AnalyticsTab />}
        {activeTab === 'growth' && <GrowthMetricsTab />}
        {activeTab === 'system-health' && <SystemHealthTab />}
        {activeTab === 'game-control' && <GameControlTab />}
        {activeTab === 'markets' && <MarketOversightTab />}
        {activeTab === 'fees' && <FeesTab />}
        {activeTab === 'trades' && <TradingFeedTab />}
        {activeTab === 'users' && <UserManagementTab />}
        {activeTab === 'content-moderation' && <ContentModerationTab />}
        {activeTab === 'reports' && <ReportsTab />}
        {activeTab === 'feedback' && <FeedbackTab />}
        {activeTab === 'human-review' && <HumanReviewTab />}
        {activeTab === 'admins' && <AdminManagementTab />}
        {activeTab === 'registry' && <RegistryTab />}
        {activeTab === 'groups' && <GroupsTab />}
        {activeTab === 'agents' && <AgentsTab />}
        {activeTab === 'ai-models' && <AIModelsTab />}
        {activeTab === 'training-data' && <TrainingDataTab />}
        {activeTab === 'notifications' && <NotificationsTab />}
        {activeTab === 'escrow' && <EscrowManagementTab />}
        {activeTab === 'audit-logs' && <AuditLogsTab />}
        {activeTab === 'alpha-groups' && <AlphaGroupsTab />}
        {activeTab === 'whitelist' && <WhitelistTab />}
      </div>
    </PageContainer>
  );
}
