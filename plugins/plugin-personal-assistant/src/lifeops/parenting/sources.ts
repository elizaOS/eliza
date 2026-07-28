/**
 * Reviewed source registry and original, compact practice options for ordinary
 * parenting questions. Source metadata is versioned and expires for review;
 * the registry stores no copied article text and never supplies clinical,
 * medication, safeguarding, or legal advice.
 */

import type {
  ParentingAgeBand,
  ParentingGuidanceOption,
  ParentingGuidanceSource,
  ParentingTopic,
} from "./types.js";

const REVIEWED_AT = "2026-07-26T12:00:00.000Z";
const REVIEW_EXPIRES_AT = "2027-01-26T12:00:00.000Z";

export const PARENTING_GUIDANCE_SOURCES: readonly ParentingGuidanceSource[] = [
  {
    id: "cdc-toddler-structure-rules-2026",
    publisher: "U.S. Centers for Disease Control and Prevention",
    title: "Tips for Creating Rules",
    url: "https://www.cdc.gov/parenting-toddlers/structure-rules/rules.html",
    sourceUpdatedAt: "2026-04-30",
    reviewedAt: REVIEWED_AT,
    reviewExpiresAt: REVIEW_EXPIRES_AT,
    evidenceTier: "government_public_health",
    ageBands: ["toddler_preschool"],
    topics: ["boundary_setting", "routines", "positive_discipline"],
  },
  {
    id: "cdc-toddler-structure-2026",
    publisher: "U.S. Centers for Disease Control and Prevention",
    title: "Tips for Building Structure",
    url: "https://www.cdc.gov/parenting-toddlers/structure-rules/structure.html",
    sourceUpdatedAt: "2026-04-30",
    reviewedAt: REVIEWED_AT,
    reviewExpiresAt: REVIEW_EXPIRES_AT,
    evidenceTier: "government_public_health",
    ageBands: ["toddler_preschool"],
    topics: ["routines", "boundary_setting"],
  },
  {
    id: "cdc-positive-parenting-tips-2026",
    publisher: "U.S. Centers for Disease Control and Prevention",
    title: "Positive Parenting Tips",
    url: "https://www.cdc.gov/child-development/positive-parenting-tips/index.html",
    sourceUpdatedAt: "2026-02-20",
    reviewedAt: REVIEWED_AT,
    reviewExpiresAt: REVIEW_EXPIRES_AT,
    evidenceTier: "government_public_health",
    ageBands: ["toddler_preschool", "school_age", "teen"],
    topics: [
      "communication",
      "emotion_coaching",
      "independence",
      "positive_discipline",
    ],
  },
  {
    id: "aap-positive-discipline-2018",
    publisher: "American Academy of Pediatrics",
    title: "What's the Best Way to Discipline My Child?",
    url: "https://www.healthychildren.org/English/family-life/family-dynamics/communication-discipline/Pages/Disciplining-Your-Child.aspx",
    sourceUpdatedAt: "2018-11-05",
    reviewedAt: REVIEWED_AT,
    reviewExpiresAt: REVIEW_EXPIRES_AT,
    evidenceTier: "professional_academy",
    ageBands: ["toddler_preschool", "school_age", "teen"],
    topics: [
      "boundary_setting",
      "communication",
      "positive_discipline",
      "emotion_coaching",
    ],
  },
  {
    id: "aap-family-communication-2025",
    publisher: "American Academy of Pediatrics",
    title: "Communication Dos and Don'ts",
    url: "https://www.healthychildren.org/english/family-life/family-dynamics/communication-discipline/pages/communication-dos-and-donts.aspx",
    sourceUpdatedAt: "2025-12-15",
    reviewedAt: REVIEWED_AT,
    reviewExpiresAt: REVIEW_EXPIRES_AT,
    evidenceTier: "professional_academy",
    ageBands: ["school_age"],
    topics: ["communication", "emotion_coaching", "independence"],
  },
  {
    id: "aap-family-routines-2024",
    publisher: "American Academy of Pediatrics",
    title: "The Importance of Family Routines",
    url: "https://www.healthychildren.org/English/family-life/family-dynamics/Pages/The-Importance-of-Family-Routines.aspx",
    sourceUpdatedAt: "2024-06-28",
    reviewedAt: REVIEWED_AT,
    reviewExpiresAt: REVIEW_EXPIRES_AT,
    evidenceTier: "professional_academy",
    ageBands: ["toddler_preschool", "school_age", "teen"],
    topics: ["routines", "boundary_setting", "independence"],
  },
  {
    id: "cdc-parenting-teens-2024",
    publisher: "U.S. Centers for Disease Control and Prevention",
    title: "Essentials for Parenting Teens",
    url: "https://www.cdc.gov/parenting-teens/about/index.html",
    sourceUpdatedAt: "2024-04-17",
    reviewedAt: REVIEWED_AT,
    reviewExpiresAt: REVIEW_EXPIRES_AT,
    evidenceTier: "government_public_health",
    ageBands: ["teen"],
    topics: [
      "communication",
      "emotion_coaching",
      "independence",
      "positive_discipline",
      "boundary_setting",
    ],
  },
  {
    id: "aap-teen-privacy-2026",
    publisher: "American Academy of Pediatrics",
    title: "Privacy in Health Care: Information for Teens",
    url: "https://www.healthychildren.org/English/ages-stages/teen/Pages/Information-for-Teens-What-You-Need-to-Know-About-Privacy.aspx",
    sourceUpdatedAt: "2026-02-11",
    reviewedAt: REVIEWED_AT,
    reviewExpiresAt: REVIEW_EXPIRES_AT,
    evidenceTier: "professional_academy",
    ageBands: ["teen"],
    topics: ["communication", "independence"],
  },
  {
    id: "good-inside-boundaries-2026",
    publisher: "Good Inside",
    title: "An Effective Alternative to Punishments for Kids",
    url: "https://www.goodinside.com/blog/punishment-and-consequences-for-kids/",
    sourceUpdatedAt: "not_stated",
    reviewedAt: REVIEWED_AT,
    reviewExpiresAt: REVIEW_EXPIRES_AT,
    evidenceTier: "named_framework_primary",
    ageBands: ["toddler_preschool", "school_age", "teen"],
    topics: [
      "boundary_setting",
      "communication",
      "emotion_coaching",
      "positive_discipline",
    ],
  },
] as const;

const OPTIONS: Readonly<
  Record<ParentingTopic, readonly ParentingGuidanceOption[]>
> = {
  boundary_setting: [
    {
      id: "boundary-clear-calm",
      title: "State one clear, age-appropriate limit",
      steps: [
        "Choose the specific behavior the limit covers.",
        "Say the limit briefly and calmly in language the child can understand.",
        "Name what will happen next without threats, shame, or an unrelated punishment.",
      ],
      sourceIds: [
        "cdc-toddler-structure-rules-2026",
        "aap-positive-discipline-2018",
      ],
      rationale:
        "Specific, predictable limits are easier to understand and follow than broad commands.",
    },
    {
      id: "boundary-feeling-and-limit",
      title: "Acknowledge the feeling while keeping the limit",
      steps: [
        "Reflect the child's likely feeling without claiming certainty.",
        "Keep the safety or family limit unchanged.",
        "Offer one or two acceptable choices inside the limit when appropriate.",
      ],
      sourceIds: [
        "aap-positive-discipline-2018",
        "good-inside-boundaries-2026",
      ],
      rationale:
        "Connection and a firm limit can coexist; acknowledging a feeling does not require changing the decision.",
    },
    {
      id: "boundary-follow-through-repair",
      title: "Follow through, then review and repair",
      steps: [
        "Use the consequence or next step that was explained.",
        "Reconnect after the moment is calm.",
        "Review whether the rule was realistic and whether all caregivers can apply it consistently.",
      ],
      sourceIds: [
        "cdc-toddler-structure-rules-2026",
        "good-inside-boundaries-2026",
      ],
      rationale:
        "Predictability builds trust, while later repair makes room for learning rather than perfection.",
    },
  ],
  routines: [
    {
      id: "routine-small-sequence",
      title: "Build one short, repeatable sequence",
      steps: [
        "Choose one recurring transition that causes friction.",
        "Define a small sequence with the same cues and order.",
        "Practice it at a calm time and adjust it for the child's developmental ability.",
      ],
      sourceIds: ["cdc-toddler-structure-2026", "aap-family-routines-2024"],
      rationale:
        "A repeatable sequence makes the next step more predictable for both child and caregiver.",
    },
    {
      id: "routine-caregiver-alignment",
      title: "Align the adults on the minimum routine",
      steps: [
        "Agree on the few steps that matter across homes or caregivers.",
        "Document exceptions such as travel or school nights.",
        "Review what worked without making the child carry messages between adults.",
      ],
      sourceIds: [
        "cdc-toddler-structure-rules-2026",
        "aap-positive-discipline-2018",
        "aap-family-routines-2024",
      ],
      rationale:
        "Children receive fewer mixed signals when caregivers agree on a realistic core routine.",
    },
  ],
  communication: [
    {
      id: "communication-listen-reflect",
      title: "Listen first and check your understanding",
      steps: [
        "Choose a time and place with enough privacy and attention.",
        "Let the child finish before offering a solution.",
        "Reflect what you heard and ask whether you understood correctly.",
      ],
      sourceIds: [
        "cdc-positive-parenting-tips-2026",
        "aap-family-communication-2025",
        "cdc-parenting-teens-2024",
      ],
      rationale:
        "Checking understanding reduces assumption-driven conflict and helps a child feel heard.",
    },
    {
      id: "communication-specific-observation",
      title: "Describe the behavior without labeling the child",
      steps: [
        "Describe the observable situation.",
        "Explain the impact or family expectation.",
        "Invite the child's view and agree on the next concrete step.",
      ],
      sourceIds: [
        "cdc-positive-parenting-tips-2026",
        "aap-family-communication-2025",
      ],
      rationale:
        "Behavior-specific language keeps the conversation about a solvable situation rather than the child's character.",
    },
  ],
  emotion_coaching: [
    {
      id: "emotion-regulate-name-plan",
      title: "Regulate, name tentatively, then plan",
      steps: [
        "Pause until the adult can respond without yelling or shaming.",
        "Offer a tentative emotion label and let the child correct it.",
        "When calm, practice one safe response for the next similar moment.",
      ],
      sourceIds: [
        "aap-positive-discipline-2018",
        "cdc-positive-parenting-tips-2026",
        "aap-family-communication-2025",
        "good-inside-boundaries-2026",
      ],
      rationale:
        "A calm adult response and tentative language support learning without claiming to know the child's inner state.",
    },
  ],
  independence: [
    {
      id: "independence-supported-choice",
      title: "Offer bounded, developmentally appropriate choice",
      steps: [
        "Name which part of the decision belongs to the child.",
        "Keep adult responsibility for safety and non-negotiable limits.",
        "Review the result together without turning a mistake into a character judgment.",
      ],
      sourceIds: [
        "cdc-positive-parenting-tips-2026",
        "cdc-parenting-teens-2024",
        "aap-family-communication-2025",
      ],
      rationale:
        "Clear decision boundaries let independence grow without silently transferring adult safety responsibilities.",
    },
  ],
  positive_discipline: [
    {
      id: "discipline-teach-reinforce",
      title: "Teach and reinforce the replacement behavior",
      steps: [
        "State the behavior you want to see, not only what must stop.",
        "Model or practice that behavior.",
        "Notice and describe progress; use calm, related consequences when needed.",
      ],
      sourceIds: [
        "aap-positive-discipline-2018",
        "cdc-toddler-structure-rules-2026",
        "cdc-positive-parenting-tips-2026",
      ],
      rationale:
        "Discipline is more useful when it teaches a replacement skill and avoids physical punishment, humiliation, or threats.",
    },
  ],
};

export function parentingSourcesFor(
  ageBand: ParentingAgeBand,
  topic: ParentingTopic,
  requestedFramework: "none" | "good_inside",
): ParentingGuidanceSource[] {
  return PARENTING_GUIDANCE_SOURCES.filter(
    (source) =>
      source.ageBands.includes(ageBand) &&
      source.topics.includes(topic) &&
      (source.evidenceTier !== "named_framework_primary" ||
        requestedFramework === "good_inside"),
  );
}

export function parentingOptionsFor(
  ageBand: ParentingAgeBand,
  topic: ParentingTopic,
  sourceIds: ReadonlySet<string>,
): ParentingGuidanceOption[] {
  return OPTIONS[topic]
    .filter((option) =>
      option.sourceIds.some((sourceId) => sourceIds.has(sourceId)),
    )
    .map((option) => ({
      ...option,
      steps: [...option.steps],
      sourceIds: option.sourceIds.filter((sourceId) => sourceIds.has(sourceId)),
      rationale:
        ageBand === "teen"
          ? `${option.rationale} Preserve age-appropriate privacy and invite the teen's perspective.`
          : option.rationale,
    }));
}
