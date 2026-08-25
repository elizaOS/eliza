/**
 * `NotionService` — the sole runtime service and single entry point for the
 * plugin. Wraps `NotionClient` and delegates every `INotionService` method.
 * Retrieved via `runtime.getService("notion")`. Credential resolution defaults
 * to `DefaultNotionCredentialResolver` but can be swapped (constructor option
 * or `setCredentialResolver`) for tests.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { logger, Service } from "@elizaos/core";
import { NotionClient, type NotionClientOptions } from "./client.js";
import { DefaultNotionCredentialResolver } from "./credential-resolver.js";
import {
  type INotionService,
  NOTION_SERVICE_NAME,
  type NotionAccountRef,
  type NotionAppendInput,
  type NotionCreatePageInput,
  type NotionCredentialResolver,
  type NotionObjectSummary,
  type NotionPageContent,
  type NotionSearchPage,
} from "./types.js";

export interface NotionServiceOptions {
  credentialResolver?: NotionCredentialResolver;
  clientOptions?: NotionClientOptions;
}

export class NotionService extends Service implements INotionService {
  static serviceType = NOTION_SERVICE_NAME;

  capabilityDescription =
    "Notion workspace service for searching, reading, creating, and appending to shared pages";

  private client: NotionClient;
  private readonly clientOptions: NotionClientOptions;

  constructor(runtime?: IAgentRuntime, options: NotionServiceOptions = {}) {
    super(runtime);
    this.clientOptions = options.clientOptions ?? {};
    this.client = new NotionClient(
      options.credentialResolver ?? new DefaultNotionCredentialResolver(runtime),
      this.clientOptions
    );
  }

  static async start(runtime: IAgentRuntime): Promise<NotionService> {
    logger.info("Starting Notion plugin");
    return new NotionService(runtime);
  }

  setCredentialResolver(credentialResolver: NotionCredentialResolver): void {
    this.client = new NotionClient(credentialResolver, this.clientOptions);
  }

  async stop(): Promise<void> {
    logger.info("Stopping Notion plugin");
  }

  search(
    params: NotionAccountRef & { query: string; cursor?: string; limit?: number }
  ): Promise<NotionSearchPage> {
    return this.client.search(params);
  }

  getPage(params: NotionAccountRef & { pageId: string }): Promise<NotionObjectSummary> {
    return this.client.getPage(params);
  }

  getPageContent(params: NotionAccountRef & { pageId: string }): Promise<NotionPageContent> {
    return this.client.getPageContent(params);
  }

  createPage(params: NotionCreatePageInput): Promise<NotionObjectSummary> {
    return this.client.createPage(params);
  }

  appendToPage(params: NotionAppendInput): Promise<void> {
    return this.client.appendToPage(params);
  }
}
