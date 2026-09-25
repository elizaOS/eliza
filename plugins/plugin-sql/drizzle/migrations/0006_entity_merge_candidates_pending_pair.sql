DELETE FROM entity_merge_candidates AS newer
	USING entity_merge_candidates AS older
	WHERE newer.status = 'pending'
		AND older.status = 'pending'
		AND newer.agent_id = older.agent_id
		AND newer.entity_a = older.entity_a
		AND newer.entity_b = older.entity_b
		AND (newer.proposed_at, newer.id) > (older.proposed_at, older.id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_entity_merge_candidates_pending_pair"
	ON "entity_merge_candidates" USING btree ("agent_id", "entity_a", "entity_b")
	WHERE "status" = 'pending';
