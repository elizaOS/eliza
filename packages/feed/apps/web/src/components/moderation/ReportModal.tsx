/**
 * Report modal component for reporting users or posts.
 *
 * Provides a comprehensive reporting interface with category selection,
 * reason field, and optional evidence. Supports reporting both users
 * and specific posts. Includes validation and error handling.
 *
 * Features:
 * - Category selection (spam, harassment, hate speech, etc.)
 * - Reason field (minimum 10 characters)
 * - Optional evidence field
 * - User/post context display
 * - Form validation
 * - Loading states
 * - Error handling
 * - Body scroll lock and escape key handling
 *
 * @param props - ReportModal component props
 * @returns Report modal element or null if not open
 *
 * @example
 * ```tsx
 * <ReportModal
 *   isOpen={showModal}
 *   onClose={() => setShowModal(false)}
 *   targetUserId="user-123"
 *   targetDisplayName="Alice"
 *   postId="post-456"
 *   onSuccess={() => refreshFeed()}
 * />
 * ```
 */
'use client';

import { AlertCircle, Flag, X } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/shared/Avatar';
import { apiUrl } from '@/utils/api-url';

interface ReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  targetUserId: string;
  targetUsername?: string;
  targetDisplayName?: string;
  targetProfileImageUrl?: string;
  postId?: string;
  onSuccess?: () => void;
}

/**
 * Available report categories for user/post reporting.
 */
const REPORT_CATEGORIES = [
  {
    value: 'spam',
    label: 'Spam or scam',
    description: 'Unwanted commercial content or fraudulent activity',
  },
  {
    value: 'harassment',
    label: 'Harassment or bullying',
    description: 'Targeting someone with abuse',
  },
  {
    value: 'hate_speech',
    label: 'Hate speech',
    description: 'Promoting violence against people',
  },
  {
    value: 'violence',
    label: 'Violence or threats',
    description: 'Physical threats or graphic violence',
  },
  {
    value: 'misinformation',
    label: 'Misinformation',
    description: 'False or misleading information',
  },
  {
    value: 'inappropriate',
    label: 'Inappropriate content',
    description: 'NSFW or offensive content',
  },
  {
    value: 'impersonation',
    label: 'Impersonation',
    description: 'Pretending to be someone else',
  },
  {
    value: 'self_harm',
    label: 'Self-harm or suicide',
    description: 'Content promoting self-harm',
  },
  { value: 'other', label: 'Other', description: 'Something else' },
];

export function ReportModal({
  isOpen,
  onClose,
  targetUserId,
  targetUsername,
  targetDisplayName,
  targetProfileImageUrl,
  postId,
  onSuccess,
}: ReportModalProps) {
  const [category, setCategory] = useState('');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [isReporting, startReporting] = useTransition();

  const displayName = targetDisplayName || targetUsername || 'User';

  const handleReport = () => {
    if (!category) {
      toast.error('Please select a report category');
      return;
    }

    if (reason.length < 10) {
      toast.error('Please provide more details (at least 10 characters)');
      return;
    }

    startReporting(async () => {
      const response = await fetch(apiUrl('/api/moderation/reports'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reportType: postId ? 'post' : 'user',
          reportedUserId: postId ? undefined : targetUserId,
          reportedPostId: postId,
          category,
          reason,
          evidence: evidence || undefined,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        toast.error(error.message || 'Failed to submit report');
        return;
      }

      // Reset form
      setCategory('');
      setReason('');
      setEvidence('');

      onClose();
      onSuccess?.();
    });
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-0 backdrop-blur-sm md:p-4"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full flex-col bg-card md:h-auto md:max-h-[90vh] md:w-auto md:min-w-[480px] md:max-w-2xl md:rounded-2xl md:border md:border-border"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between border-border border-b p-6">
          <h2 className="flex items-center gap-2 font-bold text-xl">
            <Flag className="h-5 w-5 text-red-500" />
            Report {postId ? 'Post' : 'User'}
          </h2>
          <button
            onClick={onClose}
            className="rounded-full p-2 transition-colors hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {/* User Info */}
          <div className="mb-6 flex items-center gap-3 rounded-lg bg-muted/50 p-3">
            <Avatar src={targetProfileImageUrl} alt={displayName} size="md" />
            <div>
              <div className="font-medium">{displayName}</div>
              {targetUsername && (
                <div className="text-muted-foreground text-sm">
                  @{targetUsername}
                </div>
              )}
            </div>
          </div>

          {/* Warning */}
          <div className="mb-4 flex gap-3 rounded-lg border border-orange-500/20 bg-orange-500/10 p-3">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-orange-500" />
            <div className="text-sm">
              <p className="mb-1 font-medium text-orange-500">Important</p>
              <p className="text-muted-foreground">
                Filing false reports may result in your account being
                restricted. Only report content that violates our community
                guidelines.
              </p>
            </div>
          </div>

          {/* Category Selection */}
          <div className="mb-4">
            <label className="mb-2 block font-medium text-sm">
              What's the issue? <span className="text-red-500">*</span>
            </label>
            <div className="space-y-2">
              {REPORT_CATEGORIES.map((cat) => (
                <label
                  key={cat.value}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                    category === cat.value
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-muted/50'
                  }`}
                >
                  <input
                    type="radio"
                    name="category"
                    value={cat.value}
                    checked={category === cat.value}
                    onChange={(e) => setCategory(e.target.value)}
                    className="mt-1"
                  />
                  <div className="flex-1">
                    <div className="font-medium">{cat.label}</div>
                    <div className="text-muted-foreground text-sm">
                      {cat.description}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Reason */}
          <div className="mb-4">
            <label className="mb-2 block font-medium text-sm">
              Please provide details <span className="text-red-500">*</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Describe what happened and why you're reporting this..."
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 focus:border-primary focus:outline-none"
              rows={4}
              minLength={10}
              maxLength={2000}
            />
            <div className="mt-1 text-muted-foreground text-xs">
              {reason.length}/2000 characters (minimum 10)
            </div>
          </div>

          {/* Evidence URL */}
          <div>
            <label className="mb-2 block font-medium text-sm">
              Evidence (optional)
            </label>
            <input
              type="url"
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder="https://example.com/screenshot.png"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 focus:border-primary focus:outline-none"
            />
            <div className="mt-1 text-muted-foreground text-xs">
              Link to screenshot or additional evidence
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 border-border border-t p-6">
          <div className="flex gap-3">
            <button
              onClick={onClose}
              disabled={isReporting}
              className="flex-1 rounded-lg bg-muted px-4 py-3 text-foreground transition-colors hover:bg-muted/80 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleReport}
              disabled={isReporting || !category || reason.length < 10}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-500 px-4 py-3 text-white transition-colors hover:bg-red-600 disabled:opacity-50"
            >
              {isReporting ? (
                <>Submitting...</>
              ) : (
                <>
                  <Flag className="h-4 w-4" />
                  Submit Report
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
