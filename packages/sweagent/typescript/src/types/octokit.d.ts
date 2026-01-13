declare module '@octokit/rest' {
  export class Octokit {
    constructor(options?: { auth?: string });
    rest: {
      repos: {
        get(params: { owner: string; repo: string }): Promise<{ data: unknown }>;
      };
      pulls: {
        create(params: Record<string, unknown>): Promise<{ data: unknown }>;
      };
      issues: {
        get(params: { owner: string; repo: string; issue_number: number }): Promise<{ data: unknown }>;
      };
    };
  }
}
