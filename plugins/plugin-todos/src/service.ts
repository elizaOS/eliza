/**
 * AgentRuntime lifecycle adapter for the canonical tenant-scoped TodoStore.
 * Dedicated hosts obtain the Drizzle connection from plugin-sql while Worker
 * hosts construct the same store directly through the edge export.
 */
import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { createTodosSqlStore } from "./sql-store.js";
import type { TodoStore } from "./store.js";
import { TODOS_LOG_PREFIX, TODOS_SERVICE_TYPE } from "./types.js";

export class TodosService extends Service implements TodoStore {
  static override readonly serviceType = TODOS_SERVICE_TYPE;

  override capabilityDescription =
    "User-scoped todo CRUD. Persistent (drizzle/postgres), keyed by (agentId, entityId).";

  readonly applyMutation: TodoStore["applyMutation"];
  readonly listMutationRecords: TodoStore["listMutationRecords"];
  readonly importMutationRecords: TodoStore["importMutationRecords"];
  readonly create: TodoStore["create"];
  readonly get: TodoStore["get"];
  readonly list: TodoStore["list"];
  readonly update: TodoStore["update"];
  readonly delete: TodoStore["delete"];
  readonly writeList: TodoStore["writeList"];
  readonly clear: TodoStore["clear"];

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) {
      throw new Error(`${TODOS_LOG_PREFIX} runtime is required`);
    }
    const db = runtime.db as NodePgDatabase | undefined;
    if (!db) {
      throw new Error(
        `${TODOS_LOG_PREFIX} runtime.db is not available — @elizaos/plugin-sql must be installed and initialized.`,
      );
    }
    const store = createTodosSqlStore(db);
    this.applyMutation = store.applyMutation.bind(store);
    this.listMutationRecords = store.listMutationRecords.bind(store);
    this.importMutationRecords = store.importMutationRecords.bind(store);
    this.create = store.create.bind(store);
    this.get = store.get.bind(store);
    this.list = store.list.bind(store);
    this.update = store.update.bind(store);
    this.delete = store.delete.bind(store);
    this.writeList = store.writeList.bind(store);
    this.clear = store.clear.bind(store);
  }

  static async start(runtime: IAgentRuntime): Promise<TodosService> {
    logger.info(`${TODOS_LOG_PREFIX} starting TodosService`);
    return new TodosService(runtime);
  }

  override async stop(): Promise<void> {
    logger.info(`${TODOS_LOG_PREFIX} stopping TodosService`);
  }
}

export {
  createTodosSqlStore,
  deserializeTodoMutationRecord,
  importTodoMutationRecordsInTransaction,
  serializeTodoMutationRecord,
} from "./sql-store.js";
export {
  type CreateTodoInput,
  findDuplicateTodoId,
  isValidTodoListLimit,
  TODO_DUPLICATE_ID_ERROR_CODE,
  TODO_IDEMPOTENCY_CONFLICT_ERROR_CODE,
  TODO_INVALID_PARENT_ERROR_CODE,
  TODO_LIST_LIMIT_ERROR_CODE,
  TODO_PARENT_CYCLE_ERROR_CODE,
  type TodoFilter,
  type TodoMutation,
  type TodoMutationExecution,
  type TodoMutationImportInput,
  type TodoMutationInput,
  type TodoMutationRecord,
  type TodoMutationRecordWire,
  type TodoMutationResult,
  type TodoScope,
  type TodoStore,
  type UpdateTodoInput,
  type WriteTodoListInput,
} from "./store.js";

export function getTodosService(runtime: IAgentRuntime): TodosService {
  const service = runtime.getService<TodosService>(TODOS_SERVICE_TYPE);
  if (!service) {
    throw new Error(
      `${TODOS_LOG_PREFIX} TodosService is not registered — ensure @elizaos/plugin-todos is enabled.`,
    );
  }
  return service;
}
