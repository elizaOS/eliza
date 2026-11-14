/**
 * Shared agent-ready state for the application menu.
 *
 * Extracted to a separate module to avoid circular dependencies between
 * index.ts and rpc-handlers.ts.
 */

type AgentReadyListener = (ready: boolean) => void;

let _agentReady = false;
const _listeners = new Set<AgentReadyListener>();

export function isAgentReady(): boolean {
	return _agentReady;
}

export function setAgentReady(ready: boolean): void {
	_agentReady = ready;
	for (const listener of _listeners) {
		listener(ready);
	}
}

export function onAgentReadyChange(listener: AgentReadyListener): void {
	_listeners.add(listener);
}

export function offAgentReadyChange(listener: AgentReadyListener): void {
	_listeners.delete(listener);
}

/** Remove all listeners. Intended for test teardown. */
export function clearAgentReadyListeners(): void {
	_listeners.clear();
}
