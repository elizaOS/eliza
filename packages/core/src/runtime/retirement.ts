/** Retains lifecycle work and teardown failures after best-effort shutdown clears its lookup registries. Strict retirement waits for original operations, including work they spawn, without retrying hooks or closing shared resources. */

import { ElizaError } from "../errors";

export class RuntimeRetirement {
	private readonly pending = new Map<
		Promise<unknown>,
		{ beforeClose: boolean }
	>();
	private readonly failures: { error: Error; beforeClose: boolean }[] = [];
	private revision = 0;

	get generation(): number {
		return this.revision;
	}

	/** Publish ownership before invoking a hook, including synchronous reentrancy. */
	run<T>(
		operation: () => T | PromiseLike<T>,
		{ beforeClose = false }: { beforeClose?: boolean } = {},
	): Promise<T> {
		let resolve!: (value: T | PromiseLike<T>) => void;
		let reject!: (reason: unknown) => void;
		const result = new Promise<T>((settle, fail) => {
			resolve = settle;
			reject = fail;
		});
		this.pending.set(result, { beforeClose });
		this.revision += 1;
		void result.then(
			() => this.pending.delete(result),
			() => this.pending.delete(result),
		);
		try {
			resolve(operation());
		} catch (error) {
			// error-policy:J2 preserve synchronous hook failure for the original caller.
			reject(error);
		}
		return result;
	}

	recordFailure(
		scope: string,
		cause: unknown,
		{ beforeClose = false }: { beforeClose?: boolean } = {},
	): void {
		this.failures.push({
			beforeClose,
			error: new ElizaError(`Runtime retirement failed during ${scope}`, {
				code: "RUNTIME_RETIREMENT_FAILED",
				cause,
				context: { scope },
			}),
		});
	}

	async drain({
		beforeCloseOnly = false,
	}: {
		beforeCloseOnly?: boolean;
	} = {}): Promise<void> {
		for (;;) {
			const pending = [...this.pending]
				.filter(([, owner]) => !beforeCloseOnly || owner.beforeClose)
				.map(([operation]) => operation);
			if (pending.length === 0) break;
			await Promise.allSettled(pending);
		}
		const failures = this.failures
			.filter((failure) => !beforeCloseOnly || failure.beforeClose)
			.map((failure) => failure.error);
		if (failures.length > 0) {
			throw new ElizaError(
				"Runtime teardown failed; quiescence is not established",
				{
					code: "RUNTIME_QUIESCENCE_FAILED",
					cause: new AggregateError(failures, "Runtime teardown failures"),
					context: { failureCount: failures.length },
				},
			);
		}
	}
}
