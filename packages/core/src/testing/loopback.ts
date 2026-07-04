/**
 * Memoized probe for whether the process can bind a TCP socket on the loopback
 * interface (127.0.0.1), letting tests skip cases that need a real listening
 * port in sandboxes that forbid it.
 */
import net from "node:net";

let loopbackAvailabilityPromise: Promise<boolean> | null = null;

export function canBindLoopback(): Promise<boolean> {
	if (loopbackAvailabilityPromise) {
		return loopbackAvailabilityPromise;
	}

	loopbackAvailabilityPromise = new Promise((resolve) => {
		const server = net.createServer();
		let settled = false;

		const finish = (value: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			server.removeAllListeners();
			resolve(value);
		};

		server.once("error", () => {
			finish(false);
		});

		server.listen(0, "127.0.0.1", () => {
			server.close(() => finish(true));
		});
	});

	return loopbackAvailabilityPromise;
}
