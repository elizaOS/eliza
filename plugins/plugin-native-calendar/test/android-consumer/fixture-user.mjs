/**
 * Removes a harness-owned Android user. The fixture user is created
 * `--ephemeral`, and Android removes an ephemeral user by itself once it
 * leaves the foreground, so an immediate `pm remove-user` can lose that race
 * with `Error: couldn't remove user id N` while removal is already under way.
 * Removal is complete when the user is gone from `pm list users`; it fails
 * only if the user is still present when the deadline passes.
 */
export async function removeFixtureUser(
  run,
  user,
  {
    timeoutMs,
    pollMs = 500,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
) {
  let attempt;
  try {
    attempt = run("shell", "pm", "remove-user", String(user));
  } catch (error) {
    // error-policy:J4 a lost race with the system's own removal is decided
    // by the user list below, not by this command's exit status.
    attempt =
      [error.stdout, error.stderr]
        .map((output) => String(output ?? "").trim())
        .filter(Boolean)
        .join("\n") || error.message;
  }
  if (/Success/.test(attempt)) return attempt;
  const listed = new RegExp(`\\{${user}:`);
  for (const deadline = Date.now() + timeoutMs; ; ) {
    const inventory = run("shell", "pm", "list", "users");
    if (!/UserInfo\{0:/.test(inventory))
      throw new Error(
        "Android user inventory unavailable; removal is unproven",
      );
    if (!listed.test(inventory))
      return `User ${user} was removed by the system after leaving the foreground (${attempt})`;
    if (Date.now() >= deadline)
      throw new Error(`Fixture user ${user} is still present: ${attempt}`);
    await sleep(pollMs);
  }
}

/**
 * Waits until the fixture user reports RUNNING_UNLOCKED. Host cancellation
 * stops the wait at once, and a user that never unlocks fails at the
 * deadline so the caller's cleanup still releases the user and device lease.
 */
export async function waitForUserUnlocked(
  run,
  user,
  {
    timeoutMs,
    signal,
    pollMs = 500,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
) {
  let state;
  for (const deadline = Date.now() + timeoutMs; ; ) {
    signal?.throwIfAborted();
    state = run("shell", "am", "get-started-user-state", String(user));
    if (state === "RUNNING_UNLOCKED") return;
    if (Date.now() >= deadline)
      throw new Error(`Fixture user ${user} did not unlock: ${state}`);
    await sleep(pollMs);
  }
}
