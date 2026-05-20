'use client';

import { Calendar, Clock, X } from 'lucide-react';
import Image from 'next/image';
import { useEffect } from 'react';

/**
 * Upcoming event detail modal component for displaying full event information.
 *
 * Displays a modal with full details of an upcoming event including title,
 * date, time, description, image, and related entities. Handles body scroll
 * lock and escape key to close. Shows live indicator if event is currently live.
 *
 * Features:
 * - Full event display
 * - Date and time formatting
 * - Live event indicator
 * - Image support
 * - Related entities links
 * - Escape key to close
 * - Body scroll lock
 *
 * @param props - UpcomingEventDetailModal component props
 * @returns Upcoming event detail modal element or null if not open
 *
 * @example
 * ```tsx
 * <UpcomingEventsDetailModal
 *   isOpen={isOpen}
 *   onClose={() => setIsOpen(false)}
 *   event={eventData}
 * />
 * ```
 */
interface UpcomingEventDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  event: {
    id: string;
    title: string;
    date: string;
    time?: string;
    isLive?: boolean;
    hint?: string;
    fullDescription?: string;
    source?: string;
    relatedQuestion?: number;
    imageUrl?: string;
    relatedActorId?: string;
    relatedOrganizationId?: string;
  } | null;
}

export function UpcomingEventsDetailModal({
  isOpen,
  onClose,
  event,
}: UpcomingEventDetailModalProps) {
  // Handle escape key and body scroll lock
  useEffect(() => {
    if (!isOpen) {
      // Ensure body overflow is reset when modal is closed
      document.body.style.overflow = '';
      return;
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    // Prevent body scroll when modal is open
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  // Cleanup on unmount (for HMR)
  useEffect(() => {
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  if (!isOpen || !event) return null;

  const formatFullDate = (date: string, time?: string) => {
    // Try to parse if it's a full date string
    const dateObj = new Date(date);
    if (!isNaN(dateObj.getTime())) {
      return dateObj.toLocaleString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    }

    return time ? `${date}, ${time}` : date;
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[110] bg-black/80 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-[110] flex items-center justify-center p-0 md:p-4">
        <div
          className="fade-in zoom-in-95 flex h-full w-full animate-in flex-col bg-[#1e1e1e] shadow-2xl duration-200 md:h-auto md:max-h-[90vh] md:w-auto md:min-w-[480px] md:max-w-2xl md:rounded-lg md:border md:border-white/10"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex shrink-0 items-start justify-between border-white/10 border-b p-6">
            <div className="flex flex-1 items-start gap-4">
              <div className="mt-1 shrink-0 text-[#0066FF]">
                <Calendar className="h-8 w-8" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="mb-3 font-bold text-2xl text-foreground leading-tight sm:text-3xl">
                  {event.title}
                </h2>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 text-gray-400 text-sm">
                    <Clock className="h-4 w-4" />
                    <span>{formatFullDate(event.date, event.time)}</span>
                  </div>
                  {event.isLive && (
                    <span className="shrink-0 rounded bg-[#0066FF]/10 px-3 py-1 font-semibold text-[#0066FF] text-sm">
                      LIVE
                    </span>
                  )}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-gray-400 transition-colors hover:bg-white/10 hover:text-foreground"
            >
              <X size={24} />
            </button>
          </div>

          {/* Content */}
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            {/* Image */}
            {event.imageUrl && (
              <div className="mb-6 overflow-hidden rounded-lg">
                <Image
                  src={event.imageUrl}
                  alt={event.title}
                  width={800}
                  height={400}
                  className="h-auto w-full object-cover"
                  unoptimized
                />
              </div>
            )}

            {/* Description and hints */}
            <div className="space-y-4">
              {event.fullDescription && (
                <div className="rounded-lg border border-white/5 bg-[#2d2d2d] p-4">
                  <p className="whitespace-pre-wrap text-base text-foreground leading-relaxed sm:text-lg">
                    {event.fullDescription}
                  </p>
                </div>
              )}

              {event.hint && (
                <div className="rounded-lg border border-white/5 bg-[#2d2d2d] p-4">
                  <p className="mb-2 font-semibold text-gray-400 text-sm">
                    Hint
                  </p>
                  <p className="text-base text-gray-300 italic leading-relaxed">
                    {event.hint}
                  </p>
                </div>
              )}

              {/* Metadata */}
              <div className="space-y-3 border-white/10 border-t pt-4">
                {event.relatedQuestion && (
                  <div>
                    <p className="text-foreground text-sm">
                      <span className="font-semibold text-gray-400">
                        Related Question:
                      </span>{' '}
                      #{event.relatedQuestion}
                    </p>
                  </div>
                )}

                {event.source && (
                  <div>
                    <p className="text-foreground text-sm">
                      <span className="font-semibold text-gray-400">
                        Source:
                      </span>{' '}
                      {event.source}
                    </p>
                  </div>
                )}

                <div>
                  <p className="text-gray-500 text-xs">Event ID: {event.id}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
