# @elizaos/capacitor-contacts

Capacitor plugin providing an Android `ContactsContract` bridge for elizaOS agents. Enables reading, creating, and importing contacts on Android from TypeScript/JavaScript code. On web and Node.js the plugin provides a no-op fallback.

## What it does

- **List contacts** — query the device address book with optional text search and result limit.
- **Create a contact** — insert a new contact with a display name, phone numbers, and email addresses.
- **Import vCard** — parse RFC 6350 vCard text and bulk-insert the contacts.

## Platform support

| Platform | `listContacts` | `createContact` | `importVCard` |
|----------|---------------|----------------|---------------|
| Android  | Full          | Full           | Full          |
| Web/Node | Returns `[]`  | Throws         | Throws        |

## Requirements

- `@capacitor/core ^8.3.1` in the host app.
- Android runtime permissions must be granted by the host app:
  - `READ_CONTACTS` — required for `listContacts`.
  - `WRITE_CONTACTS` — required for `createContact` and `importVCard`.

The permissions are declared in the plugin's `AndroidManifest.xml` and are merged automatically by the Android build system.

## Installation

```bash
bun add @elizaos/capacitor-contacts
```

Then sync Capacitor:

```bash
npx cap sync android
```

## Usage

```typescript
import { Contacts } from "@elizaos/capacitor-contacts";

// List contacts (optionally filtered)
const { contacts } = await Contacts.listContacts({ query: "Alice", limit: 50 });

// Create a contact
const { id } = await Contacts.createContact({
  displayName: "Alice Example",
  phoneNumber: "+15555550100",
  emailAddress: "alice@example.com",
});

// Import from vCard text
const { imported } = await Contacts.importVCard({ vcardText: myVCardString });
```

## API

### `listContacts(options?)`

| Option  | Type     | Default | Description |
|---------|----------|---------|-------------|
| `query` | `string` | —       | Case-insensitive search across name, phone, and email. |
| `limit` | `number` | `100`   | Max contacts to return. Must be 1–500. |

Returns `{ contacts: ContactSummary[] }`.

### `createContact(options)`

| Option           | Type       | Required | Description |
|------------------|------------|----------|-------------|
| `displayName`    | `string`   | Yes      | Contact display name. |
| `phoneNumber`    | `string`   | No       | Single phone number (convenience alias). |
| `phoneNumbers`   | `string[]` | No       | Multiple phone numbers. |
| `emailAddress`   | `string`   | No       | Single email address (convenience alias). |
| `emailAddresses` | `string[]` | No       | Multiple email addresses. |

Returns `{ id: string }` (the new contact's `ContactsContract` ID).

### `importVCard(options)`

| Option      | Type     | Required | Description |
|-------------|----------|----------|-------------|
| `vcardText` | `string` | Yes      | Raw vCard text (vCard 2.1 / 3.0 / 4.0). |

Parses `FN`, `N`, `TEL`, and `EMAIL` fields. Photo data is not imported. Returns `{ imported: ImportedContactSummary[] }`.

### `ContactSummary`

```typescript
interface ContactSummary {
  id: string;
  lookupKey: string;
  displayName: string;
  phoneNumbers: string[];
  emailAddresses: string[];
  photoUri?: string;
  starred: boolean;
}
```

## Building

```bash
bun run --cwd plugins/plugin-native-contacts build
```

Runs TypeScript compilation and Rollup to produce `dist/esm/` (ESM) and `dist/plugin.cjs.js` (CJS).

