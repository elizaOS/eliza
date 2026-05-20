import { db, eq, generateSnowflakeId, worldStateSnapshots } from "@feed/db";

export class WorldStateSnapshotService {
  /**
   * Capture a complete world state snapshot at the current moment.
   * Called at the end of each game tick.
   */
  static async captureSnapshot(
    windowId: string,
    packId?: string,
  ): Promise<string> {
    const id = await generateSnowflakeId();
    const now = new Date();

    // Gather state from various tables
    const [predictionMarkets, perpMarkets, worldEvents, orgStates] =
      await Promise.all([
        WorldStateSnapshotService.getPredictionMarketState(),
        WorldStateSnapshotService.getPerpMarketState(),
        WorldStateSnapshotService.getWorldEvents(),
        WorldStateSnapshotService.getOrgStates(),
      ]);

    // Get arc/insider state
    const insiderAssignments =
      await WorldStateSnapshotService.getInsiderAssignments();
    const arcState = await WorldStateSnapshotService.getArcState();

    await db.insert(worldStateSnapshots).values({
      id,
      windowId,
      packId: packId ?? null,
      gameDay: Math.floor(Date.now() / (24 * 60 * 60 * 1000)), // simplified
      gameTime: now,
      predictionMarketsJson: JSON.stringify(predictionMarkets),
      perpMarketsJson: JSON.stringify(perpMarkets),
      worldEventsJson: JSON.stringify(worldEvents),
      insiderAssignmentsJson: JSON.stringify(insiderAssignments),
      arcPhase: arcState.phase ?? null,
      arcPlanJson: arcState.plan ? JSON.stringify(arcState.plan) : null,
      orgStatesJson: JSON.stringify(orgStates),
    });

    return id;
  }

  static async getLatestSnapshot(windowId: string): Promise<string | null> {
    const result = await db
      .select({ id: worldStateSnapshots.id })
      .from(worldStateSnapshots)
      .where(eq(worldStateSnapshots.windowId, windowId))
      .limit(1);
    return result[0]?.id ?? null;
  }

  // Private helper methods that query actual DB tables
  private static async getPredictionMarketState() {
    // Query questions table for active prediction markets
    // Return array of { marketId, question, resolvedOutcome }
    try {
      const { questions } = await import("@feed/db/schema");
      const markets = await db
        .select({
          id: questions.id,
          text: questions.text,
          outcome: questions.outcome,
        })
        .from(questions)
        .limit(100);
      return markets.map((m) => ({
        marketId: m.id,
        question: m.text,
        resolvedOutcome: m.outcome,
      }));
    } catch {
      return [];
    }
  }

  private static async getPerpMarketState() {
    // Return current perp market prices
    try {
      const { organizationState } = await import("@feed/db/schema");
      const orgs = await db
        .select({
          id: organizationState.id,
          basePrice: organizationState.basePrice,
        })
        .from(organizationState)
        .limit(100);
      return orgs.map((o) => ({
        ticker: o.id,
        price: Number(o.basePrice),
      }));
    } catch {
      return [];
    }
  }

  private static async getWorldEvents() {
    try {
      const { worldEvents } = await import("@feed/db/schema");
      const events = await db
        .select({
          id: worldEvents.id,
          eventType: worldEvents.eventType,
          description: worldEvents.description,
        })
        .from(worldEvents)
        .limit(50);
      return events;
    } catch {
      return [];
    }
  }

  private static async getInsiderAssignments() {
    try {
      const { questionArcPlans } = await import("@feed/db/schema");
      const plans = await db
        .select({
          id: questionArcPlans.id,
          insiderActorIds: questionArcPlans.insiderActorIds,
          deceiverActorIds: questionArcPlans.deceiverActorIds,
        })
        .from(questionArcPlans)
        .limit(50);
      return plans;
    } catch {
      return [];
    }
  }

  private static async getArcState() {
    // Return current arc phase
    return { phase: null as string | null, plan: null };
  }

  private static async getOrgStates() {
    try {
      const { organizationState } = await import("@feed/db/schema");
      const orgs = await db.select().from(organizationState).limit(100);
      return orgs;
    } catch {
      return [];
    }
  }
}
