export interface AgentRequestTransport {
  request(
    url: string,
    init: RequestInit,
    context?: {
      timeoutMs?: number;
    },
  ): Promise<Response>;
}
export declare const fetchAgentTransport: AgentRequestTransport;
//# sourceMappingURL=transport.d.ts.map
