import { AutonomousSystemOverseer } from "../src/services/autonomousOverseer";

const CHECK_INTERVAL = parseInt(process.env.OVERSEER_INTERVAL_MS || "120000", 10);

const overseer = new AutonomousSystemOverseer({
  checkIntervalMs: CHECK_INTERVAL,
  autoHealEnabled: true,
});

overseer.startAutonomousLoop();

// Handle graceful shutdown signals
process.on("SIGINT", () => {
  console.log("\n[AUTONOMOUS OVERSEER] Gracefully shutting down...");
  overseer.stopAutonomousLoop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[AUTONOMOUS OVERSEER] Received SIGTERM. Stopping loops...");
  overseer.stopAutonomousLoop();
  process.exit(0);
});
