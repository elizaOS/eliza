export interface AgentRequestTransport {
  request(
    url: string,
    init: RequestInit,
    context?: { timeoutMs?: number },
  ): Promise<Response>;
}

export const fetchAgentTransport: AgentRequestTransport = {
  request(url, init) {
    return fetch(url, init);
  },
};
