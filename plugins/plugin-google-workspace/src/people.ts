/**
 * `GooglePeopleClient` — Google Contacts discovery behind the workspace
 * service, covering saved contacts and interaction-derived "Other Contacts"
 * through the People API. Listing is page-based (the caller replays the opaque
 * `nextPageToken`, mirroring the Drive contract) and search fans out to both
 * contact sources. Search issues the warmup request the People API documents
 * for `searchContacts`/`otherContacts.search` (an empty-query call primes the
 * server-side cache) before the real query. Callers that require a freshly
 * mutated contact must still honor Google's documented cache propagation delay.
 * A person record without a `resourceName` is malformed upstream data and
 * throws instead of fabricating a healthy-looking contact.
 */
import { ElizaError } from "@elizaos/core";
import type { people_v1 } from "googleapis";
import type { GoogleApiClientFactory } from "./client-factory.js";
import type {
  GooglePeopleContactPage,
  GooglePeopleGetContactInput,
  GooglePeopleListContactsInput,
  GooglePeopleSearchContactsInput,
  GooglePersonContact,
} from "./types.js";

const CONTACT_PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations,photos";
/** Other Contacts only support a restricted read mask. */
const OTHER_CONTACT_READ_MASK = "names,emailAddresses,phoneNumbers";
/** People API caps searchContacts/otherContacts.search page sizes at 30. */
const MAX_SEARCH_PAGE_SIZE = 30;

export class GooglePeopleClient {
  constructor(private readonly clientFactory: GoogleApiClientFactory) {}

  async listContacts(params: GooglePeopleListContactsInput): Promise<GooglePeopleContactPage> {
    const people = await this.clientFactory.people(params, ["people.read"], "people.listContacts");
    const response = await people.people.connections.list({
      resourceName: "people/me",
      pageSize: normalizedPageSize(params.maxResults, 100),
      pageToken: params.pageToken,
      personFields: CONTACT_PERSON_FIELDS,
      sortOrder: "LAST_MODIFIED_DESCENDING",
    });
    return {
      contacts: (response.data.connections ?? []).map((person) =>
        mapPerson(person, "contact", "people.listContacts")
      ),
      nextPageToken: response.data.nextPageToken ?? null,
    };
  }

  async searchContacts(params: GooglePeopleSearchContactsInput): Promise<GooglePersonContact[]> {
    const query = params.query.trim();
    if (query.length === 0) {
      throw new ElizaError("Google People search requires a non-empty query.", {
        code: "GOOGLE_PEOPLE_SEARCH_QUERY_EMPTY",
        context: { accountId: params.accountId },
      });
    }
    const people = await this.clientFactory.people(
      params,
      ["people.read"],
      "people.searchContacts"
    );
    const pageSize = normalizedPageSize(params.maxResults, MAX_SEARCH_PAGE_SIZE);

    // The People API documents an empty-query warmup request before search so
    // the server-side search cache includes recent mutations.
    await people.people.searchContacts({ query: "", readMask: CONTACT_PERSON_FIELDS });
    const contactResponse = await people.people.searchContacts({
      query,
      pageSize,
      readMask: CONTACT_PERSON_FIELDS,
    });

    const results = mapSearchResults(contactResponse.data.results, "contact");

    if (params.includeOtherContacts !== false) {
      await people.otherContacts.search({ query: "", readMask: OTHER_CONTACT_READ_MASK });
      const otherResponse = await people.otherContacts.search({
        query,
        pageSize,
        readMask: OTHER_CONTACT_READ_MASK,
      });
      results.push(...mapSearchResults(otherResponse.data.results, "otherContact"));
    }

    return results.slice(0, pageSize);
  }

  async getContact(params: GooglePeopleGetContactInput): Promise<GooglePersonContact> {
    if (!/^people\/[^/\s]+$/.test(params.resourceName)) {
      throw new ElizaError(
        "Google People getContact requires a canonical people/{personId} resource name.",
        {
          code: "GOOGLE_PEOPLE_RESOURCE_NAME_INVALID",
          context: { accountId: params.accountId },
        }
      );
    }
    const people = await this.clientFactory.people(params, ["people.read"], "people.getContact");
    const response = await people.people.get({
      resourceName: params.resourceName,
      personFields: CONTACT_PERSON_FIELDS,
    });
    return mapPerson(response.data, "contact", "people.getContact");
  }
}

function mapSearchResults(
  results: people_v1.Schema$SearchResult[] | undefined,
  source: GooglePersonContact["source"]
): GooglePersonContact[] {
  const contacts: GooglePersonContact[] = [];
  for (const result of results ?? []) {
    if (!result.person) {
      continue;
    }
    contacts.push(mapPerson(result.person, source, "people.searchContacts"));
  }
  return contacts;
}

function mapPerson(
  person: people_v1.Schema$Person,
  source: GooglePersonContact["source"],
  operation: string
): GooglePersonContact {
  const resourceName = person.resourceName;
  if (typeof resourceName !== "string" || resourceName.length === 0) {
    throw new ElizaError("Google People returned a person record without a resourceName.", {
      code: "GOOGLE_PEOPLE_MALFORMED_PERSON",
      context: { operation, source },
    });
  }

  const primaryName =
    person.names?.find((name) => name.metadata?.primary === true) ?? person.names?.[0];
  const primaryEmail = person.emailAddresses?.find((email) => Boolean(email.value));

  return {
    resourceName,
    displayName: primaryName?.displayName ?? primaryEmail?.value ?? "",
    givenName: primaryName?.givenName ?? undefined,
    familyName: primaryName?.familyName ?? undefined,
    emailAddresses: (person.emailAddresses ?? [])
      .filter((email): email is people_v1.Schema$EmailAddress & { value: string } =>
        Boolean(email.value)
      )
      .map((email) => ({
        value: email.value,
        type: email.type ?? undefined,
        primary: email.metadata?.primary ?? undefined,
      })),
    phoneNumbers: (person.phoneNumbers ?? [])
      .filter((phone): phone is people_v1.Schema$PhoneNumber & { value: string } =>
        Boolean(phone.value)
      )
      .map((phone) => ({
        value: phone.value,
        type: phone.type ?? undefined,
        primary: phone.metadata?.primary ?? undefined,
      })),
    organizations: (person.organizations ?? [])
      .filter((org) => Boolean(org.name || org.title))
      .map((org) => ({
        name: org.name ?? undefined,
        title: org.title ?? undefined,
      })),
    photoUrl: person.photos?.find((photo) => Boolean(photo.url))?.url ?? undefined,
    source,
  };
}

function normalizedPageSize(value: number | undefined, cap: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return Math.min(25, cap);
  }
  return Math.min(Math.trunc(value), cap);
}
