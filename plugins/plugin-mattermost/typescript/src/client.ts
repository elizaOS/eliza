import type {
  MattermostChannel,
  MattermostFileInfo,
  MattermostPost,
  MattermostUser,
} from "./types";

/**
 * Mattermost API client interface.
 */
export interface MattermostClient {
  baseUrl: string;
  apiBaseUrl: string;
  token: string;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
}

/**
 * Error response from Mattermost API.
 */
interface MattermostApiError {
  message?: string;
  id?: string;
  detailed_error?: string;
  request_id?: string;
  status_code?: number;
}

/**
 * Normalize the Mattermost base URL.
 */
export function normalizeMattermostBaseUrl(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutTrailing = trimmed.replace(/\/+$/, "");
  return withoutTrailing.replace(/\/api\/v4$/i, "");
}

/**
 * Build the full API URL for a given path.
 */
function buildMattermostApiUrl(baseUrl: string, path: string): string {
  const normalized = normalizeMattermostBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error("Mattermost baseUrl is required");
  }
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${normalized}/api/v4${suffix}`;
}

/**
 * Read error message from Mattermost API response.
 */
async function readMattermostError(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const data = (await res.json()) as MattermostApiError | undefined;
      if (data?.message) {
        return data.message;
      }
      if (data?.detailed_error) {
        return data.detailed_error;
      }
      return JSON.stringify(data);
    } catch {
      return "Failed to parse error response";
    }
  }
  return await res.text();
}

/**
 * Create a Mattermost API client.
 */
export function createMattermostClient(params: {
  baseUrl: string;
  botToken: string;
  fetchImpl?: typeof fetch;
}): MattermostClient {
  const baseUrl = normalizeMattermostBaseUrl(params.baseUrl);
  if (!baseUrl) {
    throw new Error("Mattermost baseUrl is required");
  }
  const apiBaseUrl = `${baseUrl}/api/v4`;
  const token = params.botToken.trim();
  const fetchImpl = params.fetchImpl ?? fetch;

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const url = buildMattermostApiUrl(baseUrl, path);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (typeof init?.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetchImpl(url, { ...init, headers });
    if (!res.ok) {
      const detail = await readMattermostError(res);
      throw new Error(
        `Mattermost API ${res.status} ${res.statusText}: ${detail || "unknown error"}`
      );
    }
    return (await res.json()) as T;
  };

  return { baseUrl, apiBaseUrl, token, request };
}

/**
 * Fetch the authenticated user's information.
 */
export async function fetchMattermostMe(client: MattermostClient): Promise<MattermostUser> {
  return await client.request<MattermostUser>("/users/me");
}

/**
 * Fetch a user by their ID.
 */
export async function fetchMattermostUser(
  client: MattermostClient,
  userId: string
): Promise<MattermostUser> {
  return await client.request<MattermostUser>(`/users/${userId}`);
}

/**
 * Fetch a user by their username.
 */
export async function fetchMattermostUserByUsername(
  client: MattermostClient,
  username: string
): Promise<MattermostUser> {
  return await client.request<MattermostUser>(`/users/username/${encodeURIComponent(username)}`);
}

/**
 * Fetch multiple users by their IDs.
 */
export async function fetchMattermostUsersByIds(
  client: MattermostClient,
  userIds: string[]
): Promise<MattermostUser[]> {
  return await client.request<MattermostUser[]>("/users/ids", {
    method: "POST",
    body: JSON.stringify(userIds),
  });
}

/**
 * Fetch a channel by its ID.
 */
export async function fetchMattermostChannel(
  client: MattermostClient,
  channelId: string
): Promise<MattermostChannel> {
  return await client.request<MattermostChannel>(`/channels/${channelId}`);
}

/**
 * Fetch channel members.
 */
export async function fetchMattermostChannelMembers(
  client: MattermostClient,
  channelId: string,
  page = 0,
  perPage = 60
): Promise<Array<{ user_id: string; channel_id: string; roles: string }>> {
  return await client.request<Array<{ user_id: string; channel_id: string; roles: string }>>(
    `/channels/${channelId}/members?page=${page}&per_page=${perPage}`
  );
}

/**
 * Send typing indicator to a channel.
 */
export async function sendMattermostTyping(
  client: MattermostClient,
  params: { channelId: string; parentId?: string }
): Promise<void> {
  const payload: Record<string, string> = {
    channel_id: params.channelId,
  };
  const parentId = params.parentId?.trim();
  if (parentId) {
    payload.parent_id = parentId;
  }
  await client.request<Record<string, unknown>>("/users/me/typing", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * Create a direct message channel between users.
 */
export async function createMattermostDirectChannel(
  client: MattermostClient,
  userIds: string[]
): Promise<MattermostChannel> {
  return await client.request<MattermostChannel>("/channels/direct", {
    method: "POST",
    body: JSON.stringify(userIds),
  });
}

/**
 * Create a group message channel between users.
 */
export async function createMattermostGroupChannel(
  client: MattermostClient,
  userIds: string[]
): Promise<MattermostChannel> {
  return await client.request<MattermostChannel>("/channels/group", {
    method: "POST",
    body: JSON.stringify(userIds),
  });
}

/**
 * Create a post (message) in a channel.
 */
export async function createMattermostPost(
  client: MattermostClient,
  params: {
    channelId: string;
    message: string;
    rootId?: string;
    fileIds?: string[];
    props?: Record<string, unknown>;
  }
): Promise<MattermostPost> {
  const payload: Record<string, unknown> = {
    channel_id: params.channelId,
    message: params.message,
  };
  if (params.rootId) {
    payload.root_id = params.rootId;
  }
  if (params.fileIds?.length) {
    payload.file_ids = params.fileIds;
  }
  if (params.props) {
    payload.props = params.props;
  }
  return await client.request<MattermostPost>("/posts", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * Update a post (message).
 */
export async function updateMattermostPost(
  client: MattermostClient,
  postId: string,
  params: {
    message?: string;
    props?: Record<string, unknown>;
  }
): Promise<MattermostPost> {
  return await client.request<MattermostPost>(`/posts/${postId}`, {
    method: "PUT",
    body: JSON.stringify(params),
  });
}

/**
 * Delete a post (message).
 */
export async function deleteMattermostPost(
  client: MattermostClient,
  postId: string
): Promise<void> {
  await client.request<Record<string, unknown>>(`/posts/${postId}`, {
    method: "DELETE",
  });
}

/**
 * Get a post by its ID.
 */
export async function fetchMattermostPost(
  client: MattermostClient,
  postId: string
): Promise<MattermostPost> {
  return await client.request<MattermostPost>(`/posts/${postId}`);
}

/**
 * Get posts in a thread.
 */
export async function fetchMattermostPostThread(
  client: MattermostClient,
  postId: string
): Promise<{
  order: string[];
  posts: Record<string, MattermostPost>;
}> {
  return await client.request<{
    order: string[];
    posts: Record<string, MattermostPost>;
  }>(`/posts/${postId}/thread`);
}

/**
 * Upload a file to Mattermost.
 */
export async function uploadMattermostFile(
  client: MattermostClient,
  params: {
    channelId: string;
    buffer: Buffer | Uint8Array;
    fileName: string;
    contentType?: string;
  }
): Promise<MattermostFileInfo> {
  const form = new FormData();
  const fileName = params.fileName?.trim() || "upload";
  const bytes =
    params.buffer instanceof Uint8Array ? params.buffer : Uint8Array.from(params.buffer);
  const blob = params.contentType
    ? new Blob([bytes as any], { type: params.contentType })
    : new Blob([bytes as any]);
  form.append("files", blob, fileName);
  form.append("channel_id", params.channelId);

  const res = await fetch(`${client.apiBaseUrl}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${client.token}`,
    },
    body: form,
  });

  if (!res.ok) {
    const detail = await readMattermostError(res);
    throw new Error(`Mattermost API ${res.status} ${res.statusText}: ${detail || "unknown error"}`);
  }

  const data = (await res.json()) as { file_infos?: MattermostFileInfo[] };
  const info = data.file_infos?.[0];
  if (!info?.id) {
    throw new Error("Mattermost file upload failed");
  }
  return info;
}

/**
 * Get file info by ID.
 */
export async function fetchMattermostFileInfo(
  client: MattermostClient,
  fileId: string
): Promise<MattermostFileInfo> {
  return await client.request<MattermostFileInfo>(`/files/${fileId}/info`);
}

/**
 * Build the WebSocket URL for Mattermost.
 */
export function buildMattermostWsUrl(baseUrl: string): string {
  const normalized = normalizeMattermostBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error("Mattermost baseUrl is required");
  }
  const wsBase = normalized.replace(/^http/i, "ws");
  return `${wsBase}/api/v4/websocket`;
}
