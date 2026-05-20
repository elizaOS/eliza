'use client';

interface TraceSummary {
  dirName: string;
  tickId: string;
  tickNumber?: number;
  timestamp?: string;
  durationMs?: number;
}

interface TickSelectorProps {
  traces: TraceSummary[];
  selected: string | null;
  onSelect: (dirName: string) => void;
}

export function TickSelector({
  traces,
  selected,
  onSelect,
}: TickSelectorProps) {
  const currentIdx = traces.findIndex((t) => t.dirName === selected);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        onClick={() => {
          if (currentIdx < traces.length - 1) {
            onSelect(traces[currentIdx + 1]!.dirName);
          }
        }}
        disabled={currentIdx >= traces.length - 1}
        style={{
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: 4,
          color: '#e2e8f0',
          padding: '4px 8px',
          cursor: currentIdx >= traces.length - 1 ? 'not-allowed' : 'pointer',
          opacity: currentIdx >= traces.length - 1 ? 0.4 : 1,
          fontSize: 13,
        }}
      >
        &larr; Older
      </button>

      <select
        value={selected ?? ''}
        onChange={(e) => onSelect(e.target.value)}
        style={{
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: 4,
          color: '#e2e8f0',
          padding: '4px 8px',
          fontSize: 13,
          minWidth: 280,
        }}
      >
        {traces.map((t) => (
          <option key={t.dirName} value={t.dirName}>
            {t.timestamp ? new Date(t.timestamp).toLocaleString() : t.dirName}
            {t.durationMs ? ` (${t.durationMs}ms)` : ''}
          </option>
        ))}
        {traces.length === 0 && <option value="">No traces available</option>}
      </select>

      <button
        onClick={() => {
          if (currentIdx > 0) {
            onSelect(traces[currentIdx - 1]!.dirName);
          }
        }}
        disabled={currentIdx <= 0}
        style={{
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: 4,
          color: '#e2e8f0',
          padding: '4px 8px',
          cursor: currentIdx <= 0 ? 'not-allowed' : 'pointer',
          opacity: currentIdx <= 0 ? 0.4 : 1,
          fontSize: 13,
        }}
      >
        Newer &rarr;
      </button>
    </div>
  );
}
