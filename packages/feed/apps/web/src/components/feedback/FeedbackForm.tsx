/**
 * Feedback form component for submitting user feedback and ratings.
 *
 * Provides a form interface for submitting feedback with star ratings,
 * score sliders, and optional text comments. Supports multiple feedback
 * categories and includes metadata for game/trade context.
 *
 * Features:
 * - Star rating input
 * - Score slider (0-100)
 * - Optional comment field
 * - Category selection
 * - Metadata support (gameId, tradeId)
 * - Form validation
 * - Loading states
 * - Error handling
 *
 * @param props - FeedbackForm component props
 * @returns Feedback form element
 *
 * @example
 * ```tsx
 * <FeedbackForm
 *   toUserId="user-123"
 *   category="game_performance"
 *   gameId="game-456"
 *   onSuccess={() => refreshFeedback()}
 * />
 * ```
 */
'use client';

import { cn } from '@babylon/shared';
import { Loader2, Send } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { getAuthToken } from '@/lib/auth';
import { apiUrl } from '@/utils/api-url';
import { ScoreSlider } from './ScoreSlider';
import { StarRatingInput } from './StarRating';

interface FeedbackFormProps {
  toUserId: string;
  toUserName?: string;
  category?:
    | 'game_performance'
    | 'trade_execution'
    | 'social_interaction'
    | 'general';
  interactionType?: string;
  gameId?: string;
  tradeId?: string;
  onSuccess?: () => void;
  onCancel?: () => void;
  className?: string;
}

export function FeedbackForm({
  toUserId,
  toUserName,
  category = 'general',
  interactionType = 'user_to_agent',
  gameId,
  tradeId,
  onSuccess,
  onCancel,
  className = '',
}: FeedbackFormProps) {
  const [score, setScore] = useState<number>(70); // 0-100, default 70 (3.5 stars)
  const [comment, setComment] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (score < 0 || score > 100) {
      toast.error('Please select a valid rating');
      return;
    }

    setSubmitting(true);

    const token = getAuthToken();
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(apiUrl('/api/feedback/submit'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        toUserId,
        score,
        comment: comment.trim() || null,
        category,
        interactionType,
        metadata: {
          gameId: gameId || undefined,
          tradeId: tradeId || undefined,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      setSubmitting(false);
      throw new Error(error.error || 'Failed to submit feedback');
    }

    await response.json();

    // Reset form
    setScore(70);
    setComment('');

    if (onSuccess) {
      onSuccess();
    }
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className={cn('space-y-6', className)}>
      {/* Rating Input */}
      <div className="space-y-3">
        <label className="font-medium text-foreground text-sm">
          Rate {toUserName || 'this user'}
        </label>
        <StarRatingInput
          value={score}
          onChange={setScore}
          showDescriptions={true}
        />
        <div className="text-muted-foreground text-xs">
          Or use the slider for more precise control:
        </div>
        <ScoreSlider
          value={score}
          onChange={setScore}
          showValue={true}
          showLabels={true}
        />
      </div>

      {/* Comment Input */}
      <div className="space-y-2">
        <label
          htmlFor="comment"
          className="font-medium text-foreground text-sm"
        >
          Comments (optional)
        </label>
        <textarea
          id="comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Share your thoughts..."
          maxLength={500}
          rows={4}
          className={cn(
            'w-full rounded-lg border border-border bg-muted px-3 py-2',
            'text-foreground placeholder-muted-foreground',
            'focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#1c9cf0]',
            'resize-none transition-colors'
          )}
        />
        <div className="flex justify-between text-muted-foreground text-xs">
          <span>Maximum 500 characters</span>
          <span>{comment.length}/500</span>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className={cn(
            'flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-3 font-semibold transition-colors',
            'bg-[#1c9cf0] text-primary-foreground hover:bg-[#1c9cf0]/90',
            'disabled:cursor-not-allowed disabled:opacity-50'
          )}
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Submitting...</span>
            </>
          ) : (
            <>
              <Send className="h-4 w-4" />
              <span>Submit Feedback</span>
            </>
          )}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className={cn(
              'rounded-lg px-4 py-3 font-semibold transition-colors',
              'bg-muted text-foreground hover:bg-muted/70',
              'disabled:cursor-not-allowed disabled:opacity-50'
            )}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
