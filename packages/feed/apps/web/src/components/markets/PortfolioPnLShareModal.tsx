"use client";

import type { PortfolioBreakdownSnapshot } from "@/hooks/usePortfolioPnL";
import type { User } from "@/stores/authStore";
import { PnLShareModal } from "./PnLShareModal";

/**
 * Portfolio PnL share modal component for sharing portfolio PnL.
 *
 * Wrapper component that delegates to PnLShareModal with portfolio-specific
 * configuration. Provides modal interface for sharing portfolio PnL on
 * social media.
 *
 * Features:
 * - Modal wrapper
 * - Portfolio-specific sharing
 * - Delegates to PnLShareModal
 *
 * @param props - PortfolioPnLShareModal component props
 * @returns Portfolio PnL share modal element
 *
 * @example
 * ```tsx
 * <PortfolioPnLShareModal
 *   isOpen={showModal}
 *   onClose={() => setShowModal(false)}
 *   data={portfolioData}
 *   user={userData}
 * />
 * ```
 */
interface PortfolioPnLShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  data: PortfolioBreakdownSnapshot | null | undefined;
  user: User | null;
  lastUpdated?: Date | null | number;
}

export function PortfolioPnLShareModal({
  isOpen,
  onClose,
  data,
  user,
}: PortfolioPnLShareModalProps) {
  return (
    <PnLShareModal
      isOpen={isOpen}
      onClose={onClose}
      type="portfolio"
      portfolioData={data ?? null}
      user={user}
    />
  );
}
