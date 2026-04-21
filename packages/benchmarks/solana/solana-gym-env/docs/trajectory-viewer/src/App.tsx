import React, { useEffect, useState } from "react";
import { BrowserRouter as Router, Routes, Route, Link } from "react-router-dom";
import LandingPage from "./components/LandingPage";
import TrajectoryList from "./components/TrajectoryList";
import TrajectoryDetail from "./components/TrajectoryDetail";
import "./App.css";

// Type definitions
export interface RunMetrics {
  run_id: string;
  model: string;
  cumulative_rewards: number[];
  messages: MessageData[];
  programs_discovered: Record<string, number>;
  instructions_by_program?: Record<string, number[]>;
  start_time?: string;
  benchmark?: string; // Added benchmark field
}

export interface MessageData {
  index: number;
  timestamp: string;
  duration: number;
  reward: number;
  total_reward: number;
  instructions_discovered?: Record<string, number[]>;
}

export interface ConversationMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const App: React.FC = () => {
  const [allRuns, setAllRuns] = useState<RunMetrics[]>([]);
  const [currentBenchmark, setCurrentBenchmark] = useState<string>("all");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Load runs from both benchmarks
    loadAllBenchmarks();
  }, []);

  const loadAllBenchmarks = async () => {
    try {
      const benchmarks = ["basic", "swap"];
      const allRunsData: RunMetrics[] = [];

      for (const benchmark of benchmarks) {
        try {
          const response = await fetch(
            `/solana-gym-env/data/${benchmark}/manifest.json`
          );
          const manifest = await response.json();
          // Add benchmark field to each run
          const runsWithBenchmark = manifest.runs.map((run: RunMetrics) => ({
            ...run,
            benchmark,
          }));
          allRunsData.push(...runsWithBenchmark);
        } catch (error) {
          console.error(`Failed to load ${benchmark} benchmark:`, error);
        }
      }

      setAllRuns(allRunsData);
    } catch (error) {
      console.error("Failed to load benchmarks:", error);
      setAllRuns([]);
    } finally {
      setLoading(false);
    }
  };

  // Filter runs based on selected benchmark
  const filteredRuns =
    currentBenchmark === "all"
      ? allRuns
      : allRuns.filter((run) => run.benchmark === currentBenchmark);

  return (
    <Router basename="/solana-gym-env">
      <div className="app">
        <header className="app-header">
          <Link to="/" className="logo">
            <h1>Solana Bench</h1>
          </Link>
          <nav>
            <div className="benchmark-selector">
              <select
                value={currentBenchmark}
                onChange={(e) => setCurrentBenchmark(e.target.value)}
                className="benchmark-select"
              >
                <option value="all">All Benchmarks</option>
                <option value="basic">Basic Benchmark</option>
                <option value="swap">Swap Benchmark</option>
              </select>
            </div>
            <Link to="/">Home</Link>
            <Link to="/trajectories">Trajectories</Link>
            <a
              href="https://github.com/solana-foundation/solana-gym-env"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
          </nav>
        </header>

        <main className="app-main">
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route
              path="/trajectories"
              element={
                <TrajectoryList
                  runs={filteredRuns}
                  loading={loading}
                  benchmark={currentBenchmark}
                />
              }
            />
            <Route path="/run/:runId" element={<TrajectoryDetail />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
};

export default App;
