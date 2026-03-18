// @vitest-environment jsdom
import crypto from "node:crypto";
import {
  type CreateTriggerRequest,
  ElizaClient,
  type TriggerHealthSnapshot,
  type TriggerRunRecord,
  type TriggerSummary,
  type UpdateTriggerRequest,
} from "@elizaos/app-core/api";
import React, {
  type ReactElement,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { mockUseApp } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
}));

import { TriggersView } from "../../src/components/TriggersView";

interface TriggerViewContextShape {
  triggers: TriggerSummary[];
  triggersLoading: boolean;
  triggersSaving: boolean;
  triggerRunsById: Record<string, TriggerRunRecord[]>;
  triggerHealth: TriggerHealthSnapshot | null;
  triggerError: string | null;
  loadTriggers: () => Promise<void>;
  createTrigger: (
    request: CreateTriggerRequest,
  ) => Promise<TriggerSummary | null>;
  updateTrigger: (
    id: string,
    request: UpdateTriggerRequest,
  ) => Promise<TriggerSummary | null>;
  deleteTrigger: (id: string) => Promise<boolean>;
  runTriggerNow: (id: string) => Promise<boolean>;
  loadTriggerRuns: (id: string) => Promise<void>;
  loadTriggerHealth: () => Promise<void>;
}

type UUID = string;

type TaskMetadataValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | TaskMetadataValue[]
  | { [key: string]: TaskMetadataValue };

interface TaskRecord {
  id?: UUID;
  name: string;
  description?: string;
  tags?: string[];
  roomId?: UUID;
  metadata?: { [key: string]: TaskMetadataValue };
}

interface RuntimeLike {
  agentId: UUID;
  character: { name: string };
  getSetting: (key: string) => string | number | boolean | undefined;
  getService: (serviceType: string) => object | null;
  getTasks: (query?: { tags?: string[] }) => Promise<TaskRecord[]>;
  getTask: (taskId: UUID) => Promise<TaskRecord | null>;
  getRoomsByWorld: () => Promise<object[]>;
  createTask: (task: TaskRecord) => Promise<UUID>;
  updateTask: (taskId: UUID, update: Partial<TaskRecord>) => Promise<void>;
  deleteTask: (taskId: UUID) => Promise<void>;
  createMemory: () => Promise<void>;
  getTaskWorker: () => null;
  registerTaskWorker: () => void;
  logger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

interface TriggerRuntimeHarness {
  runtime: RuntimeLike;
  injectAutonomousInstruction: ReturnType<typeof vi.fn>;
}

function createTriggerRuntimeHarness(): TriggerRuntimeHarness {
  let tasks: TaskRecord[] = [];
  const injectAutonomousInstruction = vi.fn(
    async (_params: {
      instructions: string;
      source: string;
      wakeMode: "inject_now" | "next_autonomy_cycle";
      triggerId: UUID;
      triggerTaskId: UUID;
    }) => undefined,
  );

  const runtime: RuntimeLike = {
    agentId: "00000000-0000-0000-0000-000000000001",
    character: { name: "TriggerUiE2E" },
    getSetting: (_key: string) => undefined,
    getService: (serviceType: string) => {
      if (serviceType.toUpperCase() !== "AUTONOMY") return null;
      return {
        getAutonomousRoomId: () => "00000000-0000-0000-0000-000000000201",
        injectAutonomousInstruction,
      } as {
        getAutonomousRoomId: () => UUID;
        injectAutonomousInstruction: (params: {
          instructions: string;
          source: string;
          wakeMode: "inject_now" | "next_autonomy_cycle";
          triggerId: UUID;
          triggerTaskId: UUID;
        }) => Promise<void>;
      };
    },
    getTasks: async (query?: { tags?: string[] }) => {
      if (!query?.tags || query.tags.length === 0) return tasks;
      return tasks.filter((task) =>
        query.tags?.every((tag) => task.tags?.includes(tag)),
      );
    },
    getTask: async (taskId: UUID) =>
      tasks.find((task) => task.id === taskId) ?? null,
    getRoomsByWorld: async () => [],
    createTask: async (task: TaskRecord) => {
      const id = crypto.randomUUID();
      const created: TaskRecord = {
        ...task,
        id,
      };
      tasks.push(created);
      return id;
    },
    updateTask: async (taskId: UUID, update: Partial<TaskRecord>) => {
      tasks = tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              ...update,
              metadata: {
                ...(task.metadata ?? {}),
                ...(update.metadata ?? {}),
              },
            }
          : task,
      );
    },
    deleteTask: async (taskId: UUID) => {
      tasks = tasks.filter((task) => task.id !== taskId);
    },
    createMemory: vi.fn(async () => undefined),
    getTaskWorker: () => null,
    registerTaskWorker: () => undefined,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };

  return {
    runtime,
    injectAutonomousInstruction,
  };
}

function sortTriggers(items: TriggerSummary[]): TriggerSummary[] {
  return [...items].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function TriggerUiHarness(props: { client: ElizaClient }): ReactElement {
  const { client } = props;
  const [triggers, setTriggers] = useState<TriggerSummary[]>([]);
  const [triggersLoading, setTriggersLoading] = useState(false);
  const [triggersSaving, setTriggersSaving] = useState(false);
  const [triggerRunsById, setTriggerRunsById] = useState<
    Record<string, TriggerRunRecord[]>
  >({});
  const [triggerHealth, setTriggerHealth] =
    useState<TriggerHealthSnapshot | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const triggerLoadRequestId = useRef(0);

  const loadTriggers = useCallback(async () => {
    const requestId = ++triggerLoadRequestId.current;
    setTriggersLoading(true);
    try {
      const response = await client.getTriggers();
      if (requestId !== triggerLoadRequestId.current) return;
      setTriggers(sortTriggers(response.triggers));
      setTriggerError(null);
    } catch (error) {
      if (requestId !== triggerLoadRequestId.current) return;
      const message =
        error instanceof Error ? error.message : "Failed to load triggers";
      setTriggerError(message);
      setTriggers([]);
    } finally {
      // Keep stale responses from overwriting data, but let any completed
      // request clear the spinner so duplicate mount loads cannot pin it.
      setTriggersLoading(false);
    }
  }, [client]);

  const loadTriggerHealth = useCallback(async () => {
    try {
      const health = await client.getTriggerHealth();
      setTriggerHealth(health);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to load trigger health";
      setTriggerError(message);
      setTriggerHealth(null);
    }
  }, [client]);

  const loadTriggerRuns = useCallback(
    async (id: string) => {
      try {
        const response = await client.getTriggerRuns(id);
        setTriggerRunsById((prev) => ({
          ...prev,
          [id]: response.runs,
        }));
        setTriggerError(null);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load trigger runs";
        setTriggerError(message);
      }
    },
    [client],
  );

  const createTrigger = useCallback(
    async (request: CreateTriggerRequest): Promise<TriggerSummary | null> => {
      setTriggersSaving(true);
      try {
        const response = await client.createTrigger(request);
        const created = response.trigger;
        await loadTriggers();
        setTriggerError(null);
        await loadTriggerHealth();
        return created;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to create trigger";
        setTriggerError(message);
        return null;
      } finally {
        setTriggersSaving(false);
      }
    },
    [client, loadTriggerHealth, loadTriggers],
  );

  const updateTrigger = useCallback(
    async (
      id: string,
      request: UpdateTriggerRequest,
    ): Promise<TriggerSummary | null> => {
      setTriggersSaving(true);
      try {
        const response = await client.updateTrigger(id, request);
        const updated = response.trigger;
        await loadTriggers();
        setTriggerError(null);
        await loadTriggerHealth();
        return updated;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to update trigger";
        setTriggerError(message);
        return null;
      } finally {
        setTriggersSaving(false);
      }
    },
    [client, loadTriggerHealth, loadTriggers],
  );

  const deleteTrigger = useCallback(
    async (id: string): Promise<boolean> => {
      setTriggersSaving(true);
      try {
        await client.deleteTrigger(id);
        await loadTriggers();
        setTriggerRunsById((prev) => {
          const next: Record<string, TriggerRunRecord[]> = {};
          for (const [key, value] of Object.entries(prev)) {
            if (key !== id) next[key] = value;
          }
          return next;
        });
        setTriggerError(null);
        await loadTriggerHealth();
        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to delete trigger";
        setTriggerError(message);
        return false;
      } finally {
        setTriggersSaving(false);
      }
    },
    [client, loadTriggerHealth, loadTriggers],
  );

  const runTriggerNow = useCallback(
    async (id: string): Promise<boolean> => {
      setTriggersSaving(true);
      try {
        const response = await client.runTriggerNow(id);
        await loadTriggers();
        await loadTriggerRuns(id);
        await loadTriggerHealth();
        setTriggerError(null);
        return response.ok;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to run trigger";
        setTriggerError(message);
        return false;
      } finally {
        setTriggersSaving(false);
      }
    },
    [client, loadTriggerHealth, loadTriggerRuns, loadTriggers],
  );

  const appContext = useMemo<TriggerViewContextShape>(
    () => ({
      t: (k: string) => k,
      triggers,
      triggersLoading,
      triggersSaving,
      triggerRunsById,
      triggerHealth,
      triggerError,
      loadTriggers,
      createTrigger,
      updateTrigger,
      deleteTrigger,
      runTriggerNow,
      loadTriggerRuns,
      loadTriggerHealth,
    }),
    [
      triggers,
      triggersLoading,
      triggersSaving,
      triggerRunsById,
      triggerHealth,
      triggerError,
      loadTriggers,
      createTrigger,
      updateTrigger,
      deleteTrigger,
      runTriggerNow,
      loadTriggerRuns,
      loadTriggerHealth,
    ],
  );

  mockUseApp.mockReturnValue(appContext);
  return React.createElement(TriggersView);
}

function nodeText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => {
      if (typeof child === "string") return child;
      return nodeText(child);
    })
    .join("")
    .trim();
}

function findButtonByText(
  root: TestRenderer.ReactTestInstance,
  label: string,
): TestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) => node.type === "button" && nodeText(node).includes(label),
  );
  if (!matches[0]) throw new Error(`Button "${label}" not found`);
  return matches[0];
}

function findInputByPlaceholder(
  root: TestRenderer.ReactTestInstance,
  placeholder: string,
): TestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) => node.type === "input" && node.props.placeholder === placeholder,
  );
  if (!matches[0]) throw new Error(`Input "${placeholder}" not found`);
  return matches[0];
}

function findTextareaByPlaceholder(
  root: TestRenderer.ReactTestInstance,
  placeholder: string,
): TestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) =>
      node.type === "textarea" && node.props.placeholder === placeholder,
  );
  if (!matches[0]) throw new Error(`Textarea "${placeholder}" not found`);
  return matches[0];
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  attempts = 100,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(message);
}

describe("TriggersView UI E2E", () => {
  let server: { port: number; close: () => Promise<void> } | null = null;
  let runtimeHarness: TriggerRuntimeHarness;
  let startApiServerFn:
    | typeof import("../../../../src/api/server").startApiServer
    | null = null;

  beforeAll(async () => {
    const serverModule = await import("../../../../src/api/server");
    startApiServerFn = serverModule.startApiServer;
    if (!startApiServerFn) {
      throw new Error("Failed to load startApiServer");
    }

    runtimeHarness = createTriggerRuntimeHarness();
    server = await startApiServerFn({
      port: 0,
      runtime: runtimeHarness.runtime as Parameters<
        typeof startApiServerFn
      >[0]["runtime"],
    });
  });

  afterAll(async () => {
    if (server) {
      await server.close();
    }
  });

  beforeEach(() => {
    mockUseApp.mockReset();
    runtimeHarness.injectAutonomousInstruction.mockClear();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    Object.defineProperty(window, "scrollTo", {
      value: vi.fn(),
      writable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates, updates, executes, inspects runs, and deletes triggers via live API", async () => {
    if (!server) {
      throw new Error("Server was not initialized");
    }

    const client = new ElizaClient(`http://127.0.0.1:${server.port}`);
    const triggerDisplayName = "Trigger UI E2E";

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(TriggerUiHarness, { client }),
      );
    });
    await flush();

    const root = tree?.root;
    await waitFor(
      () =>
        root.findAll(
          (node) =>
            node.type === "button" &&
            nodeText(node).includes("heartbeatsview.newHeartbeat"),
        ).length === 1,
      "Trigger list did not finish initial loading",
    );

    await act(async () => {
      await findButtonByText(
        root,
        "heartbeatsview.newHeartbeat",
      ).props.onClick();
    });

    await waitFor(
      () =>
        root.findAll(
          (node) =>
            node.type === "button" &&
            nodeText(node).includes("heartbeatsview.createHeartbeat"),
        ).length === 1,
      "Trigger editor modal did not open",
    );

    const displayNameInput = findInputByPlaceholder(
      root,
      "triggersview.eGDailyDigestH",
    );
    const instructionsInput = findTextareaByPlaceholder(
      root,
      "triggersview.WhatShouldTheAgen",
    );

    await act(async () => {
      displayNameInput.props.onChange({
        target: { value: triggerDisplayName },
      });
      instructionsInput.props.onChange({
        target: { value: "Execute this UI E2E trigger task" },
      });
    });

    await act(async () => {
      await findButtonByText(
        root,
        "heartbeatsview.createHeartbeat",
      ).props.onClick();
    });
    await waitFor(
      () =>
        root.findAll(
          (node) =>
            node.type === "span" && nodeText(node) === triggerDisplayName,
        ).length === 1,
      "Created trigger did not appear in the list",
    );

    const renamedTriggerDisplayName = "Trigger UI E2E Updated";
    await act(async () => {
      await findButtonByText(root, "triggersview.Edit").props.onClick();
    });
    await waitFor(
      () =>
        root.findAll(
          (node) =>
            node.type === "button" &&
            nodeText(node).includes("heartbeatsview.saveChanges"),
        ).length === 1,
      "Trigger editor did not enter edit mode",
    );
    const editDisplayNameInput = findInputByPlaceholder(
      root,
      "triggersview.eGDailyDigestH",
    );

    await act(async () => {
      editDisplayNameInput.props.onChange({
        target: { value: renamedTriggerDisplayName },
      });
    });

    await act(async () => {
      await findButtonByText(
        root,
        "heartbeatsview.saveChanges",
      ).props.onClick();
    });
    await waitFor(
      () =>
        root.findAll(
          (node) =>
            node.type === "span" &&
            nodeText(node) === renamedTriggerDisplayName,
        ).length === 1,
      "Updated trigger name did not appear in the list",
    );

    await act(async () => {
      await findButtonByText(root, "triggersview.RunNow").props.onClick();
    });
    await waitFor(
      () => runtimeHarness.injectAutonomousInstruction.mock.calls.length === 1,
      "Trigger execution was not dispatched",
    );

    expect(runtimeHarness.injectAutonomousInstruction).toHaveBeenCalledTimes(1);
    await waitFor(
      () =>
        root.findAll(
          (node) =>
            node.type === "span" &&
            nodeText(node).includes("heartbeatsview.statusSuccess"),
        ).length > 0,
      "Trigger run history did not load",
    );
    const successRows = root.findAll(
      (node) =>
        node.type === "span" &&
        nodeText(node).includes("heartbeatsview.statusSuccess"),
    );
    expect(successRows.length).toBeGreaterThan(0);

    await act(async () => {
      await findButtonByText(root, "triggersview.Edit").props.onClick();
    });
    await waitFor(
      () =>
        root.findAll(
          (node) =>
            node.type === "button" &&
            nodeText(node).includes("triggersview.Delete"),
        ).length === 1,
      "Trigger editor did not reopen for delete",
    );

    await act(async () => {
      await findButtonByText(root, "triggersview.Delete").props.onClick();
    });
    await waitFor(
      () =>
        root.findAll(
          (node) =>
            node.type === "span" &&
            nodeText(node) === renamedTriggerDisplayName,
        ).length === 0,
      "Deleted trigger still appeared in the list",
    );
  });
});
