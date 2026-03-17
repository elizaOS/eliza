import clsx from "clsx";
import { useGameStore } from "../store/gameStore";

export function InitiativeTracker() {
	const { combatants, round } = useGameStore();

	if (combatants.length === 0) {
		return null;
	}

	return (
		<div className="bg-slate-800/80 rounded-lg border border-slate-700 overflow-hidden">
			<div className="bg-red-900/50 px-4 py-2 border-b border-red-800">
				<h3 className="fantasy-heading text-lg text-red-200 flex items-center gap-2">
					⚔️ Combat - Round {round}
				</h3>
			</div>

			<div className="p-2 space-y-1 max-h-80 overflow-y-auto">
				{combatants.map((combatant, index) => (
					<div
						key={combatant.id}
						className={clsx(
							"flex items-center gap-3 px-3 py-2 rounded transition-colors",
							combatant.isCurrentTurn
								? "bg-gold-500/20 border border-gold-500/50 combat-highlight"
								: "bg-slate-700/50 hover:bg-slate-700",
						)}
					>
						{/* Turn indicator */}
						<div className="w-6 text-center">
							{combatant.isCurrentTurn ? (
								<span className="text-gold-400">▶</span>
							) : (
								<span className="text-slate-500 text-sm">{index + 1}</span>
							)}
						</div>

						{/* Initiative */}
						<div className="w-8 text-center">
							<span className="text-xs text-slate-400">Init</span>
							<div className="font-bold text-slate-200">
								{combatant.initiative}
							</div>
						</div>

						{/* Name and type */}
						<div className="flex-1 min-w-0">
							<div
								className={clsx(
									"font-medium truncate",
									combatant.type === "pc"
										? "text-green-400"
										: combatant.type === "npc"
											? "text-blue-400"
											: "text-red-400",
								)}
							>
								{combatant.name}
							</div>
							{combatant.conditions.length > 0 && (
								<div className="text-xs text-yellow-400 truncate">
									{combatant.conditions.join(", ")}
								</div>
							)}
						</div>

						{/* HP */}
						<div className="text-right">
							<div className="text-xs text-slate-400">HP</div>
							<div
								className={clsx(
									"font-bold",
									combatant.hp.current <= 0
										? "text-red-500"
										: combatant.hp.current <= combatant.hp.max * 0.25
											? "text-red-400"
											: combatant.hp.current <= combatant.hp.max * 0.5
												? "text-yellow-400"
												: "text-green-400",
								)}
							>
								{combatant.type === "monster"
									? getHealthLabel(combatant.hp.current, combatant.hp.max)
									: `${combatant.hp.current}/${combatant.hp.max}`}
							</div>
						</div>

						{/* AC */}
						<div className="text-right w-10">
							<div className="text-xs text-slate-400">AC</div>
							<div className="font-bold text-slate-200">{combatant.ac}</div>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

function getHealthLabel(current: number, max: number): string {
	const percent = current / max;

	if (current <= 0) return "Down";
	if (percent >= 1) return "Healthy";
	if (percent >= 0.75) return "Wounded";
	if (percent >= 0.5) return "Injured";
	if (percent >= 0.25) return "Bloodied";
	return "Critical";
}
