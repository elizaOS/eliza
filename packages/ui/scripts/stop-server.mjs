/**
 * Fix #32375: UI static-server test cleanup hangs after an early child exit.
 *
 * stopServer registers its exit listener BEFORE requesting termination and
 * resolves immediately when the child has already exited (exitCode !== null),
 * whether by normal exit or signal. Bounded fallback ensures cleanup itself
 * can never hang the runner.
 */
async function stopServer(child, label) {
  const alreadyExited = child.exitCode !== null || child.signalCode !== null;
  if (alreadyExited) {
    // Child terminated on its own before cleanup (normal exit or signal).
    // The `exit` event has already fired; subscribing now would never resolve.
    return;
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      // error-policy:J5 cleanup must not hang the lane. Escalate to SIGKILL
      // and resolve regardless — the server child is disposable.
      child.kill("SIGKILL");
      setTimeout(resolve, 250);
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

export { stopServer };
