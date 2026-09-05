/** Defines the complete planner and human authority catalog for Contacts view interactions. */

import type { ViewCapability } from "@elizaos/core";

export const CONTACTS_VIEW_CAPABILITIES = [
  {
    id: "list-contacts",
    description: "List or search contacts from the Android address book.",
    authority: "agent",
    params: {
      query: {
        type: "string",
        description: "Optional name, phone number, or email search text.",
      },
    },
  },
  {
    id: "create-contact",
    description: "Create a contact in the Android address book.",
    authority: "human",
    params: {
      displayName: {
        type: "string",
        description: "Contact display name.",
        required: true,
        minLength: 1,
      },
      phoneNumber: {
        type: "string",
        description: "Optional phone number.",
      },
      emailAddress: {
        type: "string",
        description: "Optional email address.",
      },
    },
  },
  {
    id: "import-vcard",
    description: "Import one or more contacts from vCard text.",
    authority: "human",
    params: {
      vcardText: {
        type: "string",
        description: "Complete vCard document to import.",
        required: true,
        minLength: 1,
      },
    },
  },
  {
    id: "get-state",
    description:
      "Inspect renderer-owned state or elements outside the complete semantic contact read.",
    authority: "human",
  },
  {
    id: "get-text",
    description:
      "Inspect renderer-owned state or elements outside the complete semantic contact read.",
    authority: "human",
  },
  {
    id: "list-elements",
    description:
      "Inspect renderer-owned state or elements outside the complete semantic contact read.",
    authority: "human",
  },
  {
    id: "describe-element",
    description:
      "Inspect renderer-owned state or elements outside the complete semantic contact read.",
    authority: "human",
  },
  {
    id: "get-focus",
    description:
      "Inspect renderer-owned state or elements outside the complete semantic contact read.",
    authority: "human",
  },
  {
    id: "get-agent-state",
    description:
      "Inspect renderer-owned state or elements outside the complete semantic contact read.",
    authority: "human",
  },
] satisfies ViewCapability[];

export type ContactsViewCapabilityId =
  | "list-contacts"
  | "create-contact"
  | "import-vcard";
