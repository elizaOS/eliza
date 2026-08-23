import { getAppControlApiBase } from "../loopback-api.js";
import { createViewsRequestHeaders } from "./views-request-auth.js";

export interface WorkspaceDismissalResult {
	ok: boolean;
	closed: boolean;
	text: string;
}

export async function requestWorkspaceDismissal(options: {
	clientId?: string;
	currentViewExists: boolean;
}): Promise<WorkspaceDismissalResult> {
	if (!options.currentViewExists) {
		return {
			ok: true,
			closed: false,
			text: "The Workspace is already closed.",
		};
	}

	try {
		const response = await fetch(
			`${getAppControlApiBase()}/api/views/__workspace__/navigate`,
			{
				method: "POST",
				headers: createViewsRequestHeaders(),
				body: JSON.stringify({
					action: "close",
					alwaysOnTop: false,
					...(options.clientId
						? { delivery: "completed-action", clientId: options.clientId }
						: {}),
				}),
				signal: AbortSignal.timeout(5_000),
			},
		);
		if (response.ok) {
			return { ok: true, closed: true, text: "Closed the Workspace." };
		}
	} catch {
		// The caller owns the user-facing failure below.
	}

	return {
		ok: false,
		closed: false,
		text: "I couldn't close the Workspace because the desktop did not accept the request.",
	};
}
