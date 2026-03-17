import { useEffect } from "react";
import { ActionBar } from "./components/ActionBar";
import { AdventureLog } from "./components/AdventureLog";
import { BattleMap } from "./components/BattleMap";
import { CharacterPanel } from "./components/CharacterPanel";
import { Header } from "./components/Header";
import { InitiativeTracker } from "./components/InitiativeTracker";
import { JoinScreen } from "./components/JoinScreen";
import { useGameStore } from "./store/gameStore";

function App() {
	const { connect, joined, phase, inCombat } = useGameStore();

	useEffect(() => {
		connect();
	}, [connect]);

	if (!joined) return <JoinScreen />;

	return (
		<div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
			<Header />
			<div className="container mx-auto p-4">
				<div className="grid grid-cols-12 gap-4 h-[calc(100vh-8rem)]">
					<div className="col-span-3 flex flex-col gap-4">
						<CharacterPanel />
						{inCombat && <InitiativeTracker />}
					</div>
					<div className="col-span-6 flex flex-col gap-4">
						<div className="flex-1 rounded-lg overflow-hidden border border-slate-700 bg-slate-800/50">
							{inCombat ? (
								<BattleMap />
							) : (
								<div className="h-full flex items-center justify-center">
									<div className="text-center p-8 max-w-md">
										<h2
											className="text-2xl text-amber-400 mb-4"
											style={{ fontFamily: "serif" }}
										>
											{phase === "exploration" && "Exploring..."}
											{phase === "social" && "In Conversation"}
											{phase === "rest" && "Resting..."}
											{phase === "narration" && "The Story Unfolds"}
											{phase === "initializing" && "Preparing the Adventure..."}
										</h2>
										<p className="text-slate-300">
											The adventure continues. Use the action bar below to
											interact with the world.
										</p>
									</div>
								</div>
							)}
						</div>
						<ActionBar />
					</div>
					<div className="col-span-3">
						<AdventureLog />
					</div>
				</div>
			</div>
		</div>
	);
}

export default App;
