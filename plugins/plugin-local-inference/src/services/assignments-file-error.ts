/**
 * Typed failure for a damaged `assignments.json`, shared by the services
 * assignment store and the HTTP route module. Kept dependency-free so the route
 * module can import it without pulling the catalog/registry graph onto the boot
 * critical path (#9565).
 */

/**
 * Raised when `assignments.json` exists but cannot be read or parsed.
 *
 * Distinct from an absent file (`ENOENT`), which legitimately means "no saved
 * slots yet". A damaged store must not reach callers as an empty policy:
 * every read-modify-write of the store (`setAssignment`,
 * `ensureDefaultAssignment`, the assignments route) would otherwise rewrite the
 * file from `{}` and silently drop every slot the user had already chosen.
 */
export class AssignmentsFileError extends Error {
	constructor(
		message: string,
		readonly code: "ASSIGNMENTS_UNREADABLE" | "ASSIGNMENTS_CORRUPT",
		readonly path: string,
		cause?: unknown,
	) {
		super(message, { cause });
		this.name = "AssignmentsFileError";
	}
}

/**
 * Strict JSON read for `assignments.json`: `ENOENT` resolves to `null` (first
 * boot, nothing saved yet); any other read failure or a parse failure throws
 * {@link AssignmentsFileError} so callers never mistake a damaged store for an
 * empty one.
 */
export async function readAssignmentsJson(
	file: string,
	readFile: (file: string, encoding: "utf8") => Promise<string>,
): Promise<unknown> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (error) {
		// error-policy:J3 first boot has no assignments.json, so `ENOENT` is the
		// expected "nothing saved yet" answer. Any other read failure means the
		// store is there but unusable; keep it visible to the caller.
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
		throw new AssignmentsFileError(
			`Cannot read model assignments ${file}`,
			"ASSIGNMENTS_UNREADABLE",
			file,
			error,
		);
	}
	try {
		return JSON.parse(raw) as unknown;
	} catch (error) {
		// error-policy:J2 context-adding rethrow — a store that exists but does
		// not parse is corrupt, not an empty assignment policy.
		throw new AssignmentsFileError(
			`Model assignments are corrupt (invalid JSON): ${file}`,
			"ASSIGNMENTS_CORRUPT",
			file,
			error,
		);
	}
}
