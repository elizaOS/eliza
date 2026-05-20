'use client';

import { Activity, Calendar, DollarSign, TrendingUp, X } from 'lucide-react';
import Image from 'next/image';
import { useEffect } from 'react';

/**
 * Breaking news item structure for detail modal.
 */
type BreakingNewsItem = {
  id: string;
  title: string;
  description: string;
  icon: 'chart' | 'calendar' | 'dollar' | 'trending';
  timestamp: string;
  trending?: boolean;
  source?: string;
  fullDescription?: string;
  imageUrl?: string;
  relatedQuestion?: number;
  relatedActorId?: string;
  relatedOrganizationId?: string;
};

/**
 * Breaking news detail modal component for displaying full news article.
 *
 * Displays a modal with full details of a breaking news item including
 * title, description, image, timestamp, and related entities. Handles
 * body scroll lock and escape key to close.
 *
 * Features:
 * - Full article display
 * - Image support
 * - Icon display based on type
 * - Related entities links
 * - Escape key to close
 * - Body scroll lock
 *
 * @param props - BreakingNewsDetailModal component props
 * @returns Breaking news detail modal element or null if not open
 *
 * @example
 * ```tsx
 * <BreakingNewsDetailModal
 *   isOpen={isOpen}
 *   onClose={() => setIsOpen(false)}
 *   item={newsItem}
 * />
 * ```
 */
interface BreakingNewsDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  item: BreakingNewsItem | null;
}

export function BreakingNewsDetailModal({
  isOpen,
  onClose,
  item,
}: BreakingNewsDetailModalProps) {
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

  if (!isOpen || !item) return null;

  const getIcon = (icon: BreakingNewsItem['icon']) => {
    switch (icon) {
      case 'chart':
        return <TrendingUp className="h-8 w-8" />;
      case 'calendar':
        return <Calendar className="h-8 w-8" />;
      case 'dollar':
        return <DollarSign className="h-8 w-8" />;
      default:
        return <Activity className="h-8 w-8" />;
    }
  };

  const formatDate = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
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
                {getIcon(item.icon)}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="mb-3 font-bold text-2xl text-foreground leading-tight sm:text-3xl">
                  {item.title}
                </h2>
                <div className="flex items-center gap-3 text-gray-400 text-sm">
                  <span>{formatDate(item.timestamp)}</span>
                  {item.trending && (
                    <span className="font-semibold text-[#0066FF]">
                      • Trending
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
            {item.imageUrl && (
              <div className="mb-6 overflow-hidden rounded-lg">
                <Image
                  src={item.imageUrl}
                  alt={item.title}
                  width={800}
                  height={400}
                  className="h-auto w-full object-cover"
                  unoptimized
                />
              </div>
            )}

            {/* Description */}
            <div className="space-y-4">
              <div className="rounded-lg border border-white/5 bg-[#2d2d2d] p-4">
                <p className="whitespace-pre-wrap text-base text-foreground leading-relaxed sm:text-lg">
                  {item.fullDescription || item.description}
                </p>
              </div>

              {/* Metadata */}
              <div className="space-y-3 border-white/10 border-t pt-4">
                {item.relatedQuestion && (
                  <div>
                    <p className="text-foreground text-sm">
                      <span className="font-semibold text-gray-400">
                        Related Question:
                      </span>{' '}
                      #{item.relatedQuestion}
                    </p>
                  </div>
                )}

                {item.source && (
                  <div>
                    <p className="text-foreground text-sm">
                      <span className="font-semibold text-gray-400">
                        Source:
                      </span>{' '}
                      {item.source}
                    </p>
                  </div>
                )}

                <div>
                  <p className="text-gray-500 text-xs">News ID: {item.id}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
