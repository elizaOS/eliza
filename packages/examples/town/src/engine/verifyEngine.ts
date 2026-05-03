import { defaultModelSettings } from "../runtime/modelSettings.ts";
import { TownEngine } from "./townEngine.ts";

async function run(): Promise<void> {
  const settings = defaultModelSettings();
  settings.provider = "local";
  const engine = new TownEngine({
    settingsProvider: () => settings,
    attachToTownContext: true,
  });

  console.info("[engine] created", {
    agents: engine.getState().agents.length,
    phase: engine.getGameState().phase,
  });

  engine.startGameRound();
  console.info("[engine] round started", {
    phase: engine.getGameState().phase,
    round: engine.getGameState().round,
  });

  for (let i = 0; i < 3; i += 1) {
    await engine.stepTick();
    engine.stepFrame(Date.now());
    console.info("[engine] tick", {
      tick: i + 1,
      phase: engine.getGameState().phase,
      alive: engine.getGameState().players.filter((p) => p.alive).length,
    });
  }

  engine.stop();
  console.info("[engine] stopped");
}

run().catch((error) => {
  console.error("[engine] error", error);
  process.exitCode = 1;
});
