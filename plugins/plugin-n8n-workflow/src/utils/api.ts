import {
  N8nWorkflow,
  N8nNode,
  N8nWorkflowResponse,
  N8nCredential,
  N8nExecution,
  N8nTag,
  N8nApiError,
} from '../types/index';

/**
 * Strip readOnly and internal fields from a workflow before sending to n8n API.
 * The n8n API uses `additionalProperties: false` — any unknown field causes 400.
 * Required fields: name, nodes, connections, settings.
 */
function toWorkflowPayload(workflow: N8nWorkflow): Record<string, unknown> {
  return {
    name: workflow.name,
    nodes: workflow.nodes.map(toNodePayload),
    connections: workflow.connections,
    settings: workflow.settings ?? {},
  };
}

/**
 * Strip readOnly fields from a node before sending to n8n API.
 * The node schema also uses `additionalProperties: false`.
 */
function toNodePayload(node: N8nNode): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: node.name,
    type: node.type,
    typeVersion: node.typeVersion,
    position: node.position,
    parameters: node.parameters,
  };
  if (node.id) {
    payload.id = node.id;
  }
  if (node.credentials) {
    payload.credentials = node.credentials;
  }
  if (node.disabled !== undefined) {
    payload.disabled = node.disabled;
  }
  if (node.notes) {
    payload.notes = node.notes;
  }
  if (node.notesInFlow !== undefined) {
    payload.notesInFlow = node.notesInFlow;
  }
  if (node.color) {
    payload.color = node.color;
  }
  if (node.continueOnFail !== undefined) {
    payload.continueOnFail = node.continueOnFail;
  }
  if (node.executeOnce !== undefined) {
    payload.executeOnce = node.executeOnce;
  }
  if (node.alwaysOutputData !== undefined) {
    payload.alwaysOutputData = node.alwaysOutputData;
  }
  if (node.retryOnFail !== undefined) {
    payload.retryOnFail = node.retryOnFail;
  }
  if (node.maxTries !== undefined) {
    payload.maxTries = node.maxTries;
  }
  if (node.waitBetweenTries !== undefined) {
    payload.waitBetweenTries = node.waitBetweenTries;
  }
  if (node.onError) {
    payload.onError = node.onError;
  }
  return payload;
}

/**
 * n8n REST API client
 * @see https://docs.n8n.io/api/
 */
export class N8nApiClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(host: string, apiKey: string) {
    this.baseUrl = host.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = apiKey;
  }

  // ============================================================================
  // WORKFLOWS
  // ============================================================================

  /** @see POST /workflows */
  async createWorkflow(workflow: N8nWorkflow): Promise<N8nWorkflowResponse> {
    return this.request<N8nWorkflowResponse>('POST', '/workflows', toWorkflowPayload(workflow));
  }

  /** @see GET /workflows */
  async listWorkflows(params?: {
    active?: boolean;
    tags?: string[];
    limit?: number;
    cursor?: string;
  }): Promise<{ data: N8nWorkflowResponse[]; nextCursor?: string }> {
    const query = new URLSearchParams();
    if (params?.active !== undefined) {
      query.append('active', params.active.toString());
    }
    if (params?.tags) {
      params.tags.forEach((tag) => query.append('tags', tag));
    }
    if (params?.limit) {
      query.append('limit', params.limit.toString());
    }
    if (params?.cursor) {
      query.append('cursor', params.cursor);
    }

    return this.request<{ data: N8nWorkflowResponse[]; nextCursor?: string }>(
      'GET',
      `/workflows${query.toString() ? `?${query.toString()}` : ''}`
    );
  }

  /** @see GET /workflows/{id} */
  async getWorkflow(id: string): Promise<N8nWorkflowResponse> {
    return this.request<N8nWorkflowResponse>('GET', `/workflows/${id}`);
  }

  /** @see PUT /workflows/{id} */
  async updateWorkflow(id: string, workflow: N8nWorkflow): Promise<N8nWorkflowResponse> {
    return this.request<N8nWorkflowResponse>(
      'PUT',
      `/workflows/${id}`,
      toWorkflowPayload(workflow)
    );
  }

  /** @see DELETE /workflows/{id} */
  async deleteWorkflow(id: string): Promise<void> {
    await this.request('DELETE', `/workflows/${id}`);
  }

  /** @see POST /workflows/{id}/activate */
  async activateWorkflow(id: string): Promise<N8nWorkflowResponse> {
    return this.request<N8nWorkflowResponse>('POST', `/workflows/${id}/activate`);
  }

  /** @see POST /workflows/{id}/deactivate */
  async deactivateWorkflow(id: string): Promise<N8nWorkflowResponse> {
    return this.request<N8nWorkflowResponse>('POST', `/workflows/${id}/deactivate`);
  }

  /** @see PUT /workflows/{id}/tags */
  async updateWorkflowTags(id: string, tagIds: string[]): Promise<N8nTag[]> {
    return this.request<N8nTag[]>(
      'PUT',
      `/workflows/${id}/tags`,
      tagIds.map((id) => ({ id }))
    );
  }

  // ============================================================================
  // CREDENTIALS
  // ============================================================================

  /** @see POST /credentials */
  async createCredential(credential: {
    name: string;
    type: string;
    data: Record<string, unknown>;
  }): Promise<N8nCredential> {
    return this.request<N8nCredential>('POST', '/credentials', credential);
  }

  /** @see DELETE /credentials/{id} */
  async deleteCredential(id: string): Promise<void> {
    await this.request('DELETE', `/credentials/${id}`);
  }

  // ============================================================================
  // EXECUTIONS
  // ============================================================================

  /** @see GET /executions */
  async listExecutions(params?: {
    workflowId?: string;
    status?: 'canceled' | 'error' | 'running' | 'success' | 'waiting';
    limit?: number;
    cursor?: string;
  }): Promise<{ data: N8nExecution[]; nextCursor?: string }> {
    const query = new URLSearchParams();
    if (params?.workflowId) {
      query.append('workflowId', params.workflowId);
    }
    if (params?.status) {
      query.append('status', params.status);
    }
    if (params?.limit) {
      query.append('limit', params.limit.toString());
    }
    if (params?.cursor) {
      query.append('cursor', params.cursor);
    }

    return this.request<{ data: N8nExecution[]; nextCursor?: string }>(
      'GET',
      `/executions${query.toString() ? `?${query.toString()}` : ''}`
    );
  }

  /** @see GET /executions/{id} */
  async getExecution(id: string): Promise<N8nExecution> {
    return this.request<N8nExecution>('GET', `/executions/${id}`);
  }

  /** @see DELETE /executions/{id} */
  async deleteExecution(id: string): Promise<void> {
    await this.request('DELETE', `/executions/${id}`);
  }

  // ============================================================================
  // TAGS
  // ============================================================================

  /** @see GET /tags */
  async listTags(): Promise<{ data: N8nTag[] }> {
    return this.request<{ data: N8nTag[] }>('GET', '/tags');
  }

  /** @see POST /tags */
  async createTag(name: string): Promise<N8nTag> {
    return this.request<N8nTag>('POST', '/tags', { name });
  }

  /**
   * Get or create a tag by name (helper method)
   * Used for per-user workflow organization
   */
  async getOrCreateTag(name: string): Promise<N8nTag> {
    const { data: tags } = await this.listTags();
    const existing = tags.find((tag) => tag.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      return existing;
    }
    try {
      return await this.createTag(name);
    } catch (error) {
      // Only retry on 409 "Tag already exists" — pagination may have missed it
      if (error instanceof N8nApiError && error.statusCode === 409) {
        const { data: refreshed } = await this.listTags();
        const found = refreshed.find((tag) => tag.name.toLowerCase() === name.toLowerCase());
        if (found) {
          return found;
        }
      }
      throw error;
    }
  }

  /**
   * Fetch the n8n runtime's actual node-type registry (NOT under /api/v1 —
   * served at /types/nodes.json). Used by Session 21 validateAndRepair to
   * intersect the static plugin catalog with what the user's n8n binary
   * actually ships, so the LLM can't pick a typeVersion that exists in
   * the catalog but not in the running n8n.
   *
   * Returns `null` on any failure — callers should fall back to the
   * static catalog versions.
   */
  async getRuntimeNodeTypeVersions(): Promise<Map<string, number[]> | null> {
    try {
      const response = await fetch(`${this.baseUrl}/types/nodes.json`, {
        headers: { 'X-N8N-API-KEY': this.apiKey },
      });
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as Array<{
        name?: string;
        version?: number | number[];
      }>;
      // n8n's `/types/nodes.json` lists ONE ENTRY PER VERSIONED-NODE CLASS,
      // not one entry per node type. e.g. Gmail appears twice: once with
      // `version: [2, 2.1]` (the modern class) and once with `version: 1`
      // (the legacy class). We must MERGE versions across same-name
      // entries; if we overwrote on each .set() we'd only retain the
      // last entry's versions and clamp to that (a 2.2 → 1 false-floor
      // regression, observed in Session 21 dogfood).
      const acc = new Map<string, Set<number>>();
      for (const entry of data) {
        if (typeof entry?.name !== 'string') {
          continue;
        }
        const versions = Array.isArray(entry.version)
          ? entry.version.filter((v): v is number => typeof v === 'number')
          : typeof entry.version === 'number'
            ? [entry.version]
            : [];
        if (versions.length === 0) {
          continue;
        }
        const set = acc.get(entry.name) ?? new Set<number>();
        for (const v of versions) {
          set.add(v);
        }
        acc.set(entry.name, set);
      }
      if (acc.size === 0) {
        return null;
      }
      const out = new Map<string, number[]>();
      for (const [name, set] of acc) {
        out.set(
          name,
          [...set].sort((a, b) => a - b)
        );
      }
      return out;
    } catch {
      return null;
    }
  }

  // ============================================================================
  // INTERNAL HELPERS
  // ============================================================================

  private async request<T = void>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;

    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-N8N-API-KEY': this.apiKey,
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(url, options);

      if (response.status === 204) {
        return undefined as T;
      }

      if (response.ok) {
        const text = await response.text();
        if (!text) {
          return undefined as T;
        }
        return JSON.parse(text) as T;
      }

      let message = `n8n API error: ${response.statusText}`;
      let errorData: unknown;
      try {
        errorData = await response.json();
        message = (errorData as { message?: string }).message || message;
      } catch {
        // not JSON — use statusText
      }
      throw new N8nApiError(message, response.status, errorData);
    } catch (error) {
      if (error instanceof N8nApiError) {
        throw error;
      }

      throw new N8nApiError(
        `Failed to call n8n API: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error
      );
    }
  }
}
