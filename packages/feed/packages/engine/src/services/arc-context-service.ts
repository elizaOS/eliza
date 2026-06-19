/**
 * Arc Context Service
 *
 * Provides arc phase awareness to NPCs based on their affiliations.
 * NPCs affiliated with companies in "crisis" phase should behave differently
 * than those in "setup" phase.
 */

import {
  arcStates,
  db,
  inArray,
  type LongTermArcState,
  questions,
} from "@feed/db";
import { logger } from "@feed/shared";
import { formatError } from "../utils/error-utils";
import { StaticDataRegistry } from "./static-data-registry";

export interface ArcContext {
  questionId: string;
  questionText: string;
  orgId: string;
  orgName: string;
  currentPhase: LongTermArcState;
  behaviorGuidance: "defensive" | "cautious" | "opportunistic" | "neutral";
}

export class ArcContextService {
  /**
   * Get arc context for all organizations an NPC is affiliated with.
   * Returns phase information to guide NPC behavior.
   */
  async getArcContextForNpc(npcId: string): Promise<ArcContext[]> {
    const actor = StaticDataRegistry.getActor(npcId);
    if (!actor || actor.affiliations.length === 0) {
      return [];
    }

    const affiliatedOrgIds = actor.affiliations;
    const contexts: ArcContext[] = [];

    // Get org names for matching in question text
    const orgNames: string[] = [];
    const orgNameMap = new Map<string, string>();
    for (const orgId of affiliatedOrgIds) {
      const org = StaticDataRegistry.getOrganization(orgId);
      if (org) {
        orgNames.push(org.name);
        orgNameMap.set(orgId, org.name);
        if (org.ticker) orgNames.push(org.ticker);
      }
    }

    if (orgNames.length === 0) {
      return [];
    }

    try {
      // Get active arc states
      const activeArcs = await db
        .select({
          id: arcStates.id,
          questionId: arcStates.questionId,
          currentState: arcStates.currentState,
        })
        .from(arcStates)
        .limit(50);

      if (activeArcs.length === 0) {
        return [];
      }

      // Get question texts for these arcs
      const questionIds = activeArcs.map((a) => a.questionId);
      const questionRows = await db
        .select({
          id: questions.id,
          text: questions.text,
        })
        .from(questions)
        .where(inArray(questions.id, questionIds));

      const questionTextMap = new Map(questionRows.map((q) => [q.id, q.text]));

      // Match arcs to affiliated orgs
      for (const arc of activeArcs) {
        const questionText = questionTextMap.get(arc.questionId) ?? "";

        // Check if question mentions any affiliated org
        const matchedOrgId = affiliatedOrgIds.find((orgId) => {
          const org = StaticDataRegistry.getOrganization(orgId);
          if (!org) return false;
          const textLower = questionText.toLowerCase();
          return (
            textLower.includes(org.name.toLowerCase()) ||
            (org.ticker && textLower.includes(org.ticker.toLowerCase()))
          );
        });

        if (matchedOrgId) {
          const orgName = orgNameMap.get(matchedOrgId) ?? matchedOrgId;
          const phase = arc.currentState as LongTermArcState;

          contexts.push({
            questionId: arc.questionId,
            questionText,
            orgId: matchedOrgId,
            orgName,
            currentPhase: phase,
            behaviorGuidance: this.getBehaviorGuidance(phase),
          });
        }
      }
    } catch (error) {
      logger.warn(
        "Failed to get arc context for NPC",
        {
          npcId,
          error: formatError(error),
        },
        "ArcContextService",
      );
    }

    return contexts;
  }

  /**
   * Map arc phase to behavioral guidance for NPCs.
   */
  private getBehaviorGuidance(
    phase: LongTermArcState,
  ): ArcContext["behaviorGuidance"] {
    switch (phase) {
      case "crisis":
      case "escalation":
        return "defensive";
      case "tension":
        return "cautious";
      case "revelation":
      case "resolution":
        return "opportunistic";
      default:
        return "neutral";
    }
  }

  /**
   * Get a brief description of the arc phase for prompt context.
   */
  getPhaseDescription(phase: LongTermArcState): string {
    switch (phase) {
      case "setup":
        return "Early stage - situation is developing";
      case "tension":
        return "Building tension - conflicting signals emerging";
      case "escalation":
        return "Escalating - stakes are rising rapidly";
      case "crisis":
        return "Peak crisis - maximum uncertainty and stress";
      case "revelation":
        return "Truth emerging - key information coming to light";
      case "resolution":
        return "Resolving - outcome becoming clear";
      default:
        return "Unknown phase";
    }
  }
}

// Singleton instance
export const arcContextService = new ArcContextService();
