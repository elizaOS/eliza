/**
 * Product-facing catalog for personal Google Workspace MCP access. It maps a
 * user's product selection to the capability IDs used by the local connector
 * and the least-privilege OAuth scopes used by the Cloud connection flow.
 */

import type {
  GoogleWorkspaceMcpCapability,
  GoogleWorkspaceMcpProduct,
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

export const PERSONAL_GOOGLE_MCP_PRODUCTS: readonly PersonalGoogleMcpProductOption[] =
  [
    {
      id: "gmail",
      label: "Gmail",
      description:
        "Read and organize mail, and create drafts. Email sending is not available.",
      capabilities: ["gmail.read", "gmail.draft", "gmail.manage"],
      oauthScopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/gmail.modify",
      ],
    },
    {
      id: "calendar",
      label: "Calendar",
      description:
        "Read calendar events. Writes stay unavailable until Google MCP exposes atomic version checks.",
      capabilities: ["calendar.read"],
      oauthScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    },
    {
      id: "drive",
      label: "Drive",
      description: "Search and read files, and create or copy files.",
      capabilities: ["drive.read", "drive.write"],
      oauthScopes: [
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/drive.file",
      ],
    },
    {
      id: "docs",
      label: "Docs",
      description: "Read and update Google Docs.",
      capabilities: ["docs.read", "docs.write"],
      oauthScopes: [
        "https://www.googleapis.com/auth/documents.readonly",
        "https://www.googleapis.com/auth/documents",
      ],
    },
    {
      id: "sheets",
      label: "Sheets",
      description: "Read and update Google Sheets.",
      capabilities: ["sheets.read", "sheets.write"],
      oauthScopes: [
        "https://www.googleapis.com/auth/spreadsheets.readonly",
        "https://www.googleapis.com/auth/spreadsheets",
      ],
    },
    {
      id: "slides",
      label: "Slides",
      description: "Read and update Google Slides presentations.",
      capabilities: ["slides.read", "slides.write"],
      oauthScopes: [
        "https://www.googleapis.com/auth/presentations.readonly",
        "https://www.googleapis.com/auth/presentations",
      ],
    },
    {
      id: "chat",
      label: "Google Chat",
      description: "Read personal Chat conversations and send Chat messages.",
      capabilities: ["chat.read", "chat.send"],
      oauthScopes: [
        "https://www.googleapis.com/auth/chat.messages.readonly",
        "https://www.googleapis.com/auth/chat.messages.create",
        "https://www.googleapis.com/auth/chat.spaces.readonly",
        "https://www.googleapis.com/auth/chat.memberships.readonly",
        "https://www.googleapis.com/auth/chat.users.readstate.readonly",
      ],
    },
    {
      id: "people",
      label: "People",
      description: "Search contacts and directory profiles.",
      capabilities: ["people.read"],
      oauthScopes: [
        "https://www.googleapis.com/auth/contacts.readonly",
        "https://www.googleapis.com/auth/directory.readonly",
        "https://www.googleapis.com/auth/userinfo.profile",
      ],
    },
    {
      id: "universalSearch",
      label: "Workspace search",
      description: "Search across the connected Workspace products.",
      capabilities: ["workspace.search"],
      oauthScopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/chat.messages.readonly",
      ],
    },
  ] as const;

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
