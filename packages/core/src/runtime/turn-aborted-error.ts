/** Free of Node imports so renderer-reachable modules can test for a cancelled turn. */
export class TurnAbortedError extends Error {
	readonly code = "TURN_ABORTED";
	readonly reason: string;
	constructor(reason: string) {
		super(`Turn aborted: ${reason}`);
		this.reason = reason;
	}
}
