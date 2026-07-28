/**
 * Reviewed locale-specific human-handoff resources for parenting safety
 * boundaries. Resolution is exact and all-or-nothing: a handoff returns
 * contacts only when every requested kind has a fresh record for the
 * configured locale, so an unsupported jurisdiction never inherits a number
 * from another country.
 */

import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type { ParentingHandoffKind } from "./types.js";

export type ParentingHandoffContact =
  | {
      readonly kind: "phone";
      readonly label: string;
      readonly value: string;
    }
  | {
      readonly kind: "call_or_text";
      readonly label: string;
      readonly value: string;
    }
  | {
      readonly kind: "website";
      readonly label: string;
      readonly url: string;
    };

export interface ParentingHandoffResource {
  readonly id: string;
  readonly jurisdiction: string;
  readonly locales: readonly string[];
  readonly handoffKinds: readonly ParentingHandoffKind[];
  readonly title: string;
  readonly publisher: string;
  readonly description: string;
  readonly sourceUrl: string;
  readonly contacts: readonly ParentingHandoffContact[];
  readonly reviewedAt: string;
  readonly reviewExpiresAt: string;
}

export type ParentingLocaleEvidence =
  | {
      readonly status: "resolved";
      readonly locale: string;
      readonly source: "configured_owner_locale" | "runtime_locale_provider";
      readonly observedAt: string;
      readonly provenance:
        | "first_run"
        | "profile_save"
        | "connector_inferred"
        | null;
      readonly unavailableReason: null;
    }
  | {
      readonly status: "unavailable";
      readonly locale: string | null;
      readonly source: "unavailable";
      readonly observedAt: string | null;
      readonly provenance:
        | "first_run"
        | "profile_save"
        | "connector_inferred"
        | null;
      readonly unavailableReason:
        | "locale_missing"
        | "locale_untrusted"
        | "locale_stale"
        | "locale_in_transit";
    };

export type ParentingHandoffResourceUnavailableReason =
  | "locale_missing"
  | "locale_untrusted"
  | "locale_stale"
  | "locale_in_transit"
  | "locale_invalid"
  | "locale_missing_region"
  | "locale_unsupported"
  | "resource_set_incomplete"
  | "resource_review_expired";

export type ParentingHandoffResourceResolution =
  | {
      readonly status: "not_required";
      readonly locale: null;
      readonly jurisdiction: null;
      readonly requestedKinds: readonly [];
      readonly resources: readonly [];
      readonly unavailableReason: null;
    }
  | {
      readonly status: "resolved";
      readonly locale: string;
      readonly jurisdiction: string;
      readonly requestedKinds: readonly ParentingHandoffKind[];
      readonly resources: readonly ParentingHandoffResource[];
      readonly unavailableReason: null;
    }
  | {
      readonly status: "unavailable";
      readonly locale: string | null;
      readonly jurisdiction: string | null;
      readonly requestedKinds: readonly ParentingHandoffKind[];
      readonly resources: readonly [];
      readonly unavailableReason: ParentingHandoffResourceUnavailableReason;
    };

export interface ParentingHandoffResourceResolver {
  resolve(input: {
    readonly localeEvidence: ParentingLocaleEvidence;
    readonly requestedAt: string;
    readonly kinds: readonly ParentingHandoffKind[];
  }): Promise<ParentingHandoffResourceResolution>;
}

const REVIEWED_AT = "2026-07-27T12:00:00.000Z";
const REVIEW_EXPIRES_AT = "2027-01-27T12:00:00.000Z";

/**
 * The records below contain only publisher-supported contact surfaces. State
 * and local safeguarding rules vary, so that handoff deliberately points to
 * the federal directory instead of embedding a guessed state hotline.
 */
export const PARENTING_HANDOFF_RESOURCES: readonly ParentingHandoffResource[] =
  [
    {
      id: "us-national-911-program-2026",
      jurisdiction: "US",
      locales: ["en-US"],
      handoffKinds: ["emergency_services"],
      title: "Emergency services",
      publisher: "U.S. National 911 Program",
      description:
        "For an emergency in the United States, call 911 immediately.",
      sourceUrl: "https://www.911.gov/calling-911/",
      contacts: [
        {
          kind: "phone",
          label: "Call 911",
          value: "911",
        },
      ],
      reviewedAt: REVIEWED_AT,
      reviewExpiresAt: REVIEW_EXPIRES_AT,
    },
    {
      id: "us-988-lifeline-2026",
      jurisdiction: "US",
      locales: ["en-US"],
      handoffKinds: ["crisis_support"],
      title: "988 Suicide & Crisis Lifeline",
      publisher: "988 Suicide & Crisis Lifeline",
      description:
        "Free crisis support is available in the United States by calling or texting 988.",
      sourceUrl: "https://988lifeline.org/get-help/",
      contacts: [
        {
          kind: "call_or_text",
          label: "Call or text 988",
          value: "988",
        },
        {
          kind: "website",
          label: "Open the official 988 help page",
          url: "https://988lifeline.org/get-help/",
        },
      ],
      reviewedAt: REVIEWED_AT,
      reviewExpiresAt: REVIEW_EXPIRES_AT,
    },
    {
      id: "us-child-welfare-reporting-directory-2026",
      jurisdiction: "US",
      locales: ["en-US"],
      handoffKinds: ["child_safeguarding"],
      title: "State child-welfare reporting directory",
      publisher: "U.S. Children's Bureau, Child Welfare Information Gateway",
      description:
        "Use the official state and territory directory to identify the authority that receives suspected-abuse or neglect reports in the child's location.",
      sourceUrl:
        "https://www.childwelfare.gov/resources/states-territories-tribes/related-organizations/?o=alphabetical&rt=800",
      contacts: [
        {
          kind: "website",
          label: "Find the state or territory reporting authority",
          url: "https://www.childwelfare.gov/resources/states-territories-tribes/related-organizations/?o=alphabetical&rt=800",
        },
      ],
      reviewedAt: REVIEWED_AT,
      reviewExpiresAt: REVIEW_EXPIRES_AT,
    },
    {
      id: "us-samhsa-treatment-locator-2026",
      jurisdiction: "US",
      locales: ["en-US"],
      handoffKinds: ["licensed_mental_health_professional"],
      title: "Mental-health treatment locator",
      publisher:
        "U.S. Substance Abuse and Mental Health Services Administration",
      description:
        "Search the federal treatment locator for mental-health providers and facilities in the United States and its territories.",
      sourceUrl: "https://findtreatment.gov/locator",
      contacts: [
        {
          kind: "website",
          label: "Search FindTreatment.gov",
          url: "https://findtreatment.gov/locator",
        },
      ],
      reviewedAt: REVIEWED_AT,
      reviewExpiresAt: REVIEW_EXPIRES_AT,
    },
    {
      id: "us-aap-pediatrician-referral-2026",
      jurisdiction: "US",
      locales: ["en-US"],
      handoffKinds: ["pediatrician_or_prescriber"],
      title: "Find an AAP pediatrician",
      publisher: "American Academy of Pediatrics",
      description:
        "Search the American Academy of Pediatrics referral service for a pediatrician or pediatric specialist.",
      sourceUrl:
        "https://www.healthychildren.org/English/tips-tools/find-pediatrician/Pages/Pediatrician-Referral-Service.aspx",
      contacts: [
        {
          kind: "website",
          label: "Open the AAP pediatrician referral service",
          url: "https://www.healthychildren.org/English/tips-tools/find-pediatrician/Pages/Pediatrician-Referral-Service.aspx",
        },
      ],
      reviewedAt: REVIEWED_AT,
      reviewExpiresAt: REVIEW_EXPIRES_AT,
    },
    {
      id: "us-legal-aid-directory-2026",
      jurisdiction: "US",
      locales: ["en-US"],
      handoffKinds: ["qualified_legal_professional"],
      title: "Affordable legal-aid directory",
      publisher: "USAGov",
      description:
        "Use the federal directory to locate free or lower-cost legal help, including family-law assistance.",
      sourceUrl: "https://www.usa.gov/legal-aid",
      contacts: [
        {
          kind: "website",
          label: "Find legal aid through USAGov",
          url: "https://www.usa.gov/legal-aid",
        },
      ],
      reviewedAt: REVIEWED_AT,
      reviewExpiresAt: REVIEW_EXPIRES_AT,
    },
  ] as const;

function unavailable(
  input: {
    locale: string | null;
    jurisdiction: string | null;
    kinds: readonly ParentingHandoffKind[];
  },
  reason: ParentingHandoffResourceUnavailableReason,
): ParentingHandoffResourceResolution {
  return {
    status: "unavailable",
    locale: input.locale,
    jurisdiction: input.jurisdiction,
    requestedKinds: [...input.kinds],
    resources: [],
    unavailableReason: reason,
  };
}

function exactLocale(value: string): {
  locale: string;
  jurisdiction: string | null;
} | null {
  try {
    const parsed = new Intl.Locale(value);
    return {
      locale: parsed.baseName,
      jurisdiction: parsed.region ?? null,
    };
  } catch {
    // error-policy:J3 a malformed BCP-47 value becomes an explicit invalid
    // locale result; it never falls back to a different jurisdiction.
    return null;
  }
}

function validTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ElizaError(`${field} must be an ISO-8601 timestamp`, {
      code: "PARENTING_HANDOFF_RESOURCE_INVALID",
      context: { field, value },
      severity: "fatal",
    });
  }
  return parsed;
}

function cloneResource(
  resource: ParentingHandoffResource,
): ParentingHandoffResource {
  return {
    ...resource,
    locales: [...resource.locales],
    handoffKinds: [...resource.handoffKinds],
    contacts: resource.contacts.map((contact) => ({ ...contact })),
  };
}

export class ReviewedParentingHandoffResourceResolver
  implements ParentingHandoffResourceResolver
{
  constructor(
    private readonly resources: readonly ParentingHandoffResource[] = PARENTING_HANDOFF_RESOURCES,
  ) {}

  async resolve(input: {
    readonly localeEvidence: ParentingLocaleEvidence;
    readonly requestedAt: string;
    readonly kinds: readonly ParentingHandoffKind[];
  }): Promise<ParentingHandoffResourceResolution> {
    const kinds = Array.from(new Set(input.kinds));
    if (kinds.length === 0) {
      return {
        status: "not_required",
        locale: null,
        jurisdiction: null,
        requestedKinds: [],
        resources: [],
        unavailableReason: null,
      };
    }
    if (input.localeEvidence.status === "unavailable") {
      return unavailable(
        {
          locale: input.localeEvidence.locale,
          jurisdiction: null,
          kinds,
        },
        input.localeEvidence.unavailableReason,
      );
    }
    const localeText = input.localeEvidence.locale.trim();
    if (!localeText) {
      return unavailable(
        { locale: null, jurisdiction: null, kinds },
        "locale_missing",
      );
    }
    const parsedLocale = exactLocale(localeText);
    if (!parsedLocale) {
      return unavailable(
        { locale: localeText, jurisdiction: null, kinds },
        "locale_invalid",
      );
    }
    if (!parsedLocale.jurisdiction) {
      return unavailable(
        {
          locale: parsedLocale.locale,
          jurisdiction: null,
          kinds,
        },
        "locale_missing_region",
      );
    }
    const requestedAt = validTimestamp(input.requestedAt, "requestedAt");
    const localeResources = this.resources.filter(
      (resource) =>
        resource.jurisdiction === parsedLocale.jurisdiction &&
        resource.locales.includes(parsedLocale.locale),
    );
    if (localeResources.length === 0) {
      return unavailable(
        {
          locale: parsedLocale.locale,
          jurisdiction: parsedLocale.jurisdiction,
          kinds,
        },
        "locale_unsupported",
      );
    }

    const selected = new Map<string, ParentingHandoffResource>();
    for (const kind of kinds) {
      const candidates = localeResources.filter((resource) =>
        resource.handoffKinds.includes(kind),
      );
      if (candidates.length === 0) {
        return unavailable(
          {
            locale: parsedLocale.locale,
            jurisdiction: parsedLocale.jurisdiction,
            kinds,
          },
          "resource_set_incomplete",
        );
      }
      const fresh = candidates.filter(
        (resource) =>
          validTimestamp(resource.reviewedAt, `${resource.id}.reviewedAt`) <=
            requestedAt &&
          validTimestamp(
            resource.reviewExpiresAt,
            `${resource.id}.reviewExpiresAt`,
          ) >= requestedAt,
      );
      if (fresh.length === 0) {
        return unavailable(
          {
            locale: parsedLocale.locale,
            jurisdiction: parsedLocale.jurisdiction,
            kinds,
          },
          "resource_review_expired",
        );
      }
      for (const resource of fresh) selected.set(resource.id, resource);
    }

    return {
      status: "resolved",
      locale: parsedLocale.locale,
      jurisdiction: parsedLocale.jurisdiction,
      requestedKinds: kinds,
      resources: Array.from(selected.values()).map(cloneResource),
      unavailableReason: null,
    };
  }
}

export const defaultParentingHandoffResourceResolver =
  new ReviewedParentingHandoffResourceResolver();

const RESOURCE_RESOLVER_KEY = Symbol.for(
  "@elizaos/plugin-personal-assistant:parenting-handoff-resource-resolver",
);

interface ParentingResourceRuntime extends IAgentRuntime {
  [RESOURCE_RESOLVER_KEY]?: ParentingHandoffResourceResolver;
}

export function registerParentingHandoffResourceResolver(
  runtime: IAgentRuntime,
  resolver: ParentingHandoffResourceResolver,
): void {
  (runtime as ParentingResourceRuntime)[RESOURCE_RESOLVER_KEY] = resolver;
}

export function getParentingHandoffResourceResolver(
  runtime: IAgentRuntime,
): ParentingHandoffResourceResolver {
  return (
    (runtime as ParentingResourceRuntime)[RESOURCE_RESOLVER_KEY] ??
    defaultParentingHandoffResourceResolver
  );
}
