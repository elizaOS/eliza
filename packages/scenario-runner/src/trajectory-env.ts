export function enableScenarioTrajectoryLogging(
  env: NodeJS.ProcessEnv = process.env,
): void {
  env.ELIZA_TRAJECTORY_LOGGING = "1";
}
