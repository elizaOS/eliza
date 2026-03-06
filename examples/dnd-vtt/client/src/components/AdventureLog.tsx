import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { useGameStore, LogEntry } from '../store/gameStore';
import clsx from 'clsx';

export function AdventureLog() {
  const { log } = useGameStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log.length]);

  return (
    <div className="bg-slate-800/80 rounded-lg border border-slate-700 h-full flex flex-col">
      <div className="px-4 py-3 border-b border-slate-700">
        <h3 className="fantasy-heading text-lg text-gold-400">
          📜 Adventure Log
        </h3>
      </div>
      
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {log.length === 0 ? (
          <div className="text-center text-slate-500 py-8">
            The adventure awaits...
          </div>
        ) : (
          log.map((entry) => (
            <LogEntryComponent key={entry.id} entry={entry} />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function rollNode(entry: LogEntry): ReactNode {
  if (!entry.metadata?.roll) return null;
  const roll = entry.metadata.roll as { total: number; type: string };
  return (
    <div className="mt-2 inline-flex items-center gap-2 bg-slate-800 rounded px-2 py-1">
      <span className="text-yellow-400">🎲</span>
      <span className="font-bold text-lg text-white">{String(roll.total)}</span>
      <span className="text-xs text-slate-400">({String(roll.type)})</span>
    </div>
  );
}

function damageNode(entry: LogEntry): ReactNode {
  if (entry.metadata?.damage == null) return null;
  return (
    <div className="mt-2 inline-flex items-center gap-2 bg-red-900/50 rounded px-2 py-1">
      <span className="text-red-400">💥</span>
      <span className="font-bold text-red-300">{String(entry.metadata.damage)} damage</span>
    </div>
  );
}

function healingNode(entry: LogEntry): ReactNode {
  if (!entry.metadata?.healing) return null;
  return (
    <div className="mt-2 inline-flex items-center gap-2 bg-green-900/50 rounded px-2 py-1">
      <span className="text-green-400">💚</span>
      <span className="font-bold text-green-300">{String(entry.metadata.healing)} healed</span>
    </div>
  );
}

function LogEntryComponent({ entry }: { entry: LogEntry }) {
  const typeStyles: Record<string, string> = {
    narrative: 'border-l-purple-500 bg-purple-900/20',
    action: 'border-l-blue-500 bg-blue-900/20',
    roll: 'border-l-yellow-500 bg-yellow-900/20',
    combat: 'border-l-red-500 bg-red-900/20',
    system: 'border-l-slate-500 bg-slate-900/20',
    error: 'border-l-orange-500 bg-orange-900/20',
  };

  const typeIcons: Record<string, string> = {
    narrative: '📖',
    action: '🎭',
    roll: '🎲',
    combat: '⚔️',
    system: '⚙️',
    error: '⚠️',
  };

  const formatTime = (date: Date) => {
    return new Date(date).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  return (
    <div
      className={clsx(
        'border-l-4 rounded-r px-3 py-2',
        typeStyles[entry.type]
      )}
    >
      <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
        <span>{typeIcons[entry.type]}</span>
        {entry.speaker && (
          <span className="font-medium text-slate-300">{entry.speaker}</span>
        )}
        <span className="ml-auto">{formatTime(entry.timestamp)}</span>
      </div>
      
      <div className="text-sm text-slate-200 whitespace-pre-wrap">
        {entry.content}
      </div>
      
      {/* Roll result display */}
      {rollNode(entry)}
      {/* Damage display */}
      {damageNode(entry)}
      {/* Healing display */}
      {healingNode(entry)}
    </div>
  );
}
