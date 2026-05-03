import { useSpend } from "../hooks/useSpend.js";
import { useStewardContext } from "../provider.js";
import type { SpendDashboardProps } from "../types.js";
import { truncateAddress } from "../utils/format.js";

/**
 * Spend tracking visualization with budget usage bars and breakdown.
 */
export function SpendDashboard({
  range = "7d",
  showBudgetUsage = true,
  showChart = true,
  showTopDestinations = true,
  className,
}: SpendDashboardProps) {
  const { features } = useStewardContext();
  const { stats, isLoading, error } = useSpend(range);

  if (!features.showSpendDashboard) return null;

  if (isLoading) {
    return (
      <div className={`stwd-card stwd-spend-dashboard ${className || ""}`}>
        <div className="stwd-loading">Loading spend data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`stwd-card stwd-spend-dashboard ${className || ""}`}>
        <div className="stwd-error-text">Failed to load spend data: {error.message}</div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className={`stwd-card stwd-spend-dashboard ${className || ""}`}>
        <div className="stwd-empty-state">
          <div className="stwd-empty-icon">📊</div>
          <div className="stwd-empty-text">No spend data available</div>
        </div>
      </div>
    );
  }

  const getRangeLabel = (r: string) => {
    switch (r) {
      case "24h":
        return "Last 24 Hours";
      case "7d":
        return "Last 7 Days";
      case "30d":
        return "Last 30 Days";
      case "all":
        return "All Time";
      default:
        return r;
    }
  };

  const getBarColor = (pct: number): string => {
    if (pct >= 90) return "var(--stwd-error)";
    if (pct >= 70) return "var(--stwd-warning)";
    return "var(--stwd-success)";
  };

  return (
    <div className={`stwd-card stwd-spend-dashboard ${className || ""}`}>
      <div className="stwd-spend-header">
        <h3 className="stwd-heading">Spend Dashboard</h3>
        <span className="stwd-badge stwd-badge-muted">{getRangeLabel(stats.range)}</span>
      </div>

      {/* Summary Stats */}
      <div className="stwd-spend-stats-grid">
        <div className="stwd-stat-card">
          <div className="stwd-stat-label">Total Spent</div>
          <div className="stwd-stat-value">{stats.totalSpentFormatted} ETH</div>
        </div>
        <div className="stwd-stat-card">
          <div className="stwd-stat-label">Transactions</div>
          <div className="stwd-stat-value">{stats.txCount}</div>
        </div>
        <div className="stwd-stat-card">
          <div className="stwd-stat-label">Avg Tx Value</div>
          <div className="stwd-stat-value">{stats.avgTxValueFormatted} ETH</div>
        </div>
        {stats.largestTx && (
          <div className="stwd-stat-card">
            <div className="stwd-stat-label">Largest Tx</div>
            <div className="stwd-stat-value">{stats.largestTx.value} ETH</div>
          </div>
        )}
      </div>

      {/* Budget Usage */}
      {showBudgetUsage && stats.budgetUsage && (
        <div className="stwd-budget-section">
          <h4 className="stwd-subheading">Budget Usage</h4>

          <div className="stwd-budget-bar-group">
            <div className="stwd-budget-bar-label">
              <span>Daily</span>
              <span>{stats.budgetUsage.dailyPercent}%</span>
            </div>
            <div className="stwd-budget-bar-track">
              <div
                className="stwd-budget-bar-fill"
                style={{
                  width: `${Math.min(100, stats.budgetUsage.dailyPercent)}%`,
                  backgroundColor: getBarColor(stats.budgetUsage.dailyPercent),
                }}
              />
            </div>
            <div className="stwd-budget-bar-detail">
              {stats.budgetUsage.dailyUsed} / {stats.budgetUsage.dailyLimit} wei
            </div>
          </div>

          <div className="stwd-budget-bar-group">
            <div className="stwd-budget-bar-label">
              <span>Weekly</span>
              <span>{stats.budgetUsage.weeklyPercent}%</span>
            </div>
            <div className="stwd-budget-bar-track">
              <div
                className="stwd-budget-bar-fill"
                style={{
                  width: `${Math.min(100, stats.budgetUsage.weeklyPercent)}%`,
                  backgroundColor: getBarColor(stats.budgetUsage.weeklyPercent),
                }}
              />
            </div>
            <div className="stwd-budget-bar-detail">
              {stats.budgetUsage.weeklyUsed} / {stats.budgetUsage.weeklyLimit} wei
            </div>
          </div>
        </div>
      )}

      {/* Daily Spend Chart (simple bar chart via CSS) */}
      {showChart && stats.daily.length > 0 && (
        <div className="stwd-chart-section">
          <h4 className="stwd-subheading">Daily Spend</h4>
          <div className="stwd-bar-chart">
            {stats.daily.map((day) => {
              const maxSpent = Math.max(
                ...stats.daily.map((d) => parseFloat(d.spentFormatted) || 0),
              );
              const height = maxSpent > 0 ? (parseFloat(day.spentFormatted) / maxSpent) * 100 : 0;
              return (
                <div
                  key={day.date}
                  className="stwd-bar-col"
                  title={`${day.date}: ${day.spentFormatted} ETH (${day.txCount} txs)`}
                >
                  <div className="stwd-bar" style={{ height: `${Math.max(2, height)}%` }} />
                  <div className="stwd-bar-label">{day.date.slice(-5)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Top Destinations */}
      {showTopDestinations && stats.topDestinations.length > 0 && (
        <div className="stwd-destinations-section">
          <h4 className="stwd-subheading">Top Destinations</h4>
          <div className="stwd-destination-list">
            {stats.topDestinations.map((dest, i) => (
              <div key={i} className="stwd-destination-row">
                <code className="stwd-address">{truncateAddress(dest.address)}</code>
                <span className="stwd-destination-amount">{dest.totalSent} wei</span>
                <span className="stwd-badge stwd-badge-muted">{dest.txCount} txs</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
