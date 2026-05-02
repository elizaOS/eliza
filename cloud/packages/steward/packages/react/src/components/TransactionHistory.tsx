import { useTransactions } from "../hooks/useTransactions.js";
import { useStewardContext } from "../provider.js";
import type { TransactionHistoryProps } from "../types.js";
import {
  copyToClipboard,
  formatRelativeTime,
  formatWei,
  getExplorerTxUrl,
  getStatusColor,
  truncateAddress,
} from "../utils/format.js";

/**
 * Paginated transaction list with status badges and explorer links.
 */
export function TransactionHistory({
  pageSize = 20,
  statusFilter,
  chainFilter,
  showPolicyDetails = false,
  renderTransaction,
  onTransactionClick,
  className,
}: TransactionHistoryProps) {
  const { features } = useStewardContext();

  if (!features.showTransactionHistory) return null;

  const { transactions, isLoading, error, page, totalPages, nextPage, prevPage } = useTransactions({
    pageSize,
    status: statusFilter,
    chainId: chainFilter?.[0],
  });

  if (isLoading) {
    return (
      <div className={`stwd-card stwd-tx-history ${className || ""}`}>
        <div className="stwd-loading">Loading transactions...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`stwd-card stwd-tx-history ${className || ""}`}>
        <div className="stwd-error-text">Failed to load transactions: {error.message}</div>
      </div>
    );
  }

  return (
    <div className={`stwd-card stwd-tx-history ${className || ""}`}>
      <h3 className="stwd-heading">Transaction History</h3>

      {transactions.length === 0 ? (
        <div className="stwd-empty-state">
          <div className="stwd-empty-icon">📭</div>
          <div className="stwd-empty-text">No transactions yet</div>
        </div>
      ) : (
        <>
          <div className="stwd-tx-list">
            {transactions.map((tx) => {
              if (renderTransaction) {
                return <div key={tx.id}>{renderTransaction(tx)}</div>;
              }

              const chainId = tx.request?.chainId || 8453;
              return (
                <div
                  key={tx.id}
                  className={`stwd-tx-row ${onTransactionClick ? "stwd-tx-clickable" : ""}`}
                  onClick={() => onTransactionClick?.(tx)}
                >
                  <div className="stwd-tx-main">
                    <div className="stwd-tx-to">
                      {tx.request?.to ? (
                        <code>{truncateAddress(tx.request.to)}</code>
                      ) : (
                        <span className="stwd-muted-text">—</span>
                      )}
                    </div>
                    <div className="stwd-tx-value">
                      {tx.request?.value ? formatWei(tx.request.value) : "0"} ETH
                    </div>
                  </div>

                  <div className="stwd-tx-meta">
                    <span className={`stwd-badge ${getStatusColor(tx.status)}`}>{tx.status}</span>
                    <span className="stwd-tx-time">{formatRelativeTime(tx.createdAt)}</span>
                    {tx.txHash && (
                      <a
                        className="stwd-link"
                        href={getExplorerTxUrl(tx.txHash, chainId)}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        title="View on explorer"
                      >
                        ↗
                      </a>
                    )}
                    {tx.txHash && (
                      <button
                        className="stwd-btn stwd-btn-ghost stwd-btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          copyToClipboard(tx.txHash!);
                        }}
                        title="Copy tx hash"
                      >
                        📋
                      </button>
                    )}
                  </div>

                  {showPolicyDetails && tx.policyResults.length > 0 && (
                    <div className="stwd-tx-policies">
                      {tx.policyResults.map((pr, i) => (
                        <span
                          key={i}
                          className={`stwd-badge ${pr.passed ? "stwd-badge-success" : "stwd-badge-error"}`}
                        >
                          {pr.type}: {pr.passed ? "✓" : "✗"}
                          {pr.reason && ` (${pr.reason})`}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {totalPages > 1 && (
            <div className="stwd-pagination">
              <button
                className="stwd-btn stwd-btn-secondary"
                onClick={prevPage}
                disabled={page <= 1}
              >
                ← Prev
              </button>
              <span className="stwd-page-info">
                Page {page} of {totalPages}
              </span>
              <button
                className="stwd-btn stwd-btn-secondary"
                onClick={nextPage}
                disabled={page >= totalPages}
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
