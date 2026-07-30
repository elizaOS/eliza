/**
 * Guarded Instacart Developer Platform boundary for creating shopping-list
 * pages. It sends the current measurement-array wire contract and returns only
 * a link receipt; cart contents, checkout, order, and delivery are deliberately
 * outside this connector's claims.
 */
import {
  assertNonEmptyText,
  assertPositiveQuantity,
  FoodDomainError,
  type FoodShoppingListContent,
  type FoodUnit,
} from "./types.js";

const PRODUCTION_BASE_URL = "https://connect.instacart.com";
const DEVELOPMENT_BASE_URL = "https://connect.dev.instacart.tools";
const PRODUCTS_LINK_PATH = "/idp/v1/products/products_link";

const INSTACART_UNIT: Readonly<Partial<Record<FoodUnit, string>>> = {
  each: "each",
  package: "package",
  can: "can",
  bunch: "bunch",
  head: "head",
  g: "g",
  kg: "kg",
  oz: "oz",
  lb: "lb",
  ml: "ml",
  l: "l",
  cup: "cup",
  tbsp: "tablespoon",
  tsp: "teaspoon",
};

const HEALTH_FILTERS: Readonly<Record<string, string>> = {
  organic: "ORGANIC",
  gluten_free: "GLUTEN_FREE",
  "gluten-free": "GLUTEN_FREE",
  fat_free: "FAT_FREE",
  "fat-free": "FAT_FREE",
  vegan: "VEGAN",
  kosher: "KOSHER",
  sugar_free: "SUGAR_FREE",
  "sugar-free": "SUGAR_FREE",
  low_fat: "LOW_FAT",
  "low-fat": "LOW_FAT",
};

interface InstacartMeasurement {
  quantity: number;
  unit: string;
}

interface InstacartLineItem {
  name: string;
  display_text: string;
  line_item_measurements: InstacartMeasurement[];
  upcs?: string[];
  filters?: {
    brand_filters?: string[];
    health_filters?: string[];
  };
}

export interface InstacartProductsLinkRequest {
  title: string;
  link_type: "shopping_list";
  instructions: string[];
  line_items: InstacartLineItem[];
}

export interface InstacartProductsLinkReceipt {
  kind: "shopping_list_link";
  productsLinkUrl: string;
  httpStatus: number;
  requestId: string | null;
}

export interface InstacartProductsLinkClientOptions {
  apiKey: string;
  environment?: "production" | "development";
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchFn?: typeof fetch;
  /**
   * Wire-contract tests may bind an ephemeral loopback HTTP server. Production
   * callers cannot opt into arbitrary hosts or cleartext transport.
   */
  testBaseUrl?: string;
}

function assertLoopbackTestUrl(value: string): string {
  const url = new URL(value);
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname)) {
    throw new FoodDomainError(
      "testBaseUrl must be a cleartext loopback URL",
      "FOOD_INVALID_CONTRACT",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new FoodDomainError(
      "testBaseUrl must not contain credentials, query parameters, or a fragment",
      "FOOD_INVALID_CONTRACT",
    );
  }
  return url.origin;
}

function healthFilters(tags: readonly string[]): string[] {
  return Array.from(
    new Set(
      tags
        .map((tag) => HEALTH_FILTERS[tag.toLocaleLowerCase("en-US")])
        .filter((value): value is string => typeof value === "string"),
    ),
  ).sort();
}

export function buildInstacartProductsLinkRequest(
  content: FoodShoppingListContent,
): InstacartProductsLinkRequest {
  if (content.lines.length === 0 || content.lines.length > 100) {
    throw new FoodDomainError(
      "Instacart shopping lists must contain between 1 and 100 lines",
      "FOOD_INVALID_CONTRACT",
      { count: content.lines.length },
    );
  }
  const lineItems: InstacartLineItem[] = content.lines.map((line) => {
    const unit = INSTACART_UNIT[line.unit];
    if (!unit) {
      throw new FoodDomainError(
        `Food unit ${line.unit} cannot be represented by the Instacart products-link API`,
        "FOOD_INVALID_CONTRACT",
        { itemId: line.itemId, unit: line.unit },
      );
    }
    const filters = healthFilters(line.dietaryTags);
    return {
      name: assertNonEmptyText(line.name, "line.name", 200),
      display_text: assertNonEmptyText(line.name, "line.name", 200),
      line_item_measurements: [
        {
          quantity: assertPositiveQuantity(line.quantity, "line.quantity"),
          unit,
        },
      ],
      ...(line.upcs.length > 0 ? { upcs: line.upcs } : {}),
      ...(line.brandFilters.length > 0 || filters.length > 0
        ? {
            filters: {
              ...(line.brandFilters.length > 0
                ? { brand_filters: line.brandFilters }
                : {}),
              ...(filters.length > 0 ? { health_filters: filters } : {}),
            },
          }
        : {}),
    };
  });
  return {
    title: assertNonEmptyText(content.title, "content.title", 120),
    link_type: "shopping_list",
    instructions: [
      "Review every matched product label and every substitution against your household constraints before adding items to a cart.",
      "This link is a shopping-list handoff; it does not confirm cart contents, checkout, an order, or delivery.",
    ],
    line_items: lineItems,
  };
}

async function readBoundedUtf8(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) {
    throw new FoodDomainError(
      "Instacart returned an empty response body",
      "FOOD_PROVIDER_RESPONSE_INVALID",
      { httpStatus: response.status },
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let received = 0;
  let text = "";
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    received += part.value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new FoodDomainError(
        "Instacart response exceeded the configured byte limit",
        "FOOD_PROVIDER_RESPONSE_INVALID",
        { httpStatus: response.status, maxBytes },
      );
    }
    try {
      text += decoder.decode(part.value, { stream: true });
    } catch (error) {
      // error-policy:J3 provider bytes are untrusted and invalid UTF-8 is an explicit invalid result.
      throw new FoodDomainError(
        "Instacart returned invalid UTF-8",
        "FOOD_PROVIDER_RESPONSE_INVALID",
        { httpStatus: response.status },
        error,
      );
    }
  }
  try {
    text += decoder.decode();
  } catch (error) {
    // error-policy:J3 a truncated UTF-8 sequence is provider-contract failure, never an empty payload.
    throw new FoodDomainError(
      "Instacart returned truncated UTF-8",
      "FOOD_PROVIDER_RESPONSE_INVALID",
      { httpStatus: response.status },
      error,
    );
  }
  return text;
}

function parseProductsLinkResponse(
  text: string,
  httpStatus: number,
  requestId: string | null,
): InstacartProductsLinkReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // error-policy:J3 provider JSON is untrusted and malformed bytes become a typed invalid response.
    throw new FoodDomainError(
      "Instacart returned malformed JSON",
      "FOOD_PROVIDER_RESPONSE_INVALID",
      { httpStatus, requestId },
      error,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FoodDomainError(
      "Instacart response must be a JSON object",
      "FOOD_PROVIDER_RESPONSE_INVALID",
      { httpStatus, requestId },
    );
  }
  const productsLinkUrl = Reflect.get(parsed, "products_link_url");
  if (typeof productsLinkUrl !== "string") {
    throw new FoodDomainError(
      "Instacart response is missing products_link_url",
      "FOOD_PROVIDER_RESPONSE_INVALID",
      { httpStatus, requestId },
    );
  }
  let url: URL;
  try {
    url = new URL(productsLinkUrl);
  } catch (error) {
    // error-policy:J3 the provider URL is untrusted and cannot degrade to an opaque string.
    throw new FoodDomainError(
      "Instacart returned an invalid products link URL",
      "FOOD_PROVIDER_RESPONSE_INVALID",
      { httpStatus, requestId },
      error,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.hostname !== "instacart.com" &&
      !url.hostname.endsWith(".instacart.com"))
  ) {
    throw new FoodDomainError(
      "Instacart returned a products link outside its HTTPS domain",
      "FOOD_PROVIDER_RESPONSE_INVALID",
      { httpStatus, requestId, hostname: url.hostname },
    );
  }
  return {
    kind: "shopping_list_link",
    productsLinkUrl: url.toString(),
    httpStatus,
    requestId,
  };
}

export class InstacartProductsLinkClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: InstacartProductsLinkClientOptions) {
    this.apiKey = assertNonEmptyText(options.apiKey, "apiKey", 1_000);
    const baseUrl = options.testBaseUrl
      ? assertLoopbackTestUrl(options.testBaseUrl)
      : options.environment === "development"
        ? DEVELOPMENT_BASE_URL
        : PRODUCTION_BASE_URL;
    this.endpoint = new URL(PRODUCTS_LINK_PATH, baseUrl).toString();
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 128 * 1024;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 100 ||
      this.timeoutMs > 60_000
    ) {
      throw new FoodDomainError(
        "Instacart timeout must be between 100 and 60,000 milliseconds",
        "FOOD_INVALID_CONTRACT",
      );
    }
    if (
      !Number.isInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1_024 ||
      this.maxResponseBytes > 1024 * 1024
    ) {
      throw new FoodDomainError(
        "Instacart response limit must be between 1 KiB and 1 MiB",
        "FOOD_INVALID_CONTRACT",
      );
    }
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async createProductsLink(
    content: FoodShoppingListContent,
  ): Promise<InstacartProductsLinkReceipt> {
    const request = buildInstacartProductsLinkRequest(content);
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body, "utf8") > 256 * 1024) {
      throw new FoodDomainError(
        "Instacart request exceeded the 256 KiB client limit",
        "FOOD_INVALID_CONTRACT",
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
        redirect: "error",
      });
    } catch (error) {
      // error-policy:J2 the transport cause is preserved without including the secret header.
      throw new FoodDomainError(
        "Instacart products-link request did not produce an HTTP response",
        "FOOD_PROVIDER_UNAVAILABLE",
        { timedOut: controller.signal.aborted },
        error,
      );
    } finally {
      clearTimeout(timeout);
    }
    const requestId =
      response.headers.get("x-request-id") ??
      response.headers.get("instacart-request-id");
    if (response.status === 429) {
      throw new FoodDomainError(
        "Instacart rate limited the products-link request",
        "FOOD_PROVIDER_RATE_LIMITED",
        { httpStatus: response.status, requestId },
      );
    }
    if (response.status >= 400 && response.status < 500) {
      throw new FoodDomainError(
        "Instacart rejected the products-link request",
        "FOOD_PROVIDER_REJECTED",
        { httpStatus: response.status, requestId },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new FoodDomainError(
        "Instacart products-link service is unavailable",
        "FOOD_PROVIDER_UNAVAILABLE",
        { httpStatus: response.status, requestId },
      );
    }
    const contentType = response.headers.get("content-type");
    if (!contentType?.toLocaleLowerCase("en-US").includes("application/json")) {
      throw new FoodDomainError(
        "Instacart success response did not declare JSON",
        "FOOD_PROVIDER_RESPONSE_INVALID",
        { httpStatus: response.status, requestId, contentType },
      );
    }
    const responseText = await readBoundedUtf8(response, this.maxResponseBytes);
    return parseProductsLinkResponse(responseText, response.status, requestId);
  }
}
