import React, { useState, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';
import { OODAContext, OODAPhase, LoopMetrics, Goal, Observation, ActionExecution } from '../types';

interface OODAMonitorProps {
  apiUrl?: string;
}

const OODAMonitor: React.FC<OODAMonitorProps> = ({ apiUrl = 'http://localhost:3001' }) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [context, setContext] = useState<OODAContext | null>(null);
  const [metrics, setMetrics] = useState<LoopMetrics | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Connect to WebSocket
    const newSocket = io(apiUrl, {
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    newSocket.on('connect', () => {
      setIsConnected(true);
      setError(null);
      newSocket.emit('request:context');
      newSocket.emit('request:metrics');
    });

    newSocket.on('disconnect', () => {
      setIsConnected(false);
    });

    newSocket.on('connect_error', (err) => {
      setError(`Connection error: ${err.message}`);
    });

    newSocket.on('ooda:context', (data: OODAContext) => {
      setContext(data);
    });

    newSocket.on('ooda:metrics', (data: LoopMetrics) => {
      setMetrics(data);
    });

    setSocket(newSocket);

    return () => {
      newSocket.close();
    };
  }, [apiUrl]);

  const getPhaseColor = (phase: OODAPhase): string => {
    const colors: Record<OODAPhase, string> = {
      [OODAPhase.IDLE]: '#6b7280',
      [OODAPhase.OBSERVING]: '#3b82f6',
      [OODAPhase.ORIENTING]: '#8b5cf6',
      [OODAPhase.DECIDING]: '#f59e0b',
      [OODAPhase.ACTING]: '#10b981',
      [OODAPhase.REFLECTING]: '#6366f1',
    };
    return colors[phase] || '#6b7280';
  };

  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  const renderConnectionStatus = () => (
    <div className={`mb-4 p-3 rounded-lg ${isConnected ? 'bg-green-100' : 'bg-red-100'}`}>
      <div className="flex items-center">
        <div
          className={`w-3 h-3 rounded-full mr-2 ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}
        />
        <span className={`font-semibold ${isConnected ? 'text-green-700' : 'text-red-700'}`}>
          {isConnected ? 'Connected' : 'Disconnected'}
        </span>
      </div>
      {error && <p className="text-red-600 text-sm mt-1">{error}</p>}
    </div>
  );

  const renderPhaseIndicator = () => {
    if (!context) return null;

    return (
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-3">Current Phase</h3>
        <div className="flex space-x-2">
          {Object.values(OODAPhase).map((phase) => (
            <div
              key={phase}
              className={`
                px-4 py-2 rounded-lg text-sm font-medium transition-all
                ${
                  context.phase === phase
                    ? 'text-white shadow-lg transform scale-105'
                    : 'text-gray-600 bg-gray-100'
                }
              `}
              style={{
                backgroundColor: context.phase === phase ? getPhaseColor(phase) : undefined,
              }}
            >
              {phase.charAt(0).toUpperCase() + phase.slice(1)}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderMetrics = () => {
    if (!metrics) return null;

    return (
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white p-4 rounded-lg shadow">
          <h4 className="text-sm text-gray-600">Cycle Time</h4>
          <p className="text-2xl font-bold text-blue-600">{formatDuration(metrics.cycleTime)}</p>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <h4 className="text-sm text-gray-600">Success Rate</h4>
          <p className="text-2xl font-bold text-green-600">
            {(metrics.actionSuccessRate * 100).toFixed(1)}%
          </p>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <h4 className="text-sm text-gray-600">Error Rate</h4>
          <p className="text-2xl font-bold text-red-600">{(metrics.errorRate * 100).toFixed(1)}%</p>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <h4 className="text-sm text-gray-600">Decisions/Cycle</h4>
          <p className="text-2xl font-bold text-purple-600">{metrics.decisionsPerCycle}</p>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <h4 className="text-sm text-gray-600">Resource Efficiency</h4>
          <p className="text-2xl font-bold text-orange-600">
            {(metrics.resourceEfficiency * 100).toFixed(1)}%
          </p>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <h4 className="text-sm text-gray-600">Goal Progress</h4>
          <p className="text-2xl font-bold text-indigo-600">
            {(metrics.goalProgress * 100).toFixed(1)}%
          </p>
        </div>
      </div>
    );
  };

  const renderGoals = () => {
    if (!context?.orientation.currentGoals) return null;

    return (
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-3">Active Goals</h3>
        <div className="space-y-2">
          {context.orientation.currentGoals.map((goal: Goal) => (
            <div key={goal.id} className="bg-white p-4 rounded-lg shadow">
              <div className="flex justify-between items-center mb-2">
                <h4 className="font-medium">{goal.description}</h4>
                <span className="text-sm text-gray-600">Priority: {goal.priority}</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${goal.progress * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderObservations = () => {
    if (!context?.observations || context.observations.length === 0) return null;

    const recentObservations = context.observations.slice(-5);

    return (
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-3">Recent Observations</h3>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="space-y-2">
            {recentObservations.map((obs: Observation, index: number) => (
              <div key={index} className="border-b last:border-b-0 pb-2 last:pb-0">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium text-gray-700">{obs.type}</span>
                  <span className="text-xs text-gray-500">
                    {new Date(obs.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <p className="text-sm text-gray-600 mt-1">
                  Source: {obs.source} | Relevance: {(obs.relevance * 100).toFixed(0)}%
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderActions = () => {
    if (!context?.actions || context.actions.length === 0) return null;

    const recentActions = context.actions.slice(-5);

    return (
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-3">Recent Actions</h3>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="space-y-2">
            {recentActions.map((action: ActionExecution) => (
              <div key={action.id} className="border-b last:border-b-0 pb-2 last:pb-0">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium text-gray-700">{action.actionName}</span>
                  <span
                    className={`
                    text-xs px-2 py-1 rounded
                    ${action.status === 'succeeded' ? 'bg-green-100 text-green-700' : ''}
                    ${action.status === 'failed' ? 'bg-red-100 text-red-700' : ''}
                    ${action.status === 'running' ? 'bg-blue-100 text-blue-700' : ''}
                    ${action.status === 'pending' ? 'bg-gray-100 text-gray-700' : ''}
                  `}
                  >
                    {action.status}
                  </span>
                </div>
                {action.endTime && (
                  <p className="text-sm text-gray-600 mt-1">
                    Duration: {formatDuration(action.endTime - action.startTime)}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderErrors = () => {
    if (!context?.errors || context.errors.length === 0) return null;

    return (
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-3 text-red-600">Recent Errors</h3>
        <div className="bg-red-50 rounded-lg shadow p-4">
          <div className="space-y-2">
            {context.errors.slice(-3).map((error, index) => (
              <div key={index} className="text-sm">
                <p className="font-medium text-red-700">{error.message}</p>
                {error.stack && (
                  <pre className="text-xs text-red-600 mt-1 overflow-x-auto">{error.stack}</pre>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold mb-6">OODA Loop Monitor</h1>

        {renderConnectionStatus()}

        {isConnected && context ? (
          <>
            <div className="bg-white rounded-lg shadow p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">
                Run ID: <span className="text-blue-600">{context.runId}</span>
              </h2>
              {renderPhaseIndicator()}
            </div>

            {renderMetrics()}
            {renderGoals()}

            <div className="grid md:grid-cols-2 gap-6">
              <div>{renderObservations()}</div>
              <div>{renderActions()}</div>
            </div>

            {renderErrors()}
          </>
        ) : (
          <div className="text-center py-12">
            <p className="text-gray-600">
              {isConnected ? 'Waiting for OODA data...' : 'Connecting to server...'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default OODAMonitor;
