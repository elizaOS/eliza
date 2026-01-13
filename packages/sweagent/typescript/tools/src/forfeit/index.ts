/**
 * Forfeit tool
 * Give up on the current challenge and terminate the session
 * Converted from tools/forfeit/bin/exit_forfeit
 */

function exitForfeit(): void {
  console.log('###SWE-AGENT-EXIT-FORFEIT###');
  process.exit(0);
}

// CLI if run directly
if (require.main === module) {
  exitForfeit();
}

export { exitForfeit };
