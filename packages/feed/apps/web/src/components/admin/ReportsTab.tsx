/**
 * Reports tab component for viewing and managing user reports.
 *
 * Displays all user reports with filtering by status and priority. Shows
 * report details, evaluation results, and provides resolution functionality.
 * Includes report statistics and AI evaluation display.
 *
 * Features:
 * - Reports list display
 * - Status filtering
 * - Priority filtering
 * - Report details view
 * - AI evaluation display
 * - Resolution functionality
 * - Report statistics
 * - Loading states
 * - Error handling
 *
 * @returns Reports tab element
 */
'use client';

import { cn, logger } from '@feed/shared';
import { AlertCircle, CheckCircle, Clock, Flag, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/shared/Avatar';
import { Skeleton } from '@/components/shared/Skeleton';
import { apiUrl } from '@/utils/api-url';

/**
 * Report evaluation structure from AI.
 */
interface ReportEvaluation {
  outcome:
    | 'valid_report'
    | 'invalid_report'
    | 'abusive_reporter'
    | 'insufficient_evidence';
  confidence: number;
  reasoning: string;
  recommendedActions: string[];
  evidenceSummary: {
    chatMessages: number;
    posts: number;
    reportsReceived: number;
    reportsSent: number;
  };
}

/**
 * Report structure for reports tab.
 */
interface Report {
  id: string;
  reportType: string;
  category: string;
  reason: string;
  evidence: string | null;
  status: string;
  priority: string;
  resolution: string | null;
  evaluation?: ReportEvaluation | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  reporter: {
    id: string;
    username: string | null;
    displayName: string | null;
    profileImageUrl: string | null;
  };
  reportedUser: {
    id: string;
    username: string | null;
    displayName: string | null;
    profileImageUrl: string | null;
    isBanned: boolean;
  } | null;
  resolver: {
    id: string;
    username: string | null;
    displayName: string | null;
  } | null;
}

/**
 * Report statistics structure.
 */
interface ReportStats {
  totals: {
    total: number;
    pending: number;
    reviewing: number;
    resolved: number;
    dismissed: number;
  };
}

/**
 * Status filter type for reports tab.
 */
type StatusFilter = 'all' | 'pending' | 'reviewing' | 'resolved' | 'dismissed';
/**
 * Priority filter type for reports tab.
 */
type PriorityFilter = 'all' | 'low' | 'normal' | 'high' | 'critical';

export function ReportsTab() {
  const [reports, setReports] = useState<Report[]>([]);
  const [stats, setStats] = useState<ReportStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('all');
  const [selectedReport, setSelectedReport] = useState<Report | null>(null);
  const [showActionModal, setShowActionModal] = useState(false);
  const [showEvaluationModal, setShowEvaluationModal] = useState(false);
  const [evaluatingReportId, setEvaluatingReportId] = useState<string | null>(
    null
  );
  const [, startRefresh] = useTransition();

  const fetchReports = useCallback(
    (showRefreshing = false) => {
      const fetchLogic = async () => {
        try {
          const params = new URLSearchParams({
            limit: '100',
          });
          if (statusFilter !== 'all') params.set('status', statusFilter);
          if (priorityFilter !== 'all') params.set('priority', priorityFilter);

          const response = await fetch(apiUrl(`/api/admin/reports?${params}`));
          if (!response.ok) {
            logger.error(
              'Failed to fetch reports',
              { status: response.status },
              'ReportsTab'
            );
            setLoading(false);
            return;
          }

          const data = await response.json();
          setReports(data.reports || []);
          setLoading(false);
        } catch (err) {
          logger.error(
            'Error fetching reports',
            err instanceof Error ? err : { error: err },
            'ReportsTab'
          );
          setLoading(false);
        }
      };

      if (showRefreshing) {
        startRefresh(fetchLogic);
      } else {
        void fetchLogic();
      }
    },
    [statusFilter, priorityFilter]
  );

  const fetchStats = useCallback(() => {
    const fetchLogic = async () => {
      try {
        const response = await fetch(apiUrl('/api/admin/reports/stats'));
        if (!response.ok) return;

        const data = await response.json();
        setStats(data);
      } catch (err) {
        logger.error(
          'Error fetching report stats',
          err instanceof Error ? err : { error: err },
          'ReportsTab'
        );
      }
    };
    void fetchLogic();
  }, []);

  useEffect(() => {
    fetchReports();
    fetchStats();
  }, [fetchReports, fetchStats]);

  const handleAction = async (
    reportId: string,
    action: string,
    resolution: string
  ) => {
    const response = await fetch(apiUrl(`/api/admin/reports/${reportId}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, resolution }),
    });

    if (!response.ok) {
      const error = await response.json();
      toast.error(error.message || 'Failed to take action');
      return;
    }

    setShowActionModal(false);
    setSelectedReport(null);
    fetchReports(true);
    fetchStats();
  };

  const handleEvaluate = async (reportId: string) => {
    setEvaluatingReportId(reportId);
    const response = await fetch(apiUrl(`/api/admin/reports/${reportId}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'evaluate' }),
    });

    if (!response.ok) {
      const error = await response.json();
      toast.error(error.message || 'Failed to evaluate report');
      setEvaluatingReportId(null);
      return;
    }

    const data = await response.json();

    // Refresh reports to show evaluation
    await fetchReports(true);

    // Show evaluation modal if we have the report selected
    const report = reports.find((r) => r.id === reportId);
    if (report && data.evaluation) {
      setSelectedReport({ ...report, evaluation: data.evaluation });
      setShowEvaluationModal(true);
    }
    setEvaluatingReportId(null);
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'hate_speech':
      case 'violence':
      case 'self_harm':
        return 'text-red-500 bg-red-500/10 border-red-500/20';
      case 'harassment':
        return 'text-orange-500 bg-orange-500/10 border-orange-500/20';
      case 'spam':
        return 'text-yellow-500 bg-yellow-500/10 border-yellow-500/20';
      default:
        return 'text-blue-500 bg-blue-500/10 border-blue-500/20';
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'critical':
        return 'text-red-600 bg-red-600/10';
      case 'high':
        return 'text-orange-600 bg-orange-600/10';
      case 'normal':
        return 'text-blue-600 bg-blue-600/10';
      case 'low':
        return 'text-gray-600 bg-gray-600/10';
      default:
        return 'text-gray-600 bg-gray-600/10';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'pending':
        return <Clock className="h-4 w-4 text-yellow-500" />;
      case 'reviewing':
        return <AlertCircle className="h-4 w-4 text-blue-500" />;
      case 'resolved':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'dismissed':
        return <XCircle className="h-4 w-4 text-gray-500" />;
      default:
        return null;
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats Overview */}
      {stats && (
        <div className="grid grid-cols-2 gap-2 sm:gap-4 md:grid-cols-3 lg:grid-cols-5">
          <div className="rounded-lg border border-border bg-card p-3 sm:p-4">
            <div className="mb-0.5 text-muted-foreground text-xs sm:mb-1 sm:text-sm">
              Total
            </div>
            <div className="font-bold text-xl sm:text-2xl">
              {stats.totals.total}
            </div>
          </div>
          <div className="rounded-lg border border-yellow-500/20 bg-card p-3 sm:p-4">
            <div className="mb-0.5 text-muted-foreground text-xs sm:mb-1 sm:text-sm">
              Pending
            </div>
            <div className="font-bold text-xl text-yellow-500 sm:text-2xl">
              {stats.totals.pending}
            </div>
          </div>
          <div className="rounded-lg border border-blue-500/20 bg-card p-3 sm:p-4">
            <div className="mb-0.5 text-muted-foreground text-xs sm:mb-1 sm:text-sm">
              Reviewing
            </div>
            <div className="font-bold text-blue-500 text-xl sm:text-2xl">
              {stats.totals.reviewing}
            </div>
          </div>
          <div className="rounded-lg border border-green-500/20 bg-card p-3 sm:p-4">
            <div className="mb-0.5 text-muted-foreground text-xs sm:mb-1 sm:text-sm">
              Resolved
            </div>
            <div className="font-bold text-green-500 text-xl sm:text-2xl">
              {stats.totals.resolved}
            </div>
          </div>
          <div className="col-span-2 rounded-lg border border-border bg-card p-3 sm:p-4 md:col-span-1">
            <div className="mb-0.5 text-muted-foreground text-xs sm:mb-1 sm:text-sm">
              Dismissed
            </div>
            <div className="font-bold text-xl sm:text-2xl">
              {stats.totals.dismissed}
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-4">
        <div className="flex flex-wrap gap-1.5 sm:gap-2">
          <span className="mr-1 self-center text-muted-foreground text-xs sm:text-sm">
            Status:
          </span>
          {(
            ['all', 'pending', 'reviewing', 'resolved', 'dismissed'] as const
          ).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                'rounded px-2 py-1 font-medium text-[10px] transition-colors sm:px-3 sm:py-1.5 sm:text-sm',
                statusFilter === s
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              )}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-1.5 sm:gap-2">
          <span className="mr-1 self-center text-muted-foreground text-xs sm:text-sm">
            Priority:
          </span>
          {(['all', 'critical', 'high', 'normal', 'low'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPriorityFilter(p)}
              className={cn(
                'rounded px-2 py-1 font-medium text-[10px] transition-colors sm:px-3 sm:py-1.5 sm:text-sm',
                priorityFilter === p
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              )}
            >
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Reports List */}
      {reports.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          <Flag className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p>No reports found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {reports.map((report) => (
            <div
              key={report.id}
              className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/50"
            >
              <div className="flex items-start gap-4">
                {/* Status Icon */}
                <div className="pt-1">{getStatusIcon(report.status)}</div>

                {/* Content */}
                <div className="min-w-0 flex-1">
                  {/* Header */}
                  <div className="mb-2 flex items-start justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          'rounded border px-2 py-0.5 font-medium text-xs',
                          getCategoryColor(report.category)
                        )}
                      >
                        {report.category.replace('_', ' ')}
                      </span>
                      <span
                        className={cn(
                          'rounded px-2 py-0.5 font-medium text-xs',
                          getPriorityColor(report.priority)
                        )}
                      >
                        {report.priority}
                      </span>
                      <span className="rounded bg-purple-500/10 px-2 py-0.5 font-medium text-purple-500 text-xs">
                        {report.reportType}
                      </span>
                    </div>
                    <div className="whitespace-nowrap text-muted-foreground text-xs">
                      {formatDate(report.createdAt)}
                    </div>
                  </div>

                  {/* Reporter & Reported User */}
                  <div className="mb-3 flex items-center gap-4 text-sm">
                    <div className="flex items-center gap-2">
                      <Avatar
                        src={report.reporter.profileImageUrl || undefined}
                        alt={report.reporter.displayName || 'Reporter'}
                        size="sm"
                      />
                      <span className="text-muted-foreground">
                        {report.reporter.displayName ||
                          report.reporter.username}{' '}
                        reported
                      </span>
                    </div>
                    {report.reportedUser && (
                      <>
                        <span className="text-muted-foreground">→</span>
                        <div className="flex items-center gap-2">
                          <Avatar
                            src={
                              report.reportedUser.profileImageUrl || undefined
                            }
                            alt={
                              report.reportedUser.displayName || 'Reported user'
                            }
                            size="sm"
                          />
                          <span className="font-medium">
                            {report.reportedUser.displayName ||
                              report.reportedUser.username}
                          </span>
                          {report.reportedUser.isBanned && (
                            <span className="rounded bg-red-500/20 px-2 py-0.5 text-red-500 text-xs">
                              Banned
                            </span>
                          )}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Reason */}
                  <p className="mb-3 line-clamp-2 text-muted-foreground text-sm">
                    {report.reason}
                  </p>

                  {/* Evaluation Badge */}
                  {report.evaluation && (
                    <div className="mb-2">
                      <span
                        className={cn(
                          'rounded px-2 py-1 font-medium text-xs',
                          report.evaluation.outcome === 'valid_report'
                            ? 'bg-green-500/20 text-green-500'
                            : report.evaluation.outcome === 'abusive_reporter'
                              ? 'bg-red-500/20 text-red-500'
                              : report.evaluation.outcome === 'invalid_report'
                                ? 'bg-yellow-500/20 text-yellow-500'
                                : 'bg-gray-500/20 text-gray-500'
                        )}
                      >
                        {report.evaluation.outcome.replace('_', ' ')} (
                        {Math.round(report.evaluation.confidence * 100)}%)
                      </span>
                    </div>
                  )}

                  {/* Actions */}
                  {report.status === 'pending' ||
                  report.status === 'reviewing' ? (
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => handleEvaluate(report.id)}
                        disabled={evaluatingReportId === report.id}
                        className="rounded bg-purple-500 px-3 py-1 text-sm text-white transition-colors hover:bg-purple-600 disabled:opacity-50"
                      >
                        {evaluatingReportId === report.id
                          ? 'Evaluating...'
                          : 'Evaluate'}
                      </button>
                      <button
                        onClick={() => {
                          setSelectedReport(report);
                          setShowActionModal(true);
                        }}
                        className="rounded bg-primary px-3 py-1 text-primary-foreground text-sm transition-colors hover:bg-primary/90"
                      >
                        Take Action
                      </button>
                      <button
                        onClick={() =>
                          handleAction(
                            report.id,
                            'dismiss',
                            'Dismissed by admin'
                          )
                        }
                        className="rounded bg-muted px-3 py-1 text-foreground text-sm transition-colors hover:bg-muted/80"
                      >
                        Dismiss
                      </button>
                    </div>
                  ) : (
                    <div className="text-sm">
                      {report.evaluation && (
                        <button
                          onClick={() => {
                            setSelectedReport(report);
                            setShowEvaluationModal(true);
                          }}
                          className="mb-2 text-primary text-xs hover:underline"
                        >
                          View Evaluation Details
                        </button>
                      )}
                      {report.resolution && (
                        <div className="text-muted-foreground">
                          <strong>Resolution:</strong> {report.resolution}
                        </div>
                      )}
                      {report.resolver && (
                        <div className="mt-1 text-muted-foreground text-xs">
                          Resolved by{' '}
                          {report.resolver.displayName ||
                            report.resolver.username}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Action Modal */}
      {showActionModal && selectedReport && (
        <ActionModal
          report={selectedReport}
          onClose={() => {
            setShowActionModal(false);
            setSelectedReport(null);
          }}
          onAction={handleAction}
        />
      )}

      {/* Evaluation Modal */}
      {showEvaluationModal && selectedReport && selectedReport.evaluation && (
        <EvaluationModal
          report={selectedReport}
          evaluation={selectedReport.evaluation}
          onClose={() => {
            setShowEvaluationModal(false);
            setSelectedReport(null);
          }}
        />
      )}
    </div>
  );
}

interface ActionModalProps {
  report: Report;
  onClose: () => void;
  onAction: (reportId: string, action: string, resolution: string) => void;
}

interface EvaluationModalProps {
  report: Report;
  evaluation: ReportEvaluation;
  onClose: () => void;
}

function EvaluationModal({
  report,
  evaluation,
  onClose,
}: EvaluationModalProps) {
  const getOutcomeColor = (outcome: string) => {
    switch (outcome) {
      case 'valid_report':
        return 'text-green-500 bg-green-500/10 border-green-500/20';
      case 'abusive_reporter':
        return 'text-red-500 bg-red-500/10 border-red-500/20';
      case 'invalid_report':
        return 'text-yellow-500 bg-yellow-500/10 border-yellow-500/20';
      default:
        return 'text-gray-500 bg-gray-500/10 border-gray-500/20';
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-border bg-card p-6">
        <h2 className="mb-4 font-bold text-xl">Report Evaluation</h2>

        {/* Evaluation Outcome */}
        <div className="mb-4">
          <div
            className={cn(
              'rounded-lg border px-4 py-3',
              getOutcomeColor(evaluation.outcome)
            )}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="font-semibold text-lg">
                {evaluation.outcome.replace('_', ' ').toUpperCase()}
              </span>
              <span className="text-sm">
                Confidence: {Math.round(evaluation.confidence * 100)}%
              </span>
            </div>
            <p className="mt-2 text-sm">{evaluation.reasoning}</p>
          </div>
        </div>

        {/* Evidence Summary */}
        <div className="mb-4">
          <h3 className="mb-2 font-semibold text-sm">Evidence Collected</h3>
          <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
            <div className="rounded-lg bg-muted/50 p-2 sm:p-3">
              <div className="text-[10px] text-muted-foreground sm:text-xs">
                Chat Messages
              </div>
              <div className="font-bold text-base sm:text-lg">
                {evaluation.evidenceSummary.chatMessages}
              </div>
            </div>
            <div className="rounded-lg bg-muted/50 p-2 sm:p-3">
              <div className="text-[10px] text-muted-foreground sm:text-xs">
                Posts
              </div>
              <div className="font-bold text-base sm:text-lg">
                {evaluation.evidenceSummary.posts}
              </div>
            </div>
            <div className="rounded-lg bg-muted/50 p-2 sm:p-3">
              <div className="text-[10px] text-muted-foreground sm:text-xs">
                Reports Received
              </div>
              <div className="font-bold text-base sm:text-lg">
                {evaluation.evidenceSummary.reportsReceived}
              </div>
            </div>
            <div className="rounded-lg bg-muted/50 p-2 sm:p-3">
              <div className="text-[10px] text-muted-foreground sm:text-xs">
                Reports Sent
              </div>
              <div className="font-bold text-base sm:text-lg">
                {evaluation.evidenceSummary.reportsSent}
              </div>
            </div>
          </div>
        </div>

        {/* Recommended Actions */}
        {evaluation.recommendedActions.length > 0 && (
          <div className="mb-4">
            <h3 className="mb-2 font-semibold text-sm">Recommended Actions</h3>
            <ul className="list-inside list-disc space-y-1 text-muted-foreground text-sm">
              {evaluation.recommendedActions.map((action, index) => (
                <li key={index}>{action}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Report Details */}
        <div className="mb-4">
          <h3 className="mb-2 font-semibold text-sm">Report Details</h3>
          <div className="rounded-lg bg-muted/50 p-3 text-sm">
            <p>
              <strong>Category:</strong> {report.category.replace('_', ' ')}
            </p>
            <p>
              <strong>Reason:</strong> {report.reason}
            </p>
            {report.evidence && (
              <p>
                <strong>Evidence:</strong>{' '}
                <a
                  href={report.evidence}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  View
                </a>
              </p>
            )}
          </div>
        </div>

        {/* Close Button */}
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="rounded-lg bg-muted px-4 py-2 text-foreground transition-colors hover:bg-muted/80"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function ActionModal({ report, onClose, onAction }: ActionModalProps) {
  const [action, setAction] = useState('resolve');
  const [resolution, setResolution] = useState('');
  const [isSubmitting, startSubmit] = useTransition();

  const handleSubmit = () => {
    if (!resolution.trim()) {
      toast.error('Please provide a resolution message');
      return;
    }

    startSubmit(() => {
      onAction(report.id, action, resolution);
    });
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-card p-6">
        <h2 className="mb-4 font-bold text-xl">Take Action on Report</h2>

        {/* Report Details */}
        <div className="mb-4 rounded-lg bg-muted/50 p-4">
          <p className="mb-2 text-muted-foreground text-sm">
            <strong>Category:</strong> {report.category.replace('_', ' ')}
          </p>
          <p className="mb-2 text-muted-foreground text-sm">
            <strong>Reason:</strong> {report.reason}
          </p>
          {report.evidence && (
            <p className="text-muted-foreground text-sm">
              <strong>Evidence:</strong>{' '}
              <a
                href={report.evidence}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                View
              </a>
            </p>
          )}
        </div>

        {/* Evaluation Info */}
        {report.evaluation && (
          <div className="mb-4 rounded-lg bg-muted/50 p-3">
            <div className="mb-1 text-muted-foreground text-xs">
              AI Evaluation
            </div>
            <div className="text-sm">
              <strong>Outcome:</strong>{' '}
              {report.evaluation.outcome.replace('_', ' ')} (
              {Math.round(report.evaluation.confidence * 100)}% confidence)
            </div>
            <p className="mt-1 text-muted-foreground text-xs">
              Click "View Evaluation Details" in the report list to see full
              evaluation
            </p>
          </div>
        )}

        {/* Action Selection */}
        <div className="mb-4">
          <label className="mb-2 block font-medium text-sm">Action</label>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2"
          >
            <option value="resolve">
              Resolve (content removed/warning issued)
            </option>
            <option value="ban_user">Ban User</option>
            <option value="escalate">Escalate to Critical</option>
            <option value="dismiss">Dismiss</option>
          </select>
        </div>

        {/* Resolution Message */}
        <div className="mb-4">
          <label className="mb-2 block font-medium text-sm">
            Resolution Message
          </label>
          <textarea
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            placeholder="Explain the action taken..."
            className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2"
            rows={4}
          />
        </div>

        {/* Buttons */}
        <div className="flex gap-3">
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="flex-1 rounded-lg bg-muted px-4 py-2 transition-colors hover:bg-muted/80"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting || !resolution.trim()}
            className="flex-1 rounded-lg bg-primary px-4 py-2 text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {isSubmitting ? 'Submitting...' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}
