/**
 * Domain contracts for the Notion provider adapter. Every service method is
 * account-scoped (`NotionAccountRef`), read results carry the canonical Notion
 * deep link (`url`) so downstream surfaces can cite sources, and credential
 * resolution is pluggable via `NotionCredentialResolver` so tests and hosts can
 * substitute their own token source.
 */

export const NOTION_SERVICE_NAME = "notion";

/** All Notion API calls are account-scoped; there is no single-account shortcut. */
export interface NotionAccountRef {
  accountId: string;
}

export interface NotionResolvedCredential {
  accessToken: string;
  /** Workspace the token is bound to, when known (recorded at OAuth time). */
  workspaceId?: string;
  botId?: string;
}

export interface NotionCredentialResolver {
  getCredential(request: NotionAccountRef): Promise<NotionResolvedCredential>;
}

/** Search / list result item: a page or database with its citation deep link. */
export interface NotionObjectSummary {
  id: string;
  object: "page" | "database";
  title: string;
  /** Canonical notion.so deep link for citations. */
  url: string;
  lastEditedTime: string;
  createdTime: string;
  archived: boolean;
  parentType: "workspace" | "page_id" | "database_id" | "block_id" | "unknown";
}

export interface NotionSearchPage {
  results: NotionObjectSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface NotionPageContent {
  id: string;
  title: string;
  url: string;
  /** Flattened plain text of the page's supported block types, one block per line. */
  plainText: string;
  /** Block types present on the page that the adapter cannot render as text. */
  unsupportedBlockTypes: string[];
}

export interface NotionCreatePageInput extends NotionAccountRef {
  parentPageId: string;
  title: string;
  /** Paragraph content; split on newlines into paragraph blocks. */
  content?: string;
}

export interface NotionAppendInput extends NotionAccountRef {
  pageId: string;
  /** Paragraph content; split on newlines into paragraph blocks. */
  content: string;
}

export interface INotionService {
  search(
    params: NotionAccountRef & { query: string; cursor?: string; limit?: number }
  ): Promise<NotionSearchPage>;
  getPage(params: NotionAccountRef & { pageId: string }): Promise<NotionObjectSummary>;
  getPageContent(params: NotionAccountRef & { pageId: string }): Promise<NotionPageContent>;
  createPage(params: NotionCreatePageInput): Promise<NotionObjectSummary>;
  appendToPage(params: NotionAppendInput): Promise<void>;
}
