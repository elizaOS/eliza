import { Session } from "electrobun/bun";
import { logger } from "../logger";
import { resolveMainWindowPartition } from "../main-window-session";
import {
	type DesktopSession,
	installDesktopSessionCookies,
	loadOrCreateDesktopSession,
} from "../native/auth-bridge";

// Tracks whether the desktop loopback session has already been primed for the
// current process lifetime. The bridge is idempotent on disk, but cookie jar
// writes are cheap and we don't need to repeat them on every status tick.
let desktopSessionPrimed = false;

/**
 * Reset the primed flag so the next call to primeDesktopSessionAuth() re-runs
 * the bridge. Used when the embedded agent rebinds to a new loopback port —
 * cookies installed for the old origin don't authenticate the new one.
 */
export function markDesktopSessionStale(): void {
	desktopSessionPrimed = false;
}

/**
 * Best-effort: mint (or reuse) a loopback-only desktop session and install the
 * cookies into the main window's session jar so the renderer's first /api
 * request is already authenticated. Failure is silent — the renderer falls
 * back to the standard login flow.
 *
 * Loopback-only enforcement is implemented server-side: the auth-context
 * resolver MUST refuse a session marked loopback-only on a non-loopback
 * request. The bridge does not — and cannot — be that boundary.
 */
export async function primeDesktopSessionAuth(
	apiBase: string,
	rendererOrigin: string,
): Promise<void> {
	if (desktopSessionPrimed) return;
	let session: DesktopSession | null;
	try {
		session = await loadOrCreateDesktopSession({ apiBase });
	} catch (err) {
		logger.warn(
			`[Main] Desktop auth bridge failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}
	if (!session) {
		logger.info(
			"[Main] Desktop auth bridge produced no session; renderer will use the standard login flow.",
		);
		return;
	}

	try {
		const partition = resolveMainWindowPartition(process.env);
		const electrobunSession =
			partition !== null
				? Session.fromPartition(partition)
				: Session.defaultSession;
		const installer = electrobunSession.cookies as {
			set: Parameters<typeof installDesktopSessionCookies>[0]["set"];
		};
		const touched = installDesktopSessionCookies(installer, session, {
			apiOrigin: apiBase,
			rendererOrigin,
		});
		desktopSessionPrimed = true;
		logger.info(
			`[Main] Desktop loopback session primed on ${touched.join(", ") || "<no targets>"}`,
		);
	} catch (err) {
		logger.warn(
			`[Main] Desktop auth cookie install failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
