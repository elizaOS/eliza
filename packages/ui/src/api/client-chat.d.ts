/**
 * Chat domain methods — chat, conversations, documents, memory, MCP,
 * share ingest, workbench, trajectories, database.
 */
import type { DatabaseProviderType } from "@elizaos/shared";
import type {
  ChatFailureKind,
  ChatTokenUsage,
  ConnectionTestResult,
  ContentBlock,
  Conversation,
  ConversationChannelType,
  ConversationGreeting,
  ConversationMessage,
  ConversationMetadata,
  CreateConversationOptions,
  DatabaseConfigResponse,
  DatabaseStatus,
  DocumentBulkUploadResult,
  DocumentDetail,
  DocumentFragmentsResponse,
  DocumentScope,
  DocumentSearchResponse,
  DocumentStats,
  DocumentsResponse,
  DocumentUpdateResult,
  DocumentUploadResult,
  ImageAttachment,
  LocalInferenceChatMetadata,
  McpMarketplaceResult,
  McpRegistryServerDetail,
  McpServerConfig,
  McpServerStatus,
  MemoryBrowseQuery,
  MemoryBrowseResponse,
  MemoryFeedQuery,
  MemoryFeedResponse,
  MemoryRememberResponse,
  MemorySearchResponse,
  MemoryStatsResponse,
  PostWorkbenchVfsPromoteToCloudRequest,
  PromoteVfsToCloudContainerRequest,
  PromoteVfsToCloudContainerResponse,
  QueryResult,
  QuickContextResponse,
  RequestCodingAgentContainerRequest,
  RequestCodingAgentContainerResponse,
  ShareIngestItem,
  ShareIngestPayload,
  SyncCloudCodingContainerRequest,
  SyncCloudCodingContainerResponse,
  TableInfo,
  TableRowsResponse,
  TrajectoryConfig,
  TrajectoryDetailResult,
  TrajectoryExportOptions,
  TrajectoryListOptions,
  TrajectoryListResult,
  TrajectoryStats,
  WorkbenchLoadedVfsPlugin,
  WorkbenchOverview,
  WorkbenchTask,
  WorkbenchTodo,
  WorkbenchVfsCompileResult,
  WorkbenchVfsDiffEntry,
  WorkbenchVfsEntry,
  WorkbenchVfsProject,
  WorkbenchVfsQuota,
  WorkbenchVfsSnapshot,
} from "./client-types";

type DocumentListOptions = {
  limit?: number;
  offset?: number;
  scope?: DocumentScope;
  scopedToEntityId?: string;
  addedBy?: string;
  query?: string;
  timeRangeStart?: string;
  timeRangeEnd?: string;
  tags?: string[];
};
type DocumentUploadRequest = {
  content: string;
  filename: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
  entityId?: string;
  scope?: DocumentScope;
  scopedToEntityId?: string;
};
type DocumentUrlUploadOptions = {
  includeImageDescriptions?: boolean;
  metadata?: Record<string, unknown>;
  entityId?: string;
  scope?: DocumentScope;
  scopedToEntityId?: string;
};
type DocumentSearchOptions = {
  threshold?: number;
  limit?: number;
  scope?: DocumentScope;
  scopedToEntityId?: string;
  addedBy?: string;
  query?: string;
  timeRangeStart?: string;
  timeRangeEnd?: string;
  tags?: string[];
};
declare module "./client-base" {
  interface ElizaClient {
    sendChatRest(
      text: string,
      channelType?: ConversationChannelType,
    ): Promise<{
      text: string;
      agentName: string;
      noResponseReason?: "ignored";
      failureKind?: ChatFailureKind;
      localInference?: LocalInferenceChatMetadata;
    }>;
    sendChatStream(
      text: string,
      onToken: (token: string, accumulatedText?: string) => void,
      channelType?: ConversationChannelType,
      signal?: AbortSignal,
    ): Promise<{
      text: string;
      agentName: string;
      completed: boolean;
      noResponseReason?: "ignored";
      usage?: ChatTokenUsage;
      failureKind?: ChatFailureKind;
      localInference?: LocalInferenceChatMetadata;
    }>;
    listConversations(): Promise<{
      conversations: Conversation[];
    }>;
    createConversation(
      title?: string,
      options?: CreateConversationOptions,
    ): Promise<{
      conversation: Conversation;
      greeting?: ConversationGreeting;
    }>;
    getConversationMessages(id: string): Promise<{
      messages: ConversationMessage[];
    }>;
    /**
     * Fetch the cross-channel inbox. Returns the most recent
     * messages across every connector room the agent participates in,
     * time-ordered newest first. Each message carries its `source`
     * tag (imessage / telegram / discord / etc.) so the UI can render
     * per-source styling without a second lookup.
     *
     * When `roomId` is provided the server scopes the query to that
     * single connector room — use this when the messages view
     * has a specific chat selected. When `roomId` is omitted the feed
     * merges every room's recent messages.
     */
    getInboxMessages(options?: {
      limit?: number;
      sources?: string[];
      roomId?: string;
      roomSource?: string;
    }): Promise<{
      messages: Array<
        ConversationMessage & {
          roomId: string;
          source: string;
        }
      >;
      count: number;
    }>;
    /**
     * List the distinct connector source tags the agent currently has
     * inbox messages for. Used by the inbox UI to build the
     * source filter chip list dynamically.
     */
    getInboxSources(): Promise<{
      sources: string[];
    }>;
    /**
     * List every connector chat thread the agent participates in as
     * one sidebar-friendly row per external chat room. Each row carries
     * the room id (for selection), source tag, display title,
     * last-message preview, last-message timestamp, and a total message
     * count. Used by the messages sidebar to render connector
     * chats alongside dashboard conversations.
     */
    getInboxChats(options?: { sources?: string[] }): Promise<{
      chats: Array<{
        canSend?: boolean;
        id: string;
        source: string;
        transportSource?: string;
        /** Owning server/world id when the connector exposes one. */
        worldId?: string;
        /** User-facing server/world label for selectors and section headers. */
        worldLabel: string;
        /**
         * Normalized room kind — "DM" for 1:1 direct messages. Optional
         * because not every connector tags rooms.
         */
        roomType?: string;
        title: string;
        avatarUrl?: string;
        lastMessageText: string;
        lastMessageAt: number;
        messageCount: number;
      }>;
      count: number;
    }>;
    sendInboxMessage(data: {
      accountId?: string;
      channel?: string;
      metadata?: Record<string, unknown>;
      roomId: string;
      source: string;
      text: string;
      replyToMessageId?: string;
    }): Promise<{
      ok: boolean;
      message?: ConversationMessage & {
        roomId: string;
        source: string;
      };
    }>;
    truncateConversationMessages(
      id: string,
      messageId: string,
      options?: {
        inclusive?: boolean;
      },
    ): Promise<{
      ok: boolean;
      deletedCount: number;
    }>;
    sendConversationMessage(
      id: string,
      text: string,
      channelType?: ConversationChannelType,
      images?: ImageAttachment[],
      metadata?: Record<string, unknown>,
    ): Promise<{
      text: string;
      agentName: string;
      blocks?: ContentBlock[];
      noResponseReason?: "ignored";
      /**
       * Set when chat generation threw and the server returned a
       * fallback message in `text`. Renderer keys off
       * `failureKind === "no_provider"` to gate the chat input on a
       * "Connect a provider" CTA instead of treating the fallback
       * as a normal assistant reply.
       */
      failureKind?: ChatFailureKind;
      localInference?: LocalInferenceChatMetadata;
    }>;
    sendConversationMessageStream(
      id: string,
      text: string,
      onToken: (token: string, accumulatedText?: string) => void,
      channelType?: ConversationChannelType,
      signal?: AbortSignal,
      images?: ImageAttachment[],
      metadata?: Record<string, unknown>,
    ): Promise<{
      text: string;
      agentName: string;
      completed: boolean;
      noResponseReason?: "ignored";
      usage?: ChatTokenUsage;
      /** See sendConversationMessage above. */
      failureKind?: ChatFailureKind;
      localInference?: LocalInferenceChatMetadata;
    }>;
    abortConversationTurn(
      roomId: string,
      reason?: string,
    ): Promise<{
      aborted: boolean;
      roomId: string;
      reason: string;
    }>;
    requestGreeting(
      id: string,
      lang?: string,
    ): Promise<{
      text: string;
      agentName: string;
      generated: boolean;
      persisted?: boolean;
      localInference?: LocalInferenceChatMetadata;
    }>;
    renameConversation(
      id: string,
      title: string,
      options?: {
        generate?: boolean;
      },
    ): Promise<{
      conversation: Conversation;
    }>;
    updateConversation(
      id: string,
      data: {
        title?: string;
        generate?: boolean;
        metadata?: ConversationMetadata | null;
      },
    ): Promise<{
      conversation: Conversation;
    }>;
    deleteConversation(id: string): Promise<{
      ok: boolean;
    }>;
    cleanupEmptyConversations(options?: { keepId?: string }): Promise<{
      deleted: string[];
    }>;
    getDocumentStats(): Promise<DocumentStats>;
    listDocuments(options?: DocumentListOptions): Promise<DocumentsResponse>;
    getDocument(documentId: string): Promise<{
      document: DocumentDetail;
    }>;
    updateDocument(
      documentId: string,
      data: {
        content: string;
      },
    ): Promise<DocumentUpdateResult>;
    deleteDocument(documentId: string): Promise<{
      ok: boolean;
      deletedFragments: number;
    }>;
    uploadDocument(data: DocumentUploadRequest): Promise<DocumentUploadResult>;
    uploadDocumentsBulk(data: {
      documents: DocumentUploadRequest[];
    }): Promise<DocumentBulkUploadResult>;
    uploadDocumentFromUrl(
      url: string,
      options?: DocumentUrlUploadOptions,
    ): Promise<DocumentUploadResult>;
    searchDocuments(
      query: string,
      options?: DocumentSearchOptions,
    ): Promise<DocumentSearchResponse>;
    getDocumentFragments(
      documentId: string,
    ): Promise<DocumentFragmentsResponse>;
    rememberMemory(text: string): Promise<MemoryRememberResponse>;
    searchMemory(
      query: string,
      options?: {
        limit?: number;
      },
    ): Promise<MemorySearchResponse>;
    quickContext(
      query: string,
      options?: {
        limit?: number;
      },
    ): Promise<QuickContextResponse>;
    getMemoryFeed(query?: MemoryFeedQuery): Promise<MemoryFeedResponse>;
    browseMemories(query?: MemoryBrowseQuery): Promise<MemoryBrowseResponse>;
    getMemoriesByEntity(
      entityId: string,
      query?: MemoryBrowseQuery,
    ): Promise<MemoryBrowseResponse>;
    getMemoryStats(): Promise<MemoryStatsResponse>;
    getMcpConfig(): Promise<{
      servers: Record<string, McpServerConfig>;
    }>;
    getMcpStatus(): Promise<{
      servers: McpServerStatus[];
    }>;
    searchMcpMarketplace(
      query: string,
      limit: number,
    ): Promise<{
      results: McpMarketplaceResult[];
    }>;
    getMcpServerDetails(name: string): Promise<{
      server: McpRegistryServerDetail;
    }>;
    addMcpServer(name: string, config: McpServerConfig): Promise<void>;
    removeMcpServer(name: string): Promise<void>;
    ingestShare(payload: ShareIngestPayload): Promise<{
      item: ShareIngestItem;
    }>;
    consumeShareIngest(): Promise<{
      items: ShareIngestItem[];
    }>;
    getWorkbenchOverview(): Promise<
      WorkbenchOverview & {
        tasksAvailable?: boolean;
        triggersAvailable?: boolean;
        todosAvailable?: boolean;
      }
    >;
    listWorkbenchTasks(): Promise<{
      tasks: WorkbenchTask[];
    }>;
    getWorkbenchTask(taskId: string): Promise<{
      task: WorkbenchTask;
    }>;
    createWorkbenchTask(data: {
      name: string;
      description?: string;
      tags?: string[];
      isCompleted?: boolean;
    }): Promise<{
      task: WorkbenchTask;
    }>;
    updateWorkbenchTask(
      taskId: string,
      data: {
        name?: string;
        description?: string;
        tags?: string[];
        isCompleted?: boolean;
      },
    ): Promise<{
      task: WorkbenchTask;
    }>;
    deleteWorkbenchTask(taskId: string): Promise<{
      ok: boolean;
    }>;
    listWorkbenchTodos(): Promise<{
      todos: WorkbenchTodo[];
    }>;
    getWorkbenchTodo(todoId: string): Promise<{
      todo: WorkbenchTodo;
    }>;
    createWorkbenchTodo(data: {
      name: string;
      description?: string;
      priority?: number;
      isUrgent?: boolean;
      type?: string;
      isCompleted?: boolean;
    }): Promise<{
      todo: WorkbenchTodo;
    }>;
    updateWorkbenchTodo(
      todoId: string,
      data: {
        name?: string;
        description?: string;
        priority?: number;
        isUrgent?: boolean;
        type?: string;
        isCompleted?: boolean;
      },
    ): Promise<{
      todo: WorkbenchTodo;
    }>;
    setWorkbenchTodoCompleted(
      todoId: string,
      isCompleted: boolean,
    ): Promise<void>;
    deleteWorkbenchTodo(todoId: string): Promise<{
      ok: boolean;
    }>;
    createWorkbenchVfsProject(projectId: string): Promise<{
      project: WorkbenchVfsProject;
      quota: WorkbenchVfsQuota;
    }>;
    getWorkbenchVfsQuota(projectId: string): Promise<{
      quota: WorkbenchVfsQuota;
    }>;
    listWorkbenchVfsFiles(
      projectId: string,
      options?: {
        path?: string;
        recursive?: boolean;
      },
    ): Promise<{
      files: WorkbenchVfsEntry[];
    }>;
    readWorkbenchVfsFile(
      projectId: string,
      path: string,
      options?: {
        encoding?: "utf-8" | "base64";
      },
    ): Promise<{
      path: string;
      encoding: "utf-8" | "base64";
      content: string;
    }>;
    writeWorkbenchVfsFile(
      projectId: string,
      data: {
        path: string;
        content: string;
        encoding?: "utf-8" | "base64";
      },
    ): Promise<{
      file: WorkbenchVfsEntry;
    }>;
    deleteWorkbenchVfsFile(
      projectId: string,
      path: string,
    ): Promise<{
      ok: boolean;
    }>;
    listWorkbenchVfsSnapshots(projectId: string): Promise<{
      snapshots: WorkbenchVfsSnapshot[];
    }>;
    createWorkbenchVfsSnapshot(
      projectId: string,
      data?: {
        note?: string;
      },
    ): Promise<{
      snapshot: WorkbenchVfsSnapshot;
    }>;
    getWorkbenchVfsDiff(
      projectId: string,
      snapshotId: string,
    ): Promise<{
      diff: WorkbenchVfsDiffEntry[];
    }>;
    rollbackWorkbenchVfs(
      projectId: string,
      snapshotId: string,
    ): Promise<{
      rollback: unknown;
    }>;
    compileWorkbenchVfsPlugin(
      projectId: string,
      data: {
        entry: string;
        outFile?: string;
        format?: "esm" | "cjs";
        target?: string;
      },
    ): Promise<{
      compile: WorkbenchVfsCompileResult;
    }>;
    loadWorkbenchVfsPlugin(
      projectId: string,
      data: {
        entry: string;
        outFile?: string;
        compileFirst?: boolean;
      },
    ): Promise<{
      pluginName: string;
      unloaded: false;
    }>;
    listWorkbenchVfsPlugins(): Promise<{
      plugins: WorkbenchLoadedVfsPlugin[];
    }>;
    unloadWorkbenchVfsPlugin(
      projectId: string,
      pluginName: string,
    ): Promise<{
      pluginName: string;
      unloaded: boolean;
    }>;
    promoteWorkbenchVfsToCloud(
      projectId: string,
      data?: PostWorkbenchVfsPromoteToCloudRequest,
    ): Promise<PromoteVfsToCloudContainerResponse>;
    promoteVfsToCloudContainer(
      data: PromoteVfsToCloudContainerRequest,
    ): Promise<PromoteVfsToCloudContainerResponse>;
    requestCloudCodingContainer(
      data: RequestCodingAgentContainerRequest,
    ): Promise<RequestCodingAgentContainerResponse>;
    syncCloudCodingContainerChanges(
      containerId: string,
      data: SyncCloudCodingContainerRequest,
    ): Promise<SyncCloudCodingContainerResponse>;
    refreshRegistry(): Promise<void>;
    getTrajectories(
      options?: TrajectoryListOptions,
    ): Promise<TrajectoryListResult>;
    getTrajectoryDetail(trajectoryId: string): Promise<TrajectoryDetailResult>;
    getTrajectoryStats(): Promise<TrajectoryStats>;
    getTrajectoryConfig(): Promise<TrajectoryConfig>;
    updateTrajectoryConfig(
      config: Partial<TrajectoryConfig>,
    ): Promise<TrajectoryConfig>;
    exportTrajectories(options: TrajectoryExportOptions): Promise<Blob>;
    deleteTrajectories(trajectoryIds: string[]): Promise<{
      deleted: number;
    }>;
    clearAllTrajectories(): Promise<{
      deleted: number;
    }>;
    getDatabaseStatus(): Promise<DatabaseStatus>;
    getDatabaseConfig(): Promise<DatabaseConfigResponse>;
    saveDatabaseConfig(config: {
      provider?: DatabaseProviderType;
      pglite?: {
        dataDir?: string;
      };
      postgres?: {
        connectionString?: string;
        host?: string;
        port?: number;
        database?: string;
        user?: string;
        password?: string;
        ssl?: boolean;
      };
    }): Promise<{
      saved: boolean;
      needsRestart: boolean;
    }>;
    testDatabaseConnection(creds: {
      connectionString?: string;
      host?: string;
      port?: number;
      database?: string;
      user?: string;
      password?: string;
      ssl?: boolean;
    }): Promise<ConnectionTestResult>;
    getDatabaseTables(): Promise<{
      tables: TableInfo[];
    }>;
    getDatabaseRows(
      table: string,
      opts?: {
        offset?: number;
        limit?: number;
        sort?: string;
        order?: "asc" | "desc";
        search?: string;
      },
    ): Promise<TableRowsResponse>;
    insertDatabaseRow(
      table: string,
      data: Record<string, unknown>,
    ): Promise<{
      inserted: boolean;
      row: Record<string, unknown> | null;
    }>;
    updateDatabaseRow(
      table: string,
      where: Record<string, unknown>,
      data: Record<string, unknown>,
    ): Promise<{
      updated: boolean;
      row: Record<string, unknown>;
    }>;
    deleteDatabaseRow(
      table: string,
      where: Record<string, unknown>,
    ): Promise<{
      deleted: boolean;
      row: Record<string, unknown>;
    }>;
    executeDatabaseQuery(sql: string, readOnly?: boolean): Promise<QueryResult>;
  }
}
//# sourceMappingURL=client-chat.d.ts.map
