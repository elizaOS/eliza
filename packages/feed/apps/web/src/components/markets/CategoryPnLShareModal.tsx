'use client';

import type { User } from '@/stores/authStore';
import type { MarketCategory } from '@/types/markets';
import { PnLShareModal } from './PnLShareModal';

/**
 * Category PnL data structure for category PnL share modal.
 */
interface CategoryPnLData {
  unrealizedPnL: number;
  positionCount: number;
  totalValue?: number;
  categorySpecific?: {
    openInterest?: number;
    totalShares?: number;
    totalInvested?: number;
  };
}

/**
 * Category PnL share modal component for sharing category PnL.
 *
 * Wrapper component that delegates to PnLShareModal with category-specific
 * configuration. Provides modal interface for sharing category PnL on
 * social media.
 *
 * Features:
 * - Modal wrapper
 * - Category-specific sharing
 * - Delegates to PnLShareModal
 *
 * @param props - CategoryPnLShareModal component props
 * @returns Category PnL share modal element
 *
 * @example
 * ```tsx
 * <CategoryPnLShareModal
 *   isOpen={showModal}
 *   onClose={() => setShowModal(false)}
 *   category="perps"
 *   data={pnlData}
 *   user={userData}
 * />
 * ```
 */
interface CategoryPnLShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  category: MarketCategory;
  data: CategoryPnLData | null | undefined;
  user: User | null;
  lastUpdated?: Date | null | number;
}

export function CategoryPnLShareModal({
  isOpen,
  onClose,
  category,
  data,
  user,
}: CategoryPnLShareModalProps) {
  return (
    <PnLShareModal
      isOpen={isOpen}
      onClose={onClose}
      type="category"
      category={category}
      categoryData={data ?? null}
      user={user}
    />
  );
}
