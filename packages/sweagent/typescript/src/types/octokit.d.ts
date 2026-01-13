declare module "@octokit/rest" {
  type JsonPrimitive = string | number | boolean | null;
  type JsonValue =
    | JsonPrimitive
    | JsonValue[]
    | {
        [key: string]: JsonValue | undefined;
      };

  export interface RepoGetResponseData {
    default_branch: string;
    [key: string]: JsonValue | undefined;
  }

  export interface PullCreateResponseData {
    html_url: string;
    [key: string]: JsonValue | undefined;
  }

  export interface IssueGetResponseData {
    state?: string;
    locked?: boolean;
    assignee?: JsonValue;
    assignees?: JsonValue;
    pull_request?: JsonValue;
    title?: string;
    number?: number;
    [key: string]: JsonValue | undefined;
  }

  export class Octokit {
    constructor(options?: { auth?: string });
    rest: {
      repos: {
        get(params: {
          owner: string;
          repo: string;
        }): Promise<{ data: RepoGetResponseData }>;
      };
      pulls: {
        create(params: {
          owner: string;
          repo: string;
          title: string;
          head: string;
          base: string;
          body: string;
          draft?: boolean;
          [key: string]: JsonValue | undefined;
        }): Promise<{ data: PullCreateResponseData }>;
      };
      issues: {
        get(params: {
          owner: string;
          repo: string;
          issue_number: number;
        }): Promise<{ data: IssueGetResponseData }>;
      };
    };
  }
}
