'use client';

import { Handle, type NodeProps, Position } from '@xyflow/react';
import { memo } from 'react';

interface DagNodeData {
  label: string;
  phase: string;
  phaseColor: string;
  description: string;
  status: 'success' | 'error' | 'skipped';
  durationMs: number;
  llmCallCount: number;
  hasError: boolean;
  isActive?: boolean;
  isCompleted?: boolean;
}

const statusIcons: Record<string, string> = {
  success: '\u2713',
  error: '\u2717',
  skipped: '\u2014',
};

export const DagNode = memo(function DagNode({ data }: NodeProps) {
  const d = data as unknown as DagNodeData;

  const borderColor = d.isActive
    ? '#4ade80'
    : d.status === 'error'
      ? '#ef4444'
      : d.status === 'skipped'
        ? '#475569'
        : d.isCompleted
          ? d.phaseColor
          : '#334155';

  const glowStyle = d.isActive
    ? {
        boxShadow:
          '0 0 12px rgba(74, 222, 128, 0.4), 0 0 4px rgba(74, 222, 128, 0.2)',
        animation: 'nodeGlow 1.5s ease-in-out infinite',
      }
    : {};

  return (
    <>
      <style>{`
        @keyframes nodeGlow {
          0%, 100% { box-shadow: 0 0 12px rgba(74,222,128,0.4), 0 0 4px rgba(74,222,128,0.2); }
          50% { box-shadow: 0 0 20px rgba(74,222,128,0.6), 0 0 8px rgba(74,222,128,0.3); }
        }
      `}</style>

      <Handle
        type="target"
        position={Position.Top}
        style={{
          background: d.isActive ? '#4ade80' : '#475569',
          width: 6,
          height: 6,
        }}
      />

      <div
        style={{
          background: d.isActive ? '#0f2418' : '#1e293b',
          border: `2px solid ${borderColor}`,
          borderRadius: 8,
          padding: '8px 12px',
          width: 200,
          opacity: d.status === 'skipped' && !d.isActive ? 0.45 : 1,
          cursor: 'pointer',
          transition: 'all 0.3s ease',
          ...glowStyle,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {d.isActive && (
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: '#4ade80',
                display: 'inline-block',
                animation: 'pulse 1s infinite',
                flexShrink: 0,
              }}
            />
          )}
          <span
            style={{
              color: d.isActive ? '#4ade80' : borderColor,
              fontSize: 13,
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {!d.isActive && (statusIcons[d.status] ?? '')} {d.label}
          </span>
        </div>

        {/* Meta row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 4,
            fontSize: 10,
            color: '#94a3b8',
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              background: `${d.phaseColor}22`,
              color: d.phaseColor,
              padding: '1px 5px',
              borderRadius: 4,
            }}
          >
            {d.phase}
          </span>
          {d.durationMs > 0 && <span>{d.durationMs}ms</span>}
          {d.llmCallCount > 0 && (
            <span
              style={{
                background: '#7c3aed22',
                color: '#a78bfa',
                padding: '1px 5px',
                borderRadius: 4,
              }}
            >
              LLM x{d.llmCallCount}
            </span>
          )}
          {d.isActive && (
            <span
              style={{
                background: '#16a34a22',
                color: '#4ade80',
                padding: '1px 5px',
                borderRadius: 4,
                fontWeight: 600,
              }}
            >
              RUNNING
            </span>
          )}
        </div>

        {d.hasError && (
          <div style={{ color: '#ef4444', fontSize: 10, marginTop: 2 }}>
            Error occurred
          </div>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        style={{
          background: d.isActive ? '#4ade80' : '#475569',
          width: 6,
          height: 6,
        }}
      />
    </>
  );
});
