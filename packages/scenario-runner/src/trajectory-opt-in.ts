/**
 * The scenario runner's trajectory recording opt-in decision, isolated from the
 * CLI entry so it is unit-testable without executing `main()` (cli.ts runs on
 * import). The recorder default flipped to opt-in for `NODE_ENV=production|test`
 * (#13775/#13871), so a bare `eliza-scenarios run <scenario>` under those envs
 * would otherwise capture nothing — even though scenario trajectories are
 * required PR evidence. A run is trajectory evidence by definition, so it opts
 * in unconditionally, regardless of `--run-dir`/`--export-native` (#14111). An
 * operator-set `ELIZA_TRAJECTORY_LOGGING` is respected (including an explicit
 * `0`); the hard `ELIZA_DISABLE_TRAJECTORY_LOGGING=1` opt-out is enforced
 * downstream by the gate resolver, which honors it above this knob.
 */

/**
 * Whether the scenario runner should set `ELIZA_TRAJECTORY_LOGGING="1"`.
 * Returns `false` when the operator already set the knob (respect their value).
 */
export function shouldOptInScenarioTrajectoryLogging(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !env.ELIZA_TRAJECTORY_LOGGING;
}
