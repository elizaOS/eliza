import { describe, expect, it } from "vitest";
import { FamilyCommunicationsRepository } from "./family-communications/repository.ts";
import { FoodRepository } from "./food/repository.ts";
import { HouseholdOperationsRepository } from "./household-operations/repository.ts";
import { ResourceCapacityRepository } from "./resource-capacity/repository.ts";

const agentId = "00000000-0000-0000-0000-000000000001";
type SchemaRepository = { ensureSchema(): Promise<void> };
type RepositoryFactory = (runtime: never, agentId: string) => SchemaRepository;

const repositories: Array<[string, RepositoryFactory]> = [
  ["FoodRepository", (r, a) => new FoodRepository(r, a)],
  [
    "FamilyCommunicationsRepository",
    (r, a) => new FamilyCommunicationsRepository(r, a),
  ],
  [
    "HouseholdOperationsRepository",
    (r, a) => new HouseholdOperationsRepository(r, a),
  ],
  [
    "ResourceCapacityRepository",
    (r, a) => new ResourceCapacityRepository(r, a),
  ],
];

describe("LifeOps repository schema initialization", () => {
  it.each(repositories)(
    "%s retries ensureSchema after a failed attempt instead of replaying it",
    async (name, create) => {
      let statements = 0;
      const runtime: { agentId: string; adapter: { db?: unknown } } = {
        agentId,
        adapter: {},
      };
      const repository = create(runtime as never, agentId);
      const outcomes: string[] = [];
      const attempt = async () => {
        try {
          await repository.ensureSchema();
          outcomes.push("ok");
        } catch (error) {
          outcomes.push(`rejected(${(error as Error).message})`);
        }
      };

      // Boot ordering: the service asks for its schema before the DB is attached.
      await attempt();
      runtime.adapter.db = {
        execute: async () => {
          statements += 1;
          return { rows: [] };
        },
      };
      await attempt();
      await attempt();
      console.log(
        `${name}: ${outcomes.join(" -> ")} | DDL statements run after DB ready: ${statements}`,
      );

      expect(outcomes[0]).toMatch(/^rejected/);
      expect(outcomes.slice(1)).toEqual(["ok", "ok"]);
      expect(statements).toBeGreaterThan(0);
    },
  );
});
