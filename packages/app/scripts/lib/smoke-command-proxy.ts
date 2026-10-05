/** Resolves native smoke commands through an optional deterministic command proxy. */
export function resolveSmokeCommand(command, args) {
  const proxy = process.env.ELIZA_SMOKE_COMMAND_PROXY;
  if (!proxy) return { command, args };
  return { command: process.execPath, args: [proxy, command, ...args] };
}
