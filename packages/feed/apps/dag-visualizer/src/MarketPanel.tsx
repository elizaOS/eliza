import { useMemo } from "react";
import type { NPCTrajectory, TraceData } from "./types";

interface Props {
  trace: TraceData | null;
  selectedNPC: NPCTrajectory | null;
}

interface MarketPosition {
  ticker: string;
  longs: number;
  shorts: number;
  yesCount: number;
  noCount: number;
  totalVolume: number;
  agents: Array<{
    name: string;
    action: string;
    amount: number;
    confidence: number;
    success: boolean;
  }>;
}

export function MarketPanel({ trace, selectedNPC }: Props) {
  const markets = useMemo(() => {
    if (!trace?.npcTrajectories) return [];

    const byTicker = new Map<string, MarketPosition>();

    for (const npc of trace.npcTrajectories) {
      for (const d of npc.decisions ?? []) {
        if (d.action === "hold" || d.action === "wait" || !d.ticker) continue;
        const ticker = d.ticker;
        const pos = byTicker.get(ticker) ?? {
          ticker,
          longs: 0,
          shorts: 0,
          yesCount: 0,
          noCount: 0,
          totalVolume: 0,
          agents: [],
        };

        if (d.action === "open_long") pos.longs++;
        if (d.action === "open_short") pos.shorts++;
        if (d.action === "buy_yes") pos.yesCount++;
        if (d.action === "buy_no") pos.noCount++;
        pos.totalVolume += d.amount ?? 0;

        const trade = npc.trades?.find((t) => t.ticker === ticker);
        pos.agents.push({
          name: npc.npcName,
          action: d.action,
          amount: d.amount ?? 0,
          confidence: d.confidence ?? 0,
          success: trade?.success ?? true,
        });

        byTicker.set(ticker, pos);
      }
    }

    return [...byTicker.values()].sort((a, b) => b.totalVolume - a.totalVolume);
  }, [trace]);

  // Questions from game tick result
  const questions = useMemo(() => {
    const result = trace?.gameTickResult;
    if (!result) return [];
    // Extract from LLM call parsed responses
    const qCall = trace?.llmCallsFull?.find(
      (c) => c.promptType === "question_generation",
    );
    if (qCall?.parsedResponse && Array.isArray(qCall.parsedResponse)) {
      return qCall.parsedResponse as Array<{
        text: string;
        outcome: string;
        daysUntilResolution: number;
      }>;
    }
    return [];
  }, [trace]);

  if (!trace) {
    return (
      <div style={panelStyle}>
        <div style={headerStyle}>Markets</div>
        <div style={{ padding: 12, color: "#64748b", fontSize: 12 }}>
          No data
        </div>
      </div>
    );
  }

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        Markets & Predictions
        <span style={{ fontSize: 10, color: "#64748b", fontWeight: 400 }}>
          {markets.length} active
        </span>
      </div>

      {/* Prediction Questions */}
      {questions.length > 0 && (
        <div style={{ padding: "8px 12px", borderBottom: "1px solid #1e293b" }}>
          <div
            style={{
              fontSize: 10,
              color: "#94a3b8",
              fontWeight: 600,
              marginBottom: 6,
            }}
          >
            PREDICTION MARKETS
          </div>
          {questions.map((q, i) => (
            <div
              key={i}
              style={{
                padding: "5px 0",
                borderBottom: "1px solid #1e293b22",
                fontSize: 11,
              }}
            >
              <div style={{ color: "#e2e8f0" }}>{q.text}</div>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  marginTop: 2,
                  fontSize: 10,
                }}
              >
                <span
                  style={{
                    color: q.outcome === "yes" ? "#4ade80" : "#f87171",
                    fontWeight: 600,
                  }}
                >
                  Outcome: {q.outcome.toUpperCase()}
                </span>
                <span style={{ color: "#64748b" }}>
                  {q.daysUntilResolution}d
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Market Positions by Ticker */}
      <div style={{ padding: "8px 12px" }}>
        <div
          style={{
            fontSize: 10,
            color: "#94a3b8",
            fontWeight: 600,
            marginBottom: 6,
          }}
        >
          SPOT MARKETS & VOLUME
        </div>
        {markets.map((m) => {
          const sentiment = m.longs + m.yesCount - (m.shorts + m.noCount);
          const sentimentColor =
            sentiment > 0 ? "#4ade80" : sentiment < 0 ? "#f87171" : "#94a3b8";
          const sentimentLabel =
            sentiment > 0 ? "BULLISH" : sentiment < 0 ? "BEARISH" : "NEUTRAL";
          const isSelectedNPCTicker = selectedNPC?.decisions?.some(
            (d) => d.ticker === m.ticker,
          );

          return (
            <div
              key={m.ticker}
              style={{
                padding: "6px 8px",
                marginBottom: 4,
                borderRadius: 5,
                background: isSelectedNPCTicker ? "#1e1030" : "#1e293b",
                border: isSelectedNPCTicker
                  ? "1px solid #ec4899"
                  : "1px solid transparent",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span
                  style={{
                    color: "#f1f5f9",
                    fontWeight: 700,
                    fontSize: 13,
                  }}
                >
                  {m.ticker}
                </span>
                <span
                  style={{
                    color: sentimentColor,
                    fontSize: 9,
                    fontWeight: 700,
                    background: `${sentimentColor}15`,
                    padding: "1px 5px",
                    borderRadius: 3,
                  }}
                >
                  {sentimentLabel}
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  fontSize: 10,
                  color: "#94a3b8",
                  marginTop: 3,
                }}
              >
                <span>Vol: ${m.totalVolume.toLocaleString()}</span>
                {m.longs > 0 && (
                  <span style={{ color: "#4ade80" }}>{m.longs} long</span>
                )}
                {m.shorts > 0 && (
                  <span style={{ color: "#f87171" }}>{m.shorts} short</span>
                )}
                {m.yesCount > 0 && (
                  <span style={{ color: "#4ade80" }}>{m.yesCount} YES</span>
                )}
                {m.noCount > 0 && (
                  <span style={{ color: "#f87171" }}>{m.noCount} NO</span>
                )}
              </div>
              {/* Agent list */}
              <div style={{ marginTop: 4 }}>
                {m.agents
                  .sort((a, b) => b.amount - a.amount)
                  .slice(0, 5)
                  .map((a, i) => (
                    <div
                      key={i}
                      style={{
                        fontSize: 9,
                        color:
                          selectedNPC?.npcName === a.name
                            ? "#f9a8d4"
                            : "#64748b",
                        fontWeight: selectedNPC?.npcName === a.name ? 600 : 400,
                        display: "flex",
                        justifyContent: "space-between",
                        padding: "1px 0",
                      }}
                    >
                      <span>
                        {a.name} - {a.action}
                      </span>
                      <span>
                        ${a.amount.toLocaleString()}
                        {!a.success && (
                          <span style={{ color: "#ef4444" }}> FAIL</span>
                        )}
                      </span>
                    </div>
                  ))}
                {m.agents.length > 5 && (
                  <div style={{ fontSize: 9, color: "#475569" }}>
                    +{m.agents.length - 5} more
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Tick summary stats */}
      <div
        style={{
          padding: "8px 12px",
          borderTop: "1px solid #1e293b",
          marginTop: "auto",
        }}
      >
        <div
          style={{
            fontSize: 10,
            color: "#94a3b8",
            fontWeight: 600,
            marginBottom: 4,
          }}
        >
          TICK SUMMARY
        </div>
        <StatRow
          label="Events Created"
          value={String(trace.gameTickResult?.eventsCreated ?? 0)}
        />
        <StatRow
          label="Questions Created"
          value={String(trace.gameTickResult?.questionsCreated ?? 0)}
        />
        <StatRow
          label="Markets Updated"
          value={String(trace.gameTickResult?.marketsUpdated ?? 0)}
        />
        <StatRow label="Total Duration" value={`${trace.durationMs}ms`} />
        <StatRow
          label="LLM Calls"
          value={String(trace.llmCallSummaries?.length ?? 0)}
        />
        <StatRow
          label="Total Tokens"
          value={(trace.tokenStats?.totalTokens ?? 0).toLocaleString()}
        />
        <StatRow
          label="Est. Cost"
          value={`$${(trace.tokenStats?.estimatedCostUSD ?? 0).toFixed(4)}`}
        />
      </div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        fontSize: 10,
        padding: "2px 0",
        color: "#94a3b8",
      }}
    >
      <span>{label}</span>
      <span style={{ color: "#e2e8f0" }}>{value}</span>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  width: 260,
  background: "#0f172a",
  borderRight: "1px solid #1e293b",
  display: "flex",
  flexDirection: "column",
  height: "100%",
  overflow: "auto",
};

const headerStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid #1e293b",
  color: "#f1f5f9",
  fontSize: 13,
  fontWeight: 700,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};
