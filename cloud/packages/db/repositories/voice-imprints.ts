import { and, desc, eq, type SQL } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type ConversationSpeakerAttribution,
  conversationSpeakerAttributions,
  type NewConversationSpeakerAttribution,
  type NewVoiceImprintCluster,
  type NewVoiceImprintObservation,
  type VoiceImprintCluster,
  type VoiceImprintObservation,
  type VoiceImprintSourceKind,
  voiceImprintClusters,
  voiceImprintObservations,
} from "../schemas/voice-imprints";

export type {
  ConversationSpeakerAttribution,
  NewConversationSpeakerAttribution,
  NewVoiceImprintCluster,
  NewVoiceImprintObservation,
  VoiceImprintCluster,
  VoiceImprintObservation,
  VoiceImprintSourceKind,
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface ListVoiceImprintClustersOptions {
  sourceKind?: VoiceImprintSourceKind;
  sourceScopeId?: string;
  entityId?: string;
  embeddingModel?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface ListVoiceImprintObservationsOptions {
  clusterId?: string;
  conversationId?: string;
  conversationMessageId?: string;
  sourceKind?: VoiceImprintSourceKind;
  sourceId?: string;
  limit?: number;
  offset?: number;
}

export interface RecordVoiceObservationInput {
  cluster?: NewVoiceImprintCluster;
  observation: NewVoiceImprintObservation;
  attribution?: NewConversationSpeakerAttribution;
  clusterCentroid?: {
    clusterId: string;
    centroidEmbedding: number[];
    sampleCount: number;
    confidence: number;
  };
}

export interface RecordVoiceObservationResult {
  cluster?: VoiceImprintCluster;
  observation: VoiceImprintObservation;
  attribution?: ConversationSpeakerAttribution;
}

export class VoiceImprintsRepository {
  async getCluster(id: string): Promise<VoiceImprintCluster | undefined> {
    const [cluster] = await dbRead
      .select()
      .from(voiceImprintClusters)
      .where(eq(voiceImprintClusters.id, id))
      .limit(1);
    return cluster;
  }

  async listClustersByOrganization(
    organizationId: string,
    options: ListVoiceImprintClustersOptions = {},
  ): Promise<VoiceImprintCluster[]> {
    const limit = clampLimit(options.limit);
    const offset = Math.max(0, options.offset ?? 0);
    const conditions: SQL[] = [eq(voiceImprintClusters.organizationId, organizationId)];
    if (options.sourceKind) {
      conditions.push(eq(voiceImprintClusters.sourceKind, options.sourceKind));
    }
    if (options.sourceScopeId) {
      conditions.push(eq(voiceImprintClusters.sourceScopeId, options.sourceScopeId));
    }
    if (options.entityId) {
      conditions.push(eq(voiceImprintClusters.entityId, options.entityId));
    }
    if (options.embeddingModel) {
      conditions.push(eq(voiceImprintClusters.embeddingModel, options.embeddingModel));
    }
    if (options.status) {
      conditions.push(eq(voiceImprintClusters.status, options.status));
    }

    return await dbRead
      .select()
      .from(voiceImprintClusters)
      .where(and(...conditions))
      .orderBy(desc(voiceImprintClusters.updatedAt))
      .limit(limit)
      .offset(offset);
  }

  async listObservationsByOrganization(
    organizationId: string,
    options: ListVoiceImprintObservationsOptions = {},
  ): Promise<VoiceImprintObservation[]> {
    const limit = clampLimit(options.limit);
    const offset = Math.max(0, options.offset ?? 0);
    const conditions: SQL[] = [eq(voiceImprintObservations.organizationId, organizationId)];
    if (options.clusterId) {
      conditions.push(eq(voiceImprintObservations.clusterId, options.clusterId));
    }
    if (options.conversationId) {
      conditions.push(eq(voiceImprintObservations.conversationId, options.conversationId));
    }
    if (options.conversationMessageId) {
      conditions.push(
        eq(voiceImprintObservations.conversationMessageId, options.conversationMessageId),
      );
    }
    if (options.sourceKind) {
      conditions.push(eq(voiceImprintObservations.sourceKind, options.sourceKind));
    }
    if (options.sourceId) {
      conditions.push(eq(voiceImprintObservations.sourceId, options.sourceId));
    }

    return await dbRead
      .select()
      .from(voiceImprintObservations)
      .where(and(...conditions))
      .orderBy(desc(voiceImprintObservations.observedAt))
      .limit(limit)
      .offset(offset);
  }

  async createCluster(data: NewVoiceImprintCluster): Promise<VoiceImprintCluster> {
    const [cluster] = await dbWrite
      .insert(voiceImprintClusters)
      .values({ ...data, synthesisAllowed: false })
      .returning();
    if (!cluster) throw new Error("Failed to create voice imprint cluster");
    return cluster;
  }

  async createObservation(data: NewVoiceImprintObservation): Promise<VoiceImprintObservation> {
    const [observation] = await dbWrite
      .insert(voiceImprintObservations)
      .values({ ...data, synthesisAllowed: false })
      .returning();
    if (!observation) {
      throw new Error("Failed to create voice imprint observation");
    }
    return observation;
  }

  async createAttribution(
    data: NewConversationSpeakerAttribution,
  ): Promise<ConversationSpeakerAttribution> {
    const [attribution] = await dbWrite
      .insert(conversationSpeakerAttributions)
      .values({ ...data, synthesisAllowed: false })
      .returning();
    if (!attribution) {
      throw new Error("Failed to create conversation speaker attribution");
    }
    return attribution;
  }

  async updateClusterCentroid(input: {
    clusterId: string;
    centroidEmbedding: number[];
    sampleCount: number;
    confidence: number;
    now?: Date;
  }): Promise<VoiceImprintCluster> {
    const [cluster] = await dbWrite
      .update(voiceImprintClusters)
      .set({
        centroidEmbedding: input.centroidEmbedding,
        sampleCount: input.sampleCount,
        confidence: input.confidence,
        updatedAt: input.now ?? new Date(),
      })
      .where(eq(voiceImprintClusters.id, input.clusterId))
      .returning();
    if (!cluster) throw new Error("Failed to update voice imprint cluster");
    return cluster;
  }

  async recordObservation(
    input: RecordVoiceObservationInput,
  ): Promise<RecordVoiceObservationResult> {
    return await dbWrite.transaction(async (tx) => {
      let cluster: VoiceImprintCluster | undefined;
      if (input.cluster) {
        const [created] = await tx
          .insert(voiceImprintClusters)
          .values({ ...input.cluster, synthesisAllowed: false })
          .returning();
        if (!created) {
          throw new Error("Failed to create voice imprint cluster");
        }
        cluster = created;
      }

      const [observation] = await tx
        .insert(voiceImprintObservations)
        .values({
          ...input.observation,
          clusterId: input.observation.clusterId ?? cluster?.id ?? null,
          synthesisAllowed: false,
        })
        .returning();
      if (!observation) {
        throw new Error("Failed to create voice imprint observation");
      }

      if (input.clusterCentroid) {
        await tx
          .update(voiceImprintClusters)
          .set({
            centroidEmbedding: input.clusterCentroid.centroidEmbedding,
            sampleCount: input.clusterCentroid.sampleCount,
            confidence: input.clusterCentroid.confidence,
            updatedAt: new Date(),
          })
          .where(eq(voiceImprintClusters.id, input.clusterCentroid.clusterId));
      }

      let attribution: ConversationSpeakerAttribution | undefined;
      if (input.attribution) {
        const [created] = await tx
          .insert(conversationSpeakerAttributions)
          .values({
            ...input.attribution,
            clusterId: input.attribution.clusterId ?? observation.clusterId ?? cluster?.id ?? null,
            observationId: input.attribution.observationId ?? observation.id,
            synthesisAllowed: false,
          })
          .returning();
        if (!created) {
          throw new Error("Failed to create conversation speaker attribution");
        }
        attribution = created;
      }

      return {
        ...(cluster ? { cluster } : {}),
        observation,
        ...(attribution ? { attribution } : {}),
      };
    });
  }
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

export const voiceImprintsRepository = new VoiceImprintsRepository();
