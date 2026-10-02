/** Plugin-owned metadata only. Opaque credentials are persisted in the existing vault. */
import { AsyncLocalStorage } from "node:async_hooks";
import { type DurableRecordStore, type UUID } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { pgSchema, primaryKey, text, jsonb } from "drizzle-orm/pg-core";
const schema = pgSchema("cloud_delegation");
export const delegationRecords = schema.table(
	"records",
	{
		agentId: text("agent_id").notNull(),
		namespace: text("namespace").notNull(),
		key: text("key").notNull(),
		value: jsonb("value").notNull(),
	},
	(t) => ({ pk: primaryKey({ columns: [t.agentId, t.namespace, t.key] }) }),
);
/** Serializes claims in the owning database; no process-local locking substitute. */
export class DelegationRecordStore implements DurableRecordStore {
	readonly version = 1 as const;
	private readonly active = new AsyncLocalStorage<NodePgDatabase>();
	constructor(
		readonly agentId: UUID,
		private readonly root: NodePgDatabase,
	) {}
	private db() {
		return this.active.getStore() ?? this.root;
	}
	private where(ns: string, key?: string) {
		return and(
			eq(delegationRecords.agentId, this.agentId),
			eq(delegationRecords.namespace, ns),
			...(key === undefined ? [] : [eq(delegationRecords.key, key)]),
		);
	}
	async transaction<T>(operation: () => Promise<T>): Promise<T> {
		if (this.active.getStore()) throw Error("Nested delegation transaction");
		return this.root.transaction(async (tx) => {
			const db = tx as unknown as NodePgDatabase;
			await db
				.insert(delegationRecords)
				.values({
					agentId: this.agentId,
					namespace: "__lock",
					key: "owner",
					value: {},
				})
				.onConflictDoNothing();
			await db
				.select()
				.from(delegationRecords)
				.where(this.where("__lock", "owner"))
				.for("update");
			return this.active.run(db, operation);
		});
	}
	async get<T>(ns: string, key: string): Promise<T | null> {
		const [row] = await this.db()
			.select()
			.from(delegationRecords)
			.where(this.where(ns, key));
		return row ? (row.value as T) : null;
	}
	async getAll<T>(ns: string): Promise<T[]> {
		return (
			await this.db().select().from(delegationRecords).where(this.where(ns))
		).map((r) => r.value as T);
	}
	async set<T>(ns: string, key: string, value: T) {
		await this.db()
			.insert(delegationRecords)
			.values({
				agentId: this.agentId,
				namespace: ns,
				key,
				value: value as object,
			})
			.onConflictDoUpdate({
				target: [
					delegationRecords.agentId,
					delegationRecords.namespace,
					delegationRecords.key,
				],
				set: { value: value as object },
			});
	}
	async delete(ns: string, key: string) {
		const rows = await this.db()
			.delete(delegationRecords)
			.where(this.where(ns, key))
			.returning({ key: delegationRecords.key });
		return rows.length > 0;
	}
}
