/** Per-file lock for read-modify-write updates of local-inference JSON files. */

// Serializes read-modify-write transactions per persisted config file. The
// management mutations (set_assignment, upsertInstalledModel,
// removeInstalledModel) each read the current JSON, mutate it, and write it
// back; two concurrent mutations against one file would otherwise both read the
// pre-write state and the second write would clobber the first, silently
// dropping an update while both callers return success (issue #25123). Keyed by
// absolute file path so unrelated files never serialize against each other. The
// stored promise is settle-tracking, so one rejected transaction never breaks
// the chain for the next waiter.
const configFileMutex = new Map<string, Promise<unknown>>();
export async function withConfigFileLock<T>(
	filePath: string,
	task: () => Promise<T>,
): Promise<T> {
	const prior = configFileMutex.get(filePath) ?? Promise.resolve();
	const next = prior.then(task, task);
	configFileMutex.set(
		filePath,
		next.then(
			() => undefined,
			() => undefined,
		),
	);
	return next;
}
