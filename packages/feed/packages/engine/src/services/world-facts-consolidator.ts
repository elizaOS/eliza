/**
 * World Facts Consolidator
 *
 * Periodic sweep that clusters semantically similar world facts and
 * merges each cluster into a single concise fact. Runs after world facts
 * generation (via /api/cron/world-facts route) to:
 *
 *  1. Reduce context bloat — ~100 redundant facts → ~30-40 consolidated
 *  2. Save tokens — 10-20K chars of world context → 5-8K per prompt
 *  3. Filter contamination — LLM consolidation + quality gate on output
 *  4. Improve relevance — consolidated facts are fresh syntheses
 *
 * Cost: ~$0.10/sweep (embeddings + ~15 LLM consolidation calls),
 * running 3x/day = ~$9/month.
 */

import { and, db, desc, eq, inArray, worldFacts } from '@babylon/db';
import { generateSnowflakeId, logger } from '@babylon/shared';
import { cosineSimilarity, getEmbeddings } from '../llm/embedding-client';
import { BabylonLLMClient } from '../llm/openai-client';
import { ContentQualityGate } from './content-quality-gate';

interface ConsolidationResult {
  consolidated: number;
  archived: number;
  skipped: number;
}

interface FactWithEmbedding {
  id: string;
  value: string;
  embedding: number[];
  createdAt: Date;
}

const SIMILARITY_THRESHOLD = 0.8;
const MIN_FACTS_TO_CONSOLIDATE = 30;
const MIN_CLUSTER_SIZE = 2;
/**
 * Must stay ≤ embedding-client's MAX_BATCH_SIZE (currently 100) so that
 * getEmbeddings() processes all facts in a single API call. If this value
 * increases, the embedding client will automatically chunk into multiple
 * requests, but latency and cost scale linearly.
 */
const MAX_FACTS_TO_PROCESS = 100;

export class WorldFactsConsolidator {
  private llm: BabylonLLMClient;

  constructor(llm: BabylonLLMClient) {
    this.llm = llm;
  }

  /**
   * Run the consolidation sweep.
   *
   * 1. Load all active auto-generated facts
   * 2. Skip if below threshold
   * 3. Embed all facts
   * 4. Cluster by cosine similarity
   * 5. For each multi-fact cluster: LLM consolidation → quality gate → store
   * 6. Archive originals from consolidated clusters
   */
  async consolidateFacts(): Promise<ConsolidationResult> {
    const result: ConsolidationResult = {
      consolidated: 0,
      archived: 0,
      skipped: 0,
    };

    // 1. Load active auto-generated facts
    const facts = await db
      .select()
      .from(worldFacts)
      .where(
        and(
          eq(worldFacts.isActive, true),
          eq(worldFacts.source, 'auto-generated')
        )
      )
      .orderBy(desc(worldFacts.createdAt));

    if (facts.length < MIN_FACTS_TO_CONSOLIDATE) {
      logger.info(
        'Skipping consolidation — not enough facts',
        { activeCount: facts.length, threshold: MIN_FACTS_TO_CONSOLIDATE },
        'WorldFactsConsolidator'
      );
      return result;
    }

    // Cap to most recent N facts to bound O(n²) clustering
    const factsToProcess = facts.slice(0, MAX_FACTS_TO_PROCESS);

    // 2. Embed all fact values
    const texts = factsToProcess.map((f) => f.value);
    const embeddings = await getEmbeddings(texts);

    // Build list of facts that got valid embeddings
    const factsWithEmbeddings: FactWithEmbedding[] = [];
    const maxIndex = Math.min(factsToProcess.length, embeddings.length);
    for (let i = 0; i < maxIndex; i++) {
      const embedding = embeddings[i];
      const fact = factsToProcess[i];
      if (embedding && fact) {
        factsWithEmbeddings.push({
          id: fact.id,
          value: fact.value,
          embedding,
          createdAt: fact.createdAt,
        });
      }
    }

    if (factsWithEmbeddings.length === 0) {
      logger.warn(
        'No embeddings available — skipping consolidation',
        undefined,
        'WorldFactsConsolidator'
      );
      return result;
    }

    // 3. Cluster by cosine similarity
    const clusters = this.clusterFacts(factsWithEmbeddings);

    logger.info(
      'Fact clustering complete',
      {
        totalFacts: factsWithEmbeddings.length,
        clusters: clusters.length,
        multiFactClusters: clusters.filter((c) => c.length >= MIN_CLUSTER_SIZE)
          .length,
      },
      'WorldFactsConsolidator'
    );

    // 4. Consolidate each multi-fact cluster
    for (const cluster of clusters) {
      if (cluster.length < MIN_CLUSTER_SIZE) continue;

      const consolidatedText = await this.consolidateCluster(cluster);

      if (!consolidatedText) {
        // LLM failed — keep originals active, skip this cluster
        result.skipped += cluster.length;
        continue;
      }

      // 5. Quality gate on consolidated output (source = original cluster texts)
      const clusterSource = cluster.map((f) => f.value).join(' ');
      const quality = await ContentQualityGate.validateWorldFact(
        consolidatedText,
        clusterSource
      );

      if (quality.passed) {
        // Store consolidated fact
        const keyWords = consolidatedText
          .toLowerCase()
          .split(/\s+/)
          .slice(0, 5)
          .join('_')
          .replace(/[^a-z0-9_]/g, '')
          .substring(0, 50);

        const key = `consolidated_${keyWords}_${Date.now()}`;
        const label =
          consolidatedText.length > 60
            ? `${consolidatedText.substring(0, 57)}...`
            : consolidatedText;

        const clusterIds = cluster.map((f) => f.id);

        // Wrap insert + archive in transaction for data consistency
        await db.transaction(async (tx) => {
          await tx.insert(worldFacts).values({
            id: await generateSnowflakeId(),
            category: 'general',
            key,
            label,
            value: consolidatedText,
            source: 'consolidated',
            priority: 1,
            qualityScore: quality.score,
            generationDepth: 1, // Quality-gated LLM synthesis — included in prompts to replace archived originals
            isActive: true,
            lastUpdated: new Date(),
            updatedAt: new Date(),
          });

          // Archive originals within same transaction
          if (clusterIds.length > 0) {
            await tx
              .update(worldFacts)
              .set({ isActive: false, updatedAt: new Date() })
              .where(
                and(
                  eq(worldFacts.isActive, true),
                  inArray(worldFacts.id, clusterIds)
                )
              );
          }
        });

        result.consolidated++;
        result.archived += clusterIds.length;
      } else {
        // Keep originals active — better than no context at all.
        // Read-side qualityScore filter catches contaminated individuals.
        // Next consolidation sweep will retry this cluster.
        logger.warn(
          'Consolidated fact failed quality gate — keeping originals active',
          { reasons: quality.reasons, clusterSize: cluster.length },
          'WorldFactsConsolidator'
        );
        result.skipped += cluster.length;
      }
    }

    logger.info(
      'Consolidation sweep complete',
      result,
      'WorldFactsConsolidator'
    );

    return result;
  }

  /**
   * Cluster facts by pairwise cosine similarity using union-find.
   * Facts with similarity > SIMILARITY_THRESHOLD end up in the same cluster.
   *
   * Complexity: O(n²) pairwise comparisons where n ≤ MAX_FACTS_TO_PROCESS (100).
   * At n=100 this is 4,950 comparisons of ~1,536-dim vectors — sub-second on
   * modern hardware. If MAX_FACTS_TO_PROCESS increases beyond ~500, consider
   * switching to an approximate nearest-neighbor approach (e.g. HNSW via
   * hnswlib-node) to keep clustering time bounded.
   */
  private clusterFacts(facts: FactWithEmbedding[]): FactWithEmbedding[][] {
    const n = facts.length;
    const parent = Array.from({ length: n }, (_, i) => i);

    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]!]!; // path compression
        x = parent[x]!;
      }
      return x;
    };

    const union = (a: number, b: number): void => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent[rootA] = rootB;
    };

    // Pairwise similarity comparison
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const fi = facts[i]!;
        const fj = facts[j]!;
        const sim = cosineSimilarity(fi.embedding, fj.embedding);
        if (sim >= SIMILARITY_THRESHOLD) {
          union(i, j);
        }
      }
    }

    // Group by root
    const groups = new Map<number, FactWithEmbedding[]>();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      if (!groups.has(root)) {
        groups.set(root, []);
      }
      groups.get(root)!.push(facts[i]!);
    }

    return Array.from(groups.values());
  }

  /**
   * Use LLM to consolidate a cluster of similar facts into one concise fact.
   * Returns null if the LLM call fails.
   */
  private async consolidateCluster(
    cluster: FactWithEmbedding[]
  ): Promise<string | null> {
    const factList = cluster.map((f, i) => `${i + 1}. ${f.value}`).join('\n');

    const prompt = `These world facts describe overlapping or related topics. Write a single concise fact (1-2 sentences) that captures the key information from all of them. Preserve specific names, numbers, and outcomes. Do not invent new information.

FACTS:
${factList}

Respond with ONLY this exact XML structure (no other text):
<response>
  <fact>Your consolidated fact here</fact>
</response>`;

    try {
      const response = await this.llm.generateJSON<
        { fact: string } | { response: { fact: string } }
      >(
        prompt,
        {
          properties: {
            fact: { type: 'string' },
          },
          required: ['fact'],
        },
        {
          temperature: 0.3,
          maxTokens: 200,
          format: 'xml',
          promptType: 'world_facts_consolidation',
        }
      );

      const data =
        'response' in response && response.response
          ? response.response
          : (response as { fact: string });

      return data.fact?.trim() || null;
    } catch (error) {
      logger.error(
        'Failed to consolidate fact cluster',
        {
          error: error instanceof Error ? error.message : String(error),
          clusterSize: cluster.length,
        },
        'WorldFactsConsolidator'
      );
      return null;
    }
  }
}
