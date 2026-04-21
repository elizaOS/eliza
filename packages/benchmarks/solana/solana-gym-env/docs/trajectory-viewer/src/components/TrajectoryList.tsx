import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { RunMetrics } from '../App';
import './TrajectoryList.css';

interface Props {
  runs: RunMetrics[];
  loading: boolean;
  benchmark?: string;
}

const TrajectoryList: React.FC<Props> = ({ runs, loading, benchmark }) => {
  const [sortBy, setSortBy] = useState<'reward' | 'model' | 'programs'>('reward');
  const [filterModel, setFilterModel] = useState<string>('all');

  // Get unique models for filter
  const models = Array.from(new Set(runs.map(r => r.model)));

  // Sort and filter runs
  const processedRuns = runs
    .filter(run => filterModel === 'all' || run.model === filterModel)
    .sort((a, b) => {
      switch (sortBy) {
        case 'reward':
          return (b.cumulative_rewards[b.cumulative_rewards.length - 1] || 0) -
                 (a.cumulative_rewards[a.cumulative_rewards.length - 1] || 0);
        case 'programs':
          return Object.keys(b.programs_discovered).length - 
                 Object.keys(a.programs_discovered).length;
        case 'model':
          return a.model.localeCompare(b.model);
        default:
          return 0;
      }
    });

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner"></div>
        <p>Loading trajectories...</p>
      </div>
    );
  }

  return (
    <div className="trajectory-list">
      <div className="list-header">
        <h2>Benchmark Trajectories</h2>
        <div className="controls">
          <select 
            value={filterModel} 
            onChange={(e) => setFilterModel(e.target.value)}
            className="filter-select"
          >
            <option value="all">All Models</option>
            {models.map(model => (
              <option key={model} value={model}>
                {model.replace('anthropic/', '').replace('openai/', '').replace('google/', '')}
              </option>
            ))}
          </select>
          
          <select 
            value={sortBy} 
            onChange={(e) => setSortBy(e.target.value as any)}
            className="sort-select"
          >
            <option value="reward">Sort by Reward</option>
            <option value="programs">Sort by Programs</option>
            <option value="model">Sort by Model</option>
          </select>
        </div>
      </div>

      <div className="runs-grid">
        {processedRuns.map((run) => {
          const totalReward = run.cumulative_rewards[run.cumulative_rewards.length - 1] || 0;
          const programCount = Object.keys(run.programs_discovered).length;
          const modelShort = run.model.replace('anthropic/', '').replace('openai/', '').replace('google/', '');
          
          return (
            <Link 
              key={run.run_id} 
              to={`/run/${run.run_id}?benchmark=${run.benchmark || 'basic'}`}
              className="run-card"
            >
              <div className="run-card-header">
                <span className="run-id">{run.run_id}</span>
                <div className="badges">
                  <span className={`model-badge model-${modelShort.split('/')[0]}`}>
                    {modelShort}
                  </span>
                  {run.benchmark && (
                    <span className={`benchmark-badge benchmark-${run.benchmark}`}>
                      {run.benchmark}
                    </span>
                  )}
                </div>
              </div>
              
              <div className="run-stats">
                <div className="stat">
                  <span className="stat-label">Total Reward</span>
                  <span className="stat-value">{totalReward}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">Programs</span>
                  <span className="stat-value">{programCount}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">Messages</span>
                  <span className="stat-value">{run.cumulative_rewards.length}/50</span>
                </div>
              </div>
              
              <div className="mini-chart">
                <Sparkline data={run.cumulative_rewards} />
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
};

// Simple sparkline component
const Sparkline: React.FC<{ data: number[] }> = ({ data }) => {
  if (!data || data.length === 0) return null;
  
  const max = Math.max(...data);
  const width = 200;
  const height = 40;
  const step = width / (data.length - 1);
  
  const points = data
    .map((value, i) => `${i * step},${height - (value / max) * height}`)
    .join(' ');
  
  return (
    <svg width={width} height={height} className="sparkline">
      <polyline
        points={points}
        fill="none"
        stroke="#667eea"
        strokeWidth="2"
      />
    </svg>
  );
};

export default TrajectoryList;