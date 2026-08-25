/**
 * Room spec for the group-room simulation, derived at runtime from the
 * homepage landing-demo module so the harness can never drift from the five
 * rooms the homepage animates. Nothing in here is a frozen copy: the scripts,
 * capability declarations, the forbidden-claim matcher and the per-capability
 * allow-list all come straight from packages/homepage/src/lib/landing-demo.ts
 * (a dependency-free module, so it imports with plain `bun run` and needs no
 * workspace build or `--conditions=eliza-source`).
 *
 * Vocabulary (positions are 0-based indexes into a room's `steps` array):
 *   - humanMessages: `member` steps (sender = member name) and `user` steps
 *     (sender = OWNER_SENDER, the demo viewer who owns the group).
 *   - elizaSteps: every other step kind. `text` is landingDemoStepText(step),
 *     so attachments (place, task-list, handoff, itinerary) carry their
 *     flattened text.
 *   - elizaPositions: the positions at which the homepage script has Eliza
 *     speak; the driver polls for a reply there and holds a silence window
 *     everywhere else.
 */

import {
  findUndeclaredLandingDemoClaims,
  findUnsupportedLandingDemoClaims,
  LANDING_DEMO_CAPABILITIES,
  LANDING_DEMO_SCENARIOS,
  LANDING_DEMO_UNSUPPORTED_CLAIM_CATEGORIES,
  type LandingDemoCapability,
  type LandingDemoScenarioId,
  type LandingDemoUnsupportedClaimCategory,
  landingDemoStepText,
} from "../../../homepage/src/lib/landing-demo";
import { firstPersonClaimSpans } from "./first-person-claims";

/** Sender name the spec uses for `user` steps (the group owner). */
export const OWNER_SENDER = "You";

export interface HumanMessage {
  position: number;
  sender: string;
  text: string;
}

export interface ElizaStep {
  position: number;
  kind: string;
  capability: LandingDemoCapability;
  text: string;
}

export interface RoomSpec {
  id: LandingDemoScenarioId;
  label: string;
  roomName: string;
  members: readonly string[];
  stepCount: number;
  humanMessages: HumanMessage[];
  elizaSteps: ElizaStep[];
  elizaPositions: number[];
}

export interface RoomsSpec {
  /** Homepage rotation order; also the handle-allocation order. */
  rotationOrder: LandingDemoScenarioId[];
  capabilities: readonly LandingDemoCapability[];
  forbiddenClaimCategories: readonly LandingDemoUnsupportedClaimCategory[];
  allowedClaimsByCapability: Record<
    LandingDemoCapability,
    LandingDemoUnsupportedClaimCategory[]
  >;
  rooms: RoomSpec[];
}

/**
 * One phrase per forbidden-claim category. The homepage module does not
 * export its per-capability allow-list, so it is recovered by asking
 * findUndeclaredLandingDemoClaims which categories it tolerates for each
 * capability on a text that trips every category. deriveAllowedClaims()
 * refuses to run if the probe stops tripping a category (a new rule landed):
 * extend this probe, never guess the allow-list.
 */
export const CLAIM_PROBE_TEXT =
  "email calendar booked bought reminder notes texted checked-in searched " +
  "terminal folders browser ran the tests household memory";

function deriveAllowedClaims(): RoomsSpec["allowedClaimsByCapability"] {
  const tripped = new Set(findUnsupportedLandingDemoClaims(CLAIM_PROBE_TEXT));
  const missing = LANDING_DEMO_UNSUPPORTED_CLAIM_CATEGORIES.filter(
    (category) => !tripped.has(category),
  );
  if (missing.length > 0) {
    throw new Error(
      `CLAIM_PROBE_TEXT no longer trips every forbidden-claim category (missing: ${missing.join(", ")}); extend the probe in rooms-spec.ts`,
    );
  }
  const allowed = {} as RoomsSpec["allowedClaimsByCapability"];
  for (const capability of LANDING_DEMO_CAPABILITIES) {
    const undeclared = new Set(
      findUndeclaredLandingDemoClaims({
        capability,
        kind: "eliza",
        text: CLAIM_PROBE_TEXT,
      }),
    );
    allowed[capability] = LANDING_DEMO_UNSUPPORTED_CLAIM_CATEGORIES.filter(
      (category) => !undeclared.has(category),
    );
  }
  return allowed;
}

/**
 * Forbidden-claim categories a piece of Eliza output trips, minus the ones
 * the room's scripted capabilities allow. Runs the homepage module's own
 * UNSUPPORTED_CLAIM_RULES, but only over the output's first-person spans
 * (./first-person-claims.ts): the rules are written for marketing copy and
 * fire on bare vocabulary, so a hit counts only where Eliza is asserting or
 * offering her own capability, never where the verb belongs to a human
 * ("if you send the address", "you could buy") or to a todo line. Result is
 * in rule order, which the tests pin to the module's category list.
 */
export function forbiddenHits(
  allowedCategories: ReadonlySet<string>,
  text: string,
): string[] {
  const tripped = new Set<string>();
  for (const span of firstPersonClaimSpans(text)) {
    for (const category of findUnsupportedLandingDemoClaims(span)) {
      tripped.add(category);
    }
  }
  return LANDING_DEMO_UNSUPPORTED_CLAIM_CATEGORIES.filter(
    (category) => tripped.has(category) && !allowedCategories.has(category),
  );
}

export function buildRoomsSpec(): RoomsSpec {
  const rooms = LANDING_DEMO_SCENARIOS.map((scenario): RoomSpec => {
    const humanMessages: HumanMessage[] = [];
    const elizaSteps: ElizaStep[] = [];
    scenario.steps.forEach((step, position) => {
      if (step.kind === "member") {
        humanMessages.push({ position, sender: step.name, text: step.text });
      } else if (step.kind === "user") {
        humanMessages.push({ position, sender: OWNER_SENDER, text: step.text });
      } else {
        elizaSteps.push({
          position,
          kind: step.kind,
          capability: step.capability,
          text: landingDemoStepText(step),
        });
      }
    });
    return {
      id: scenario.id,
      label: scenario.label,
      roomName: scenario.roomName,
      members: [...scenario.members],
      stepCount: scenario.steps.length,
      humanMessages,
      elizaSteps,
      elizaPositions: elizaSteps.map((step) => step.position),
    };
  });
  return {
    rotationOrder: rooms.map((room) => room.id),
    capabilities: LANDING_DEMO_CAPABILITIES,
    forbiddenClaimCategories: LANDING_DEMO_UNSUPPORTED_CLAIM_CATEGORIES,
    allowedClaimsByCapability: deriveAllowedClaims(),
    rooms,
  };
}
