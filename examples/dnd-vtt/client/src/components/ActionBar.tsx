import { useState, FormEvent } from 'react';
import { useGameStore } from '../store/gameStore';
import clsx from 'clsx';

export function ActionBar() {
  const [message, setMessage] = useState('');
  const { sendMessage, sendAction, inCombat, connected } = useGameStore();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!message.trim() || !connected) return;
    
    sendMessage(message.trim());
    setMessage('');
  };

  const quickActions = inCombat ? [
    { label: 'Attack', action: 'attack', icon: '⚔️' },
    { label: 'Cast Spell', action: 'cast_spell', icon: '✨' },
    { label: 'Dash', action: 'dash', icon: '💨' },
    { label: 'Dodge', action: 'dodge', icon: '🛡️' },
    { label: 'Disengage', action: 'disengage', icon: '🏃' },
    { label: 'End Turn', action: 'end_turn', icon: '⏭️' },
  ] : [
    { label: 'Look Around', action: 'explore', icon: '👁️' },
    { label: 'Investigate', action: 'investigate', icon: '🔍' },
    { label: 'Rest', action: 'rest', icon: '🛏️' },
    { label: 'Use Item', action: 'use_item', icon: '🎒' },
  ];

  return (
    <div className="bg-slate-800/80 rounded-lg border border-slate-700 p-3">
      {/* Quick Actions */}
      <div className="flex gap-2 mb-3 overflow-x-auto pb-2">
        {quickActions.map(({ label, action, icon }) => (
          <button
            key={action}
            onClick={() => sendAction(action)}
            disabled={!connected}
            className={clsx(
              'flex items-center gap-2 px-3 py-2 rounded font-medium text-sm whitespace-nowrap',
              'transition-colors',
              connected
                ? 'bg-slate-700 hover:bg-slate-600 text-slate-200'
                : 'bg-slate-800 text-slate-500 cursor-not-allowed'
            )}
          >
            <span>{icon}</span>
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* Message Input */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={
            inCombat 
              ? "Describe your action..." 
              : "What do you do?"
          }
          disabled={!connected}
          className={clsx(
            'flex-1 px-4 py-2 rounded bg-slate-900 border',
            'text-slate-200 placeholder-slate-500',
            'focus:outline-none focus:ring-2',
            connected
              ? 'border-slate-600 focus:border-gold-500 focus:ring-gold-500/30'
              : 'border-slate-700 cursor-not-allowed'
          )}
        />
        <button
          type="submit"
          disabled={!connected || !message.trim()}
          className={clsx(
            'px-6 py-2 rounded font-medium transition-colors',
            connected && message.trim()
              ? 'bg-gold-600 hover:bg-gold-500 text-white'
              : 'bg-slate-700 text-slate-500 cursor-not-allowed'
          )}
        >
          Send
        </button>
      </form>

      {/* Connection Status */}
      {!connected && (
        <div className="mt-2 text-center text-sm text-red-400">
          Not connected to game server
        </div>
      )}
    </div>
  );
}
