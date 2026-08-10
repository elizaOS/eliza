/**
 * Product-facing catalog for personal Google Workspace MCP access. Product
 * ids, labels, capabilities, and least-privilege OAuth request scopes derive
 * from the shared Google Workspace MCP contract so this catalog cannot drift
 * from it; only the user-facing product descriptions are UI-owned.
 */

import {
  GOOGLE_WORKSPACE_MCP_CAPABILITY_REQUEST_SCOPES,
  GOOGLE_WORKSPACE_MCP_PRODUCT_LABELS,
  GOOGLE_WORKSPACE_MCP_PRODUCTS,
  type GoogleWorkspaceMcpCapability,
  type GoogleWorkspaceMcpProduct,
  googleMcpProductCapabilities,
} from "@elizaos/shared/contracts";

export interface PersonalGoogleMcpProductOption {
  id: GoogleWorkspaceMcpProduct;
  label: string;
  description: string;
  capabilities: readonly GoogleWorkspaceMcpCapability[];
  oauthScopes: readonly string[];
}

const IDENTITY_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
] as const;

const PRODUCT_DESCRIPTIONS: Record<GoogleWorkspaceMcpProduct, string> = {
  gmail:
    "Read and organize mail, and create drafts. Email sending is not available.",
  calendar:
    "Read calendar events. Writes stay unavailable until Google MCP exposes atomic version checks.",
  drive: "Search and read files, and create or copy files.",
  docs: "Read and update Google Docs.",
  sheets: "Read and update Google Sheets.",
  slides: "Read and update Google Slides presentations.",
  chat: "Read personal Chat conversations and send Chat messages.",
  people: "Search contacts and directory profiles.",
  universalSearch: "Search across the connected Workspace products.",
};

export const PERSONAL_GOOGLE_MCP_PRODUCTS: readonly PersonalGoogleMcpProductOption[] =
  GOOGLE_WORKSPACE_MCP_PRODUCTS.map((id) => {
    const capabilities = googleMcpProductCapabilities(id);
    return {
      id,
      label: GOOGLE_WORKSPACE_MCP_PRODUCT_LABELS[id],
      description: PRODUCT_DESCRIPTIONS[id],
      capabilities,
      oauthScopes: [
        ...new Set(
          capabilities.flatMap(
            (capability) =>
              GOOGLE_WORKSPACE_MCP_CAPABILITY_REQUEST_SCOPES[capability],
          ),
        ),
      ],
    };
  });

export const DEFAULT_PERSONAL_GOOGLE_MCP_PRODUCTS: readonly GoogleWorkspaceMcpProduct[] =
  ["gmail", "calendar"];

const PRODUCT_BY_ID = new Map(
  PERSONAL_GOOGLE_MCP_PRODUCTS.map((product) => [product.id, product]),
);

function selectedOptions(
  products: readonly GoogleWorkspaceMcpProduct[],
): PersonalGoogleMcpProductOption[] {
  return products.flatMap((product) => {
    const option = PRODUCT_BY_ID.get(product);
    return option ? [option] : [];
  });
}

export function capabilitiesForPersonalGoogleProducts(
  products: readonly GoogleWorkspaceMcpProduct[],
): GoogleWorkspaceMcpCapability[] {
  return [
    ...new Set(
      selectedOptions(products).flatMap((product) => product.capabilities),
    ),
  ];
}

export function oauthScopesForPersonalGoogleProducts(
  products: readonly GoogleWorkspaceMcpProduct[],
): string[] {
  return [
    ...new Set([
      ...IDENTITY_SCOPES,
      ...selectedOptions(products).flatMap((product) => product.oauthScopes),
    ]),
  ];
}
