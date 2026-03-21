// Stub for @elizaos/plugin-coding-agent used in e2e tests.
// The real module is optional and not available in all environments.
export function createCodingAgentRouteHandler() {
  return async () => undefined;
}

export function getCoordinator() {
  return undefined;
}

export interface SwarmEvent {
  type: string;
  [key: string]: unknown;
}

export interface PTYService {
  coordinator: null;
}
