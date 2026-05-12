import { createServer } from "node:net";

const LISTEN_TIMEOUT_MS = 3000;
const CLOSE_GRACE_MS = 250;

function tryBindOnce(
	port: number,
	host: string,
): Promise<{ ok: true } | { ok: false }> {
	return new Promise((resolve) => {
		const server = createServer();
		let settled = false;

		const finish = (result: { ok: true } | { ok: false }) => {
			if (settled) return;
			settled = true;
			server.removeAllListeners();
			resolve(result);
		};

		const listenTimer = setTimeout(() => {
			try {
				server.close();
			} catch {
				/* already closed */
			}
			finish({ ok: false });
		}, LISTEN_TIMEOUT_MS);

		const fail = () => {
			clearTimeout(listenTimer);
			finish({ ok: false });
		};

		server.once("error", fail);
		server.listen({ port, host }, () => {
			clearTimeout(listenTimer);
			server.unref?.();

			// Bun on packaged Windows can occasionally never invoke the close
			// callback even though the listen succeeded. Without this grace timer
			// startup stalls before `port_selected`.
			const closeTimer = setTimeout(() => finish({ ok: true }), CLOSE_GRACE_MS);
			try {
				server.close(() => {
					clearTimeout(closeTimer);
					finish({ ok: true });
				});
			} catch {
				clearTimeout(closeTimer);
				finish({ ok: true });
			}
		});
	});
}

/**
 * Returns the first port in `[preferred, preferred+1, …)` that can be bound
 * on `host`, or throws if none found within `maxHops` attempts.
 */
export async function findFirstAvailableLoopbackPort(
	preferred: number,
	options?: { host?: string; maxHops?: number },
): Promise<number> {
	const host = options?.host ?? "127.0.0.1";
	const maxHops = options?.maxHops ?? 64;
	if (!Number.isFinite(preferred) || preferred < 1 || preferred > 65535) {
		throw new Error(`Invalid preferred port: ${preferred}`);
	}
	for (let i = 0; i < maxHops; i++) {
		const port = preferred + i;
		if (port > 65535) break;
		const result = await tryBindOnce(port, host);
		if (result.ok) {
			return port;
		}
	}
	throw new Error(
		`No free TCP port on ${host} in range ${preferred}–${preferred + maxHops - 1}`,
	);
}
