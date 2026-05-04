export interface AgentRequestTransport {
  request(url: string, init: RequestInit): Promise<Response>;
}

export const fetchAgentTransport: AgentRequestTransport = {
  request(url, init) {
    return fetch(url, init);
  },
};
