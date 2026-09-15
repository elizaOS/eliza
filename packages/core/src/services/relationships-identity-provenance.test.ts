import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import type { IAgentRuntime, UUID } from "../types/index.ts";
import { RelationshipsService } from "./relationships.ts";

const AGENT = "00000000-0000-4000-8000-000000000001" as UUID;
const ENTITY = "00000000-0000-4000-8000-000000000002" as UUID;
const FIRST = "00000000-0000-4000-8000-000000000003" as UUID;
const SECOND = "00000000-0000-4000-8000-000000000004" as UUID;

describe("Identity ownership at the SQL write boundary", () => {
	it.each(["manual", "import", undefined, "reflection"])(
		"preserves existing %s ownership when reflection strengthens a claim",
		async (source) => {
			const client = new PGlite();
			try {
				await client.exec(`CREATE TABLE entity_identities (
					id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
					entity_id uuid NOT NULL, agent_id uuid NOT NULL,
					platform text NOT NULL, handle text NOT NULL,
					verified boolean NOT NULL, confidence real NOT NULL, source text,
					first_seen timestamptz NOT NULL, last_seen timestamptz NOT NULL,
					evidence_message_ids jsonb,
					CONSTRAINT unique_entity_identity UNIQUE(entity_id, platform, handle, agent_id)
				)`);
				const service = new RelationshipsService({
					agentId: AGENT,
					adapter: { db: drizzle(client) },
				} as unknown as IAgentRuntime);
				await service.upsertIdentity(
					ENTITY,
					{
						platform: "github",
						handle: "example",
						confidence: 0.7,
						source,
					},
					[FIRST],
				);
				await service.upsertIdentity(
					ENTITY,
					{
						platform: "github",
						handle: "example",
						confidence: 0.8,
						source: "reflection",
					},
					[SECOND],
				);
				const [identity] = await service.getEntityIdentities(ENTITY);
				expect(identity.source).toBe(source);
				expect(identity.confidence).toBeCloseTo(0.8);
				expect(new Set(identity.evidenceMessageIds)).toEqual(
					new Set([FIRST, SECOND]),
				);
				// A later explicit verification still takes ownership of the claim.
				await service.upsertIdentity(ENTITY, {
					platform: "github",
					handle: "example",
					confidence: 0.9,
					verified: true,
					source: "manual",
				});
				await service.upsertIdentity(
					ENTITY,
					{
						platform: "github",
						handle: "example",
						confidence: 0.8,
						source: "reflection",
					},
					[SECOND],
				);
				expect((await service.getEntityIdentities(ENTITY))[0]).toMatchObject({
					source: "manual",
					verified: true,
					confidence: expect.closeTo(0.9),
				});
			} finally {
				await client.close();
			}
		},
	);
});
