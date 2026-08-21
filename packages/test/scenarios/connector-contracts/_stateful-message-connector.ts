/** Builds deterministic contracts around the production MESSAGE action and a stateful connector boundary. */

import {
  type IAgentRuntime,
  type MessageConnectorRegistration,
  type SendHandlerOutcome,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type DispatchRecord = {
  key: string;
  providerMessageId: string;
  target: string;
  text: string;
};

type FixtureState = {
  source: string;
  accountId: string;
  threadId: string;
  recipient: string;
  inboundText: string;
  reads: number;
  sendAttempts: number;
  dispatches: DispatchRecord[];
  byKey: Map<string, DispatchRecord>;
};

const fixtureState = new WeakMap<object, FixtureState>();

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function actionParameters(
  turn: ScenarioTurnExecution,
): Record<string, unknown> {
  const action = turn.actionsCalled.find(
    (candidate) => candidate.actionName === "MESSAGE",
  );
  return record(record(action?.parameters).parameters ?? action?.parameters);
}

function assertMessageTurn(
  expected: Record<string, unknown>,
  resultFields: Record<string, unknown>,
) {
  return (turn: ScenarioTurnExecution): string | undefined => {
    const action = turn.actionsCalled.find(
      (candidate) => candidate.actionName === "MESSAGE",
    );
    if (!action) return "expected the production MESSAGE action to execute";
    const parameters = actionParameters(turn);
    for (const [key, value] of Object.entries(expected)) {
      if (JSON.stringify(parameters[key]) !== JSON.stringify(value)) {
        return `expected MESSAGE ${key}=${JSON.stringify(value)}, saw ${JSON.stringify(parameters[key])}`;
      }
    }
    const data = record(action.result?.data);
    for (const [key, value] of Object.entries(resultFields)) {
      if (JSON.stringify(data[key]) !== JSON.stringify(value)) {
        return `expected MESSAGE result.data.${key}=${JSON.stringify(value)}, saw ${JSON.stringify(data[key])}`;
      }
    }
    return undefined;
  };
}

function installConnector(config: StatefulMessageContractConfig) {
  return async (ctx: ScenarioContext): Promise<string | undefined> => {
    const runtime = ctx.runtime as IAgentRuntime;
    const accountId = `${config.source}-fixture-account`;
    const threadId = `${config.source}-thread-001`;
    const recipient = `${config.source}-recipient-001`;
    const state: FixtureState = {
      source: config.source,
      accountId,
      threadId,
      recipient,
      inboundText: config.inboundText,
      reads: 0,
      sendAttempts: 0,
      dispatches: [],
      byKey: new Map(),
    };
    fixtureState.set(runtime as object, state);

    const registration: MessageConnectorRegistration = {
      source: config.source,
      accountId,
      label: config.label,
      capabilities: ["read_messages", "send_message"],
      supportedTargetKinds: ["thread"],
      contexts: ["messaging"],
      resolveTargets: (query) => [
        {
          label: config.recipientLabel,
          kind: "thread",
          score: 1,
          target: {
            source: config.source,
            accountId,
            channelId: threadId,
            threadId,
          },
          metadata: { fixtureQuery: query },
        },
      ],
      listRecentTargets: () => [
        {
          label: config.recipientLabel,
          kind: "thread",
          score: 1,
          target: {
            source: config.source,
            accountId,
            channelId: threadId,
            threadId,
          },
        },
      ],
      fetchMessages: () => {
        state.reads += 1;
        return [
          {
            id: stringToUuid(`${config.source}:inbound:001`) as UUID,
            entityId: stringToUuid(`${config.source}:${recipient}`) as UUID,
            agentId: runtime.agentId,
            roomId: stringToUuid(`${config.source}:${threadId}`) as UUID,
            content: {
              text: config.inboundText,
              source: config.source,
            },
            metadata: {
              type: "message",
              source: config.source,
              provider: config.source,
              platformMessageId: `${config.source}-inbound-001`,
            },
            createdAt: Date.parse("2026-08-18T16:00:00.000Z"),
          },
        ];
      },
      sendHandler: async (
        _runtime,
        target,
        content,
      ): ReturnType<
        NonNullable<MessageConnectorRegistration["sendHandler"]>
      > => {
        state.sendAttempts += 1;
        const text = String(content.text ?? "");
        const targetKey = String(
          target.threadId ?? target.channelId ?? target.entityId ?? "",
        );
        const key = `${accountId}:${targetKey}:${text}`;
        const prior = state.byKey.get(key);
        if (prior) {
          return {
            kind: "duplicate",
            priorDelivery: "delivered",
            receipt: {
              providerMessageIds: [prior.providerMessageId],
              acceptedAt: Date.now(),
              persistence: { status: "persisted", memoryIds: [] },
            },
          } satisfies SendHandlerOutcome;
        }
        if (config.failFirstSend && state.sendAttempts === 1) {
          return {
            kind: "not_delivered",
            code: "TRANSIENT_PROVIDER_UNAVAILABLE",
            message:
              "fixture provider rejected the first attempt before acceptance",
          } satisfies SendHandlerOutcome;
        }
        const providerMessageId = `${config.source}-outbound-${state.dispatches.length + 1}`;
        const dispatch = { key, providerMessageId, target: targetKey, text };
        state.byKey.set(key, dispatch);
        state.dispatches.push(dispatch);
        return {
          kind: "delivered",
          receipt: {
            providerMessageIds: [providerMessageId],
            acceptedAt: Date.now(),
            persistence: {
              status: "not_attempted",
              reason: "the MESSAGE action owns canonical outbound persistence",
            },
          },
          memories: [],
        } satisfies SendHandlerOutcome;
      },
    };
    runtime.registerMessageConnector(registration);
    return undefined;
  };
}

function assertFixture(config: StatefulMessageContractConfig) {
  return async (ctx: ScenarioContext): Promise<string | undefined> => {
    const state = fixtureState.get(ctx.runtime as object);
    if (!state) return `stateful ${config.source} fixture was not installed`;
    if (state.reads !== 1) {
      return `expected exactly one fixture read, saw ${state.reads}`;
    }
    if (state.dispatches.length !== 1) {
      return `expected exactly one provider dispatch, saw ${state.dispatches.length}`;
    }
    const expectedAttempts = config.failFirstSend ? 3 : config.replay ? 2 : 1;
    if (state.sendAttempts !== expectedAttempts) {
      return `expected ${expectedAttempts} provider attempts, saw ${state.sendAttempts}`;
    }
    const [dispatch] = state.dispatches;
    if (dispatch.target !== state.threadId) {
      return `dispatch target ${dispatch.target} did not match ${state.threadId}`;
    }
    if (dispatch.text !== config.outboundText) {
      return `dispatch body ${JSON.stringify(dispatch.text)} did not match ${JSON.stringify(config.outboundText)}`;
    }
    const successfulSend = ctx.actionsCalled.find((candidate) => {
      if (
        candidate.actionName !== "MESSAGE" ||
        candidate.result?.success !== true
      )
        return false;
      const data = record(candidate.result.data);
      return data.operation === "send" && data.deliveryStatus === "delivered";
    });
    const data = record(successfulSend?.result?.data);
    const memoryId = data.memoryId;
    if (typeof memoryId !== "string" || memoryId.length === 0) {
      return `successful MESSAGE send omitted its durable memoryId: ${JSON.stringify(data)}`;
    }
    const runtime = ctx.runtime as IAgentRuntime;
    const persisted = await runtime.getMemoryById(memoryId as UUID);
    if (!persisted)
      return `durable outbound memory ${memoryId} was not readable`;
    if (persisted.content.text !== config.outboundText) {
      return `durable outbound memory body did not match: ${JSON.stringify(persisted.content)}`;
    }
    const metadata = record(persisted.metadata);
    if (
      metadata.platformMessageId !== dispatch.providerMessageId ||
      metadata.provider !== config.source
    ) {
      return `durable outbound receipt was not provider-bound: ${JSON.stringify(metadata)}`;
    }
    return undefined;
  };
}

export type StatefulMessageContractConfig = {
  evidenceScope: "connector-contract";
  id: string;
  title: string;
  source: string;
  label: string;
  recipientLabel: string;
  inboundText: string;
  outboundText: string;
  replay?: boolean;
  failFirstSend?: boolean;
  domain?: string;
  additionalTags?: string[];
  description?: string;
};

export function buildStatefulMessageConnectorScenario(
  config: StatefulMessageContractConfig,
) {
  const accountId = `${config.source}-fixture-account`;
  const threadId = `${config.source}-thread-001`;
  const sendOptions = {
    parameters: {
      action: "send",
      source: config.source,
      accountId,
      target: config.recipientLabel,
      targetKind: "thread",
      message: config.outboundText,
    },
  };
  return scenario({
    id: config.id,
    title: config.title,
    domain: config.domain ?? "connector-contract",
    lane: "pr-deterministic",
    executionProfile: "simulated",
    evidenceScope: config.evidenceScope,
    tags: [
      "connector-contract",
      "simulated-connector-contract",
      config.source,
      `connector-contract-axis:${config.replay ? "retry-idempotent" : "core"}`,
      "stateful-message-connector",
      ...(config.additionalTags ?? []),
    ],
    description:
      config.description ??
      `Deterministic domain contract for the production MESSAGE action over a stateful ${config.label} fixture. It proves exact account/thread binding, fixture receipts, durable outbound persistence, and replay safety; it does not exercise the external service.`,
    isolation: "per-scenario",
    requires: { plugins: ["@elizaos/plugin-agent-skills"] },
    seed: [
      {
        type: "custom",
        name: `install ${config.source} fixture`,
        apply: installConnector(config),
      },
    ],
    rooms: [
      {
        id: "main",
        source: "dashboard",
        channelType: "DM",
        title: config.title,
      },
    ],
    turns: [
      {
        kind: "action",
        name: `${config.source}-read`,
        room: "main",
        actionName: "MESSAGE",
        text: `Read the exact ${config.label} fixture thread.`,
        content: {
          metadata: {
            __responseContext: { primaryContext: "messaging" },
          },
        },
        options: {
          parameters: {
            action: "read_channel",
            source: config.source,
            accountId,
            channel: threadId,
            limit: 10,
          },
        },
        assertTurn: assertMessageTurn(
          {
            action: "read_channel",
            source: config.source,
            accountId,
            channel: threadId,
          },
          { operation: "read_channel", source: config.source },
        ),
        responseIncludesAll: ["Read 1 messages", config.label],
      },
      ...(config.failFirstSend
        ? [
            {
              kind: "action" as const,
              name: `${config.source}-send-first-transient-failure`,
              room: "main",
              actionName: "MESSAGE",
              text: `Attempt the exact approved reply through ${config.label}; the provider will reject this first attempt before acceptance.`,
              content: {
                metadata: {
                  __responseContext: { primaryContext: "messaging" },
                },
              },
              options: sendOptions,
              assertTurn: assertMessageTurn(
                { action: "send", source: config.source, accountId },
                {
                  operation: "send",
                  deliveryStatus: "not_delivered",
                  persisted: false,
                },
              ),
            },
          ]
        : []),
      {
        kind: "action",
        name: `${config.source}-send`,
        room: "main",
        actionName: "MESSAGE",
        text: `Send the exact approved reply through ${config.label}.`,
        content: {
          metadata: {
            __responseContext: { primaryContext: "messaging" },
          },
        },
        options: sendOptions,
        assertTurn: assertMessageTurn(
          {
            action: "send",
            source: config.source,
            accountId,
            target: config.recipientLabel,
          },
          {
            operation: "send",
            source: config.source,
            deliveryStatus: "delivered",
          },
        ),
      },
      ...(config.replay
        ? [
            {
              kind: "action" as const,
              name: `${config.source}-replay`,
              room: "main",
              actionName: "MESSAGE",
              text: `Replay the exact same ${config.label} request with the same body.`,
              content: {
                metadata: {
                  __responseContext: { primaryContext: "messaging" },
                },
              },
              options: sendOptions,
              assertTurn: assertMessageTurn(
                { action: "send", source: config.source, accountId },
                {
                  operation: "send",
                  deliveryStatus: "duplicate",
                  newDelivery: false,
                },
              ),
            },
          ]
        : []),
    ],
    finalChecks: [
      {
        type: "actionCalled",
        actionName: "MESSAGE",
        status: "success",
        minCount: config.replay ? 3 : 2,
      },
      ...(config.failFirstSend
        ? [
            {
              type: "actionCalled" as const,
              actionName: "MESSAGE",
              status: "failure" as const,
              minCount: 1,
            },
          ]
        : []),
      {
        type: "messageDelivered",
        channel: config.source,
        turn: `${config.source}-send`,
        expected: true,
      },
      {
        type: "custom",
        name: `${config.id}-fixture-ledger`,
        predicate: assertFixture(config),
      },
    ],
  });
}
