import { useEffect, useState } from "react";
import { useGameStore } from "../store/gameStore";

interface CampaignInfo {
	id: string;
	name: string;
	status: string;
	description: string;
}

interface CharacterInfo {
	id: string;
	name: string;
	race: string;
	class: string;
	level: number;
	isAI: boolean;
}

export function JoinScreen() {
	const { connected, joinCampaign } = useGameStore();
	const [campaigns, setCampaigns] = useState<CampaignInfo[]>([]);
	const [characters, setCharacters] = useState<CharacterInfo[]>([]);
	const [selectedCampaign, setSelectedCampaign] = useState<string | null>(null);
	const [selectedCharacter, setSelectedCharacter] = useState<string | null>(
		null,
	);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		async function fetchCampaigns() {
			try {
				const baseUrl = import.meta.env.VITE_API_URL || "http://localhost:4000";
				const res = await fetch(`${baseUrl}/api/campaigns`);
				const data = (await res.json()) as CampaignInfo[];
				setCampaigns(data);

				if (data.length === 1) {
					setSelectedCampaign(data[0].id);
				}
			} catch {
				setError(
					"Could not connect to server. Make sure the server is running.",
				);
			} finally {
				setLoading(false);
			}
		}
		fetchCampaigns();
	}, []);

	useEffect(() => {
		if (!selectedCampaign) {
			setCharacters([]);
			return;
		}

		async function fetchCharacters() {
			try {
				const baseUrl = import.meta.env.VITE_API_URL || "http://localhost:4000";
				const res = await fetch(
					`${baseUrl}/api/campaigns/${selectedCampaign}/characters`,
				);
				const data = (await res.json()) as CharacterInfo[];
				setCharacters(data);
				setSelectedCharacter(null);
			} catch {
				setCharacters([]);
			}
		}
		fetchCharacters();
	}, [selectedCampaign]);

	function handleJoin() {
		if (selectedCampaign && selectedCharacter) {
			joinCampaign(selectedCampaign, selectedCharacter);
		}
	}

	function handleSpectate() {
		if (selectedCampaign) {
			joinCampaign(selectedCampaign);
		}
	}

	return (
		<div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-4">
			<div className="w-full max-w-lg">
				<div className="text-center mb-8">
					<h1
						className="text-4xl font-bold text-amber-400 mb-2"
						style={{ fontFamily: "serif" }}
					>
						D&D Virtual Tabletop
					</h1>
					<p className="text-slate-400">AI-Powered Adventure Awaits</p>
				</div>

				<div className="bg-slate-800/80 border border-slate-700 rounded-xl p-6 shadow-2xl">
					<div className="flex items-center gap-2 mb-6 text-sm">
						<div
							className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`}
						/>
						<span className="text-slate-400">
							{connected ? "Connected to server" : "Connecting..."}
						</span>
					</div>

					{loading && (
						<div className="text-center py-8 text-slate-400">
							Loading campaigns...
						</div>
					)}

					{error && (
						<div className="bg-red-900/30 border border-red-800 rounded-lg p-4 mb-4 text-red-300 text-sm">
							{error}
						</div>
					)}

					{!loading && campaigns.length === 0 && !error && (
						<div className="text-center py-8">
							<p className="text-slate-400 mb-2">No campaigns found.</p>
							<p className="text-slate-500 text-sm">
								Run <code className="text-amber-400">bun run seed</code> on the
								server to create a starter adventure.
							</p>
						</div>
					)}

					{!loading && campaigns.length > 0 && (
						<>
							<div className="mb-6">
								<label className="block text-sm font-medium text-slate-300 mb-2">
									Select Campaign
								</label>
								<div className="space-y-2">
									{campaigns.map((campaign) => (
										<button
											key={campaign.id}
											onClick={() => setSelectedCampaign(campaign.id)}
											className={`w-full text-left p-3 rounded-lg border transition-all ${
												selectedCampaign === campaign.id
													? "border-amber-500 bg-amber-900/20 text-amber-200"
													: "border-slate-600 bg-slate-700/30 text-slate-300 hover:border-slate-500"
											}`}
										>
											<div className="font-medium">{campaign.name}</div>
											<div className="text-xs text-slate-400 mt-1 line-clamp-2">
												{campaign.description}
											</div>
										</button>
									))}
								</div>
							</div>

							{selectedCampaign && characters.length > 0 && (
								<div className="mb-6">
									<label className="block text-sm font-medium text-slate-300 mb-2">
										Choose Your Character
									</label>
									<div className="grid grid-cols-2 gap-2">
										{characters.map((char) => (
											<button
												key={char.id}
												onClick={() => setSelectedCharacter(char.id)}
												className={`text-left p-3 rounded-lg border transition-all ${
													selectedCharacter === char.id
														? "border-amber-500 bg-amber-900/20 text-amber-200"
														: "border-slate-600 bg-slate-700/30 text-slate-300 hover:border-slate-500"
												}`}
											>
												<div className="font-medium text-sm">{char.name}</div>
												<div className="text-xs text-slate-400">
													L{char.level} {char.race} {char.class}
												</div>
												{char.isAI && (
													<div className="text-xs text-blue-400 mt-1">
														AI-Controlled
													</div>
												)}
											</button>
										))}
									</div>
								</div>
							)}

							{selectedCampaign && characters.length === 0 && (
								<div className="mb-6 text-center py-4 text-slate-400 text-sm">
									No characters found for this campaign.
								</div>
							)}

							<div className="flex gap-3">
								<button
									onClick={handleJoin}
									disabled={
										!connected || !selectedCampaign || !selectedCharacter
									}
									className="flex-1 py-3 rounded-lg font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-amber-600 hover:bg-amber-500 text-white"
								>
									Join as Character
								</button>
								<button
									onClick={handleSpectate}
									disabled={!connected || !selectedCampaign}
									className="py-3 px-4 rounded-lg font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed border border-slate-600 text-slate-300 hover:border-slate-500 hover:text-white"
								>
									Spectate
								</button>
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
}
