const API_VERSION = "2025-04";

/**
 * Lightweight Shopify Admin GraphQL API client.
 * Uses native fetch -- no external dependencies.
 */
export class ShopifyClient {
  private baseUrl: string;
  private accessToken: string;

  constructor(storeDomain: string, accessToken: string) {
    const domain = storeDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
    this.baseUrl = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;
    this.accessToken = accessToken;
  }

  /**
   * Execute a GraphQL query or mutation against the Shopify Admin API.
   * Throws on HTTP errors and on GraphQL-level errors.
   */
  async query<T>(
    graphql: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const resp = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": this.accessToken,
      },
      body: JSON.stringify({ query: graphql, variables }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `Shopify API error: ${resp.status} ${resp.statusText}${body ? ` -- ${body.slice(0, 200)}` : ""}`,
      );
    }

    const json = (await resp.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      throw new Error(
        `Shopify GraphQL error: ${json.errors.map((e) => e.message).join(", ")}`,
      );
    }

    return json.data as T;
  }
}
