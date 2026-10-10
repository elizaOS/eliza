/**
 * Meta ad-set targeting. "all" means every gender, so the genders field is
 * omitted. An empty list is not the same request: Meta treats a missing
 * genders field as everyone and rejects or ignores an empty array.
 */

import type { CampaignTargeting } from "../types";

const META_GENDER = {
  male: 1,
  female: 2,
} as const;

export function buildMetaTargeting(
  targetingInput: CampaignTargeting | undefined,
): Record<string, unknown> {
  const targeting: Record<string, unknown> = {};

  if (targetingInput?.locations?.length) {
    targeting.geo_locations = {
      countries: targetingInput.locations,
    };
  } else {
    targeting.geo_locations = { countries: ["US"] };
  }

  if (targetingInput?.ageMin || targetingInput?.ageMax) {
    targeting.age_min = targetingInput.ageMin || 18;
    targeting.age_max = targetingInput.ageMax || 65;
  }

  if (targetingInput?.genders?.length) {
    const genders = targetingInput.genders.flatMap((gender) =>
      gender === "male" || gender === "female" ? [META_GENDER[gender]] : [],
    );
    if (genders.length > 0) targeting.genders = genders;
  }

  if (targetingInput?.interests?.length) {
    const flexibleSpec: Record<string, unknown> = {
      interests: targetingInput.interests.map((interest) => ({ name: interest })),
    };
    if (targetingInput.behaviors?.length) {
      flexibleSpec.behaviors = targetingInput.behaviors.map((behavior) => ({
        name: behavior,
      }));
    }
    targeting.flexible_spec = [flexibleSpec];
  } else if (targetingInput?.behaviors?.length) {
    targeting.flexible_spec = [
      {
        behaviors: targetingInput.behaviors.map((behavior) => ({
          name: behavior,
        })),
      },
    ];
  }

  if (targetingInput?.customAudiences?.length) {
    targeting.custom_audiences = targetingInput.customAudiences.map((id) => ({ id }));
  }

  if (targetingInput?.excludedAudiences?.length) {
    targeting.excluded_custom_audiences = targetingInput.excludedAudiences.map((id) => ({
      id,
    }));
  }

  if (targetingInput?.placements?.length) {
    targeting.publisher_platforms = targetingInput.placements;
  }

  if (targetingInput?.languages?.length) {
    targeting.locales = targetingInput.languages;
  }

  return targeting;
}
