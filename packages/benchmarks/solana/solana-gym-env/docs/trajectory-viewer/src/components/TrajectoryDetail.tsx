import React, { useEffect, useState } from "react";
import { useParams, Link, useSearchParams } from "react-router-dom";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/themes/prism-tomorrow.css";
import { RunMetrics, ConversationMessage } from "../App";
import "./TrajectoryDetail.css";

const TrajectoryDetail: React.FC = () => {
  const { runId } = useParams<{ runId: string }>();
  const [searchParams] = useSearchParams();
  const benchmark = searchParams.get('benchmark') || 'basic';
  const [metrics, setMetrics] = useState<RunMetrics | null>(null);
  const [conversation, setConversation] = useState<ConversationMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMessage, setSelectedMessage] = useState<number | null>(null);

  useEffect(() => {
    if (runId) {
      loadRunData(runId, benchmark);
    }
  }, [runId, benchmark]);

  useEffect(() => {
    // Highlight code blocks when conversation updates
    Prism.highlightAll();
  }, [conversation, selectedMessage]);

  const loadRunData = async (id: string, benchmarkName: string) => {
    try {
      // Load metrics
      const metricsResponse = await fetch(`/solana-gym-env/data/${benchmarkName}/runs/${id}_metrics.json`);
      const metricsData = await metricsResponse.json();
      setMetrics(metricsData);

      // Load conversation
      const convResponse = await fetch(`/solana-gym-env/data/${benchmarkName}/runs/${id}_conversation.json`);
      const convData = await convResponse.json();
      setConversation(convData);
    } catch (error) {
      console.error("Failed to load run data:", error);
      // Use mock data for development
      setMetrics(null);
      setConversation([]);
    } finally {
      setLoading(false);
    }
  };

  const extractCodeBlocks = (content: string): string[] => {
    const codePattern = /```(?:typescript|ts|javascript|js)(.*?)```/gs;
    const matches = [];
    let match;
    while ((match = codePattern.exec(content)) !== null) {
      matches.push(match[1].trim());
    }
    return matches;
  };

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner"></div>
        <p>Loading trajectory data...</p>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="error">
        <p>Run not found</p>
        <Link to="/">Back to list</Link>
      </div>
    );
  }

  const chartData = metrics.cumulative_rewards.map((reward, i) => ({
    message: i,
    reward: reward,
    stepReward: i > 0 ? reward - metrics.cumulative_rewards[i - 1] : reward,
  }));

  const totalReward =
    metrics.cumulative_rewards[metrics.cumulative_rewards.length - 1] || 0;
  const programCount = Object.keys(metrics.programs_discovered).length;
  const modelShort = metrics.model
    .replace("anthropic/", "")
    .replace("openai/", "")
    .replace("google/", "");

  // Get assistant messages with their code
  const assistantMessages = conversation
    .map((msg, idx) => ({ ...msg, originalIndex: idx }))
    .filter((msg) => msg.role === "assistant");

  return (
    <div className="trajectory-detail">
      <div className="detail-header">
        <Link to="/trajectories" className="back-link">
          ← Back to trajectories
        </Link>
        <h1>Run {runId}</h1>
        <div className="header-stats">
          <span className={`model-badge model-${modelShort.split("/")[0]}`}>
            {modelShort}
          </span>
          <span className="stat">
            <strong>{totalReward}</strong> total reward
          </span>
          <span className="stat">
            <strong>{programCount}</strong> programs
          </span>
          <span className="stat">
            <strong>{metrics.messages.length}/50</strong> messages
          </span>
        </div>
      </div>

      <div className="chart-section">
        <h2>Reward Progression</h2>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="message"
              label={{
                value: "Message Number",
                position: "insideBottom",
                offset: -5,
              }}
            />
            <YAxis
              label={{ value: "Reward", angle: -90, position: "insideLeft" }}
            />
            <Tooltip />
            <Legend />
            <Line
              type="monotone"
              dataKey="reward"
              stroke="#667eea"
              name="Cumulative Reward"
              strokeWidth={2}
            />
            <Line
              type="monotone"
              dataKey="stepReward"
              stroke="#48bb78"
              name="Step Reward"
              strokeWidth={1}
              dot={{ r: 3 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="programs-section">
        <h2>Programs Discovered</h2>
        <div className="programs-grid">
          {Object.entries(metrics.programs_discovered).map(
            ([program, messageIdx]) => (
              <div key={program} className="program-item">
                <code className="program-id">{program}</code>
                <span className="discovered-at">Message {messageIdx}</span>
              </div>
            )
          )}
        </div>
      </div>

      <div className="messages-section">
        <h2>Code Evolution</h2>
        <div className="message-timeline">
          {assistantMessages.map((msg, idx) => {
            const messageNum = idx + 1;
            const codeBlocks = extractCodeBlocks(msg.content);
            const messageData = metrics.messages[idx];
            const reward = messageData?.reward || 0;
            const isExpanded = selectedMessage === messageNum;

            return (
              <div
                key={idx}
                className={`message-item ${isExpanded ? "expanded" : ""}`}
              >
                <div
                  className="message-header"
                  onClick={() =>
                    setSelectedMessage(isExpanded ? null : messageNum)
                  }
                >
                  <span className="message-number">Message {messageNum}</span>
                  <span
                    className={`reward-badge ${
                      reward > 0 ? "positive" : "zero"
                    }`}
                  >
                    +{reward} reward
                  </span>
                  <span className="code-count">
                    {codeBlocks.length} code block
                    {codeBlocks.length !== 1 ? "s" : ""}
                  </span>
                  <span className="expand-icon">{isExpanded ? "▼" : "▶"}</span>
                </div>

                {isExpanded && (
                  <div className="message-content">
                    {codeBlocks.map((code, codeIdx) => (
                      <div key={codeIdx} className="code-block">
                        <div className="code-header">
                          TypeScript Code {codeIdx + 1}/{codeBlocks.length}
                        </div>
                        <pre>
                          <code className="language-typescript">{code}</code>
                        </pre>
                      </div>
                    ))}

                    {/* Show feedback if available */}
                    {conversation[msg.originalIndex + 1]?.role === "user" && (
                      <div
                        className={`feedback ${
                          conversation[msg.originalIndex + 1].content.includes(
                            "✅"
                          )
                            ? "success"
                            : conversation[
                                msg.originalIndex + 1
                              ].content.includes("❌")
                            ? "error"
                            : ""
                        }`}
                      >
                        <strong>Execution Result:</strong>
                        <pre>{conversation[msg.originalIndex + 1].content}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// Mock data for development
export default TrajectoryDetail;
