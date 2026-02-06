import { useGameStore } from '../store/gameStore';

export function Header() {
  const { connected, phase, round, inCombat, character } = useGameStore();

  return (
    <header className="bg-slate-900/90 border-b border-slate-700 px-4 py-3">
      <div className="container mx-auto flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="fantasy-heading text-2xl text-gold-400">
            D&D Virtual Tabletop
          </h1>
          
          <div className="flex items-center gap-2 text-sm">
            <span 
              className={`w-2 h-2 rounded-full ${
                connected ? 'bg-green-500' : 'bg-red-500'
              }`}
            />
            <span className="text-slate-400">
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>
        
        <div className="flex items-center gap-6">
          {/* Game Phase */}
          <div className="flex items-center gap-2">
            <span className="text-slate-400 text-sm">Phase:</span>
            <span className={`px-2 py-1 rounded text-sm font-medium ${
              inCombat 
                ? 'bg-red-900/50 text-red-300 border border-red-700' 
                : 'bg-slate-700 text-slate-300'
            }`}>
              {phase.charAt(0).toUpperCase() + phase.slice(1)}
              {inCombat && ` • Round ${round}`}
            </span>
          </div>
          
          {/* Character Info */}
          {character && (
            <div className="flex items-center gap-3 pl-6 border-l border-slate-700">
              <div className="text-right">
                <div className="text-sm font-medium text-slate-200">
                  {character.name}
                </div>
                <div className="text-xs text-slate-400">
                  {character.race} {character.class} {character.level}
                </div>
              </div>
              
              <div className="flex flex-col items-center">
                <div className="text-xs text-slate-500">HP</div>
                <div className={`text-sm font-bold ${
                  character.hp.current <= character.hp.max * 0.25 
                    ? 'text-red-400' 
                    : character.hp.current <= character.hp.max * 0.5
                    ? 'text-yellow-400'
                    : 'text-green-400'
                }`}>
                  {character.hp.current}/{character.hp.max}
                </div>
              </div>
              
              <div className="flex flex-col items-center">
                <div className="text-xs text-slate-500">AC</div>
                <div className="text-sm font-bold text-slate-200">
                  {character.ac}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
