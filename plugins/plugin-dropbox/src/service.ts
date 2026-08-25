/**
 * `DropboxService` — the sole runtime service and single entry point for the
 * plugin. Wraps `DropboxClient` and delegates every `IDropboxService` method.
 * Retrieved via `runtime.getService("dropbox")`. Credential resolution defaults
 * to `DefaultDropboxCredentialResolver` but can be swapped (constructor option
 * or `setCredentialResolver`) for tests.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { logger, Service } from "@elizaos/core";
import { DropboxClient, type DropboxClientOptions } from "./client.js";
import { DefaultDropboxCredentialResolver } from "./credential-resolver.js";
import {
  DROPBOX_SERVICE_NAME,
  type DropboxAccountRef,
  type DropboxCredentialResolver,
  type DropboxEntry,
  type DropboxFileText,
  type DropboxListPage,
  type DropboxUploadInput,
  type IDropboxService,
} from "./types.js";

export interface DropboxServiceOptions {
  credentialResolver?: DropboxCredentialResolver;
  clientOptions?: DropboxClientOptions;
}

export class DropboxService extends Service implements IDropboxService {
  static serviceType = DROPBOX_SERVICE_NAME;

  capabilityDescription =
    "Dropbox service for listing, searching, reading, uploading, and deep-linking files";

  private client: DropboxClient;
  private readonly clientOptions: DropboxClientOptions;

  constructor(runtime?: IAgentRuntime, options: DropboxServiceOptions = {}) {
    super(runtime);
    this.clientOptions = options.clientOptions ?? {};
    this.client = new DropboxClient(
      options.credentialResolver ?? new DefaultDropboxCredentialResolver(runtime),
      this.clientOptions
    );
  }

  static async start(runtime: IAgentRuntime): Promise<DropboxService> {
    logger.info("Starting Dropbox plugin");
    return new DropboxService(runtime);
  }

  setCredentialResolver(credentialResolver: DropboxCredentialResolver): void {
    this.client = new DropboxClient(credentialResolver, this.clientOptions);
  }

  async stop(): Promise<void> {
    logger.info("Stopping Dropbox plugin");
  }

  listFolder(
    params: DropboxAccountRef & { path?: string; cursor?: string; limit?: number }
  ): Promise<DropboxListPage> {
    return this.client.listFolder(params);
  }

  search(
    params: DropboxAccountRef & { query: string; cursor?: string; limit?: number }
  ): Promise<DropboxListPage> {
    return this.client.search(params);
  }

  getMetadata(params: DropboxAccountRef & { path: string }): Promise<DropboxEntry> {
    return this.client.getMetadata(params);
  }

  downloadText(params: DropboxAccountRef & { path: string }): Promise<DropboxFileText> {
    return this.client.downloadText(params);
  }

  upload(params: DropboxUploadInput): Promise<DropboxEntry> {
    return this.client.upload(params);
  }

  getTemporaryLink(params: DropboxAccountRef & { path: string }): Promise<string> {
    return this.client.getTemporaryLink(params);
  }
}
