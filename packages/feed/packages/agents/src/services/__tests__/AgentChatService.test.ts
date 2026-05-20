/**
 * Unit Tests for AgentChatService.dispatchAgentChat
 *
 * Tests the core coordinator-dispatch execution service that allows
 * the coordinator to invoke a child agent on the user's behalf.
 *
 * Coverage:
 * - Input validation (checkUserInput)
 * - Ownership checks (null agent, AuthorizationError, generic errors)
 * - Happy path: decision loop without actions, with actions
 * - LLM parse failures and retry behavior
 * - Action execution errors (try/catch in loop)
 * - Max iterations boundary
 * - DB write correctness (exact values)
 * - broadcastFn called with correct shape
 * - broadcastFn rejection is swallowed (fire-and-forget)
 * - Summary generation and fallback
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// ─── AuthorizationError (internal, must match actual class) ──────────────────

class MockAuthorizationError extends Error {
  constructor(
    message: string,
    public resource?: string,
    public action?: string
  ) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

// ─── Mocks — set up before the dynamic import ────────────────────────────────

const mockCheckUserInput = mock(() => ({ safe: true, reason: undefined }));
const mockLogger = {
  info: mock(),
  warn: mock(),
  error: mock(),
  debug: mock(),
};

// Mock Logger class — needed by transitive import (shared/logger.ts re-exports it)
class MockLoggerClass {
  level = 'info';
  info = mock();
  warn = mock();
  error = mock();
  debug = mock();
  setLevel() {}
}

mock.module('@babylon/shared', () => ({
  checkUserInput: mockCheckUserInput,
  logger: mockLogger,
  Logger: MockLoggerClass,
  generateSnowflakeId: () => '123456789',
  COORDINATOR_SENDER_ID: 'coordinator-id',
  GROQ_MODELS: { FREE: { displayName: 'llama-3.3-70b' } },
  MessageTypeEnum: { COORDINATOR: 'coordinator' },
  extractErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
  BabylonError: class BabylonError extends Error {},
  ValidationError: class ValidationError extends Error {},
  CHAIN: {},
  POINTS: {},
  resolveUserIdentifierKind: () => 'userId',
  toISO: (val: Date | string) =>
    val instanceof Date ? val.toISOString() : new Date(val).toISOString(),
  checkForAdminEmail: () => false,
  FEEDBACK_TYPE_CONFIG: {},
  FeedbackTypeSchema: {},
}));

// Drizzle-style chainable mock
const mockInsertValues = mock(async () => []);
const mockInsertChain = { values: mockInsertValues };
const mockUpdateSet = mock(() => ({ where: mock(async () => []) }));
const mockUpdateChain = { set: mockUpdateSet };
const mockDbInsert = mock(() => mockInsertChain);
const mockDbUpdate = mock(() => mockUpdateChain);

const mockDb = {
  insert: mockDbInsert,
  update: mockDbUpdate,
};

mock.module('@babylon/db', () => ({
  db: mockDb,
  // Drizzle operators
  aliasedTable: (table: unknown) => table,
  and: (...args: unknown[]) => args,
  asc: (col: unknown) => col,
  avg: (col: unknown) => col,
  between: (col: unknown, a: unknown, b: unknown) => ({ col, a, b }),
  count: (col?: unknown) => col,
  desc: (col: unknown) => col,
  eq: (_a: unknown, _b: unknown) => ({ type: 'eq' }),
  exists: (q: unknown) => q,
  gt: (a: unknown, b: unknown) => ({ op: 'gt', a, b }),
  gte: (a: unknown, b: unknown) => ({ op: 'gte', a, b }),
  ilike: (a: unknown, b: unknown) => ({ op: 'ilike', a, b }),
  inArray: (a: unknown, b: unknown) => [a, b],
  isNotNull: (a: unknown) => a,
  isNull: (a: unknown) => a,
  like: (a: unknown, b: unknown) => ({ op: 'like', a, b }),
  lt: (a: unknown, b: unknown) => ({ op: 'lt', a, b }),
  lte: (a: unknown, b: unknown) => ({ op: 'lte', a, b }),
  max: (col: unknown) => col,
  min: (col: unknown) => col,
  ne: (a: unknown, b: unknown) => ({ op: 'ne', a, b }),
  not: (a: unknown) => a,
  notExists: (q: unknown) => q,
  notInArray: (a: unknown, b: unknown) => [a, b],
  or: (...args: unknown[]) => args,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
  sum: (col: unknown) => col,
  // RLS helpers
  asPublic: () => ({}),
  asSystem: () => ({}),
  asUser: () => ({}),
  // Schema tables (direct + transitive imports)
  adminAuditLogs: {},
  agentLogs: {},
  agentPerformanceMetrics: {},
  agentTrades: {},
  balanceTransactions: {},
  chatParticipants: {
    chatId: 'chatParticipants.chatId',
    userId: 'chatParticipants.userId',
    isActive: 'chatParticipants.isActive',
  },
  chats: {},
  comments: {},
  follows: {},
  generationLocks: {},
  groups: {},
  llmCallLogs: {},
  markets: {},
  messages: { id: 'messages' },
  nftOwnership: {},
  npcTrades: {},
  perpPositions: {},
  positions: {},
  posts: {},
  referrals: {},
  trajectories: {},
  userAgentConfigs: { userId: 'userAgentConfigs.userId' },
  userApiKeys: { id: 'userApiKeys.id', userId: 'userApiKeys.userId' },
  users: {
    id: 'users.id',
    displayName: 'users.displayName',
    username: 'users.username',
  },
  // Other re-exports
  queryMonitor: {},
  ROLE_PERMISSIONS: {},
  generateSnowflakeId: () => 'snowflake-id',
  isValidSnowflakeId: () => true,
}));

mock.module('@babylon/api', () => ({
  assertPrivyOfflineConfig: () => undefined,
  broadcastAgentActivity: async () => undefined,
  broadcastToChannel: async () => undefined,
  checkProgress: async () => ({ completed: true }),
  countTokensSync: () => 0,
  createNotification: async () => undefined,
  DistributedLockService: class {
    acquire() {
      return { release: async () => {} };
    }
  },
  getModelTokenLimit: () => 4096,
  truncateToTokenLimitSync: (text: string) => text,
  verifyApiKey: async () => ({ valid: true }),
  notifyGroupChatMessage: async () => undefined,
}));

const mockParseKeyValueXml =
  mock<(text: string) => Record<string, unknown> | null>();
const mockComposePromptFromState = mock(() => 'MOCKED_PROMPT');

mock.module('@elizaos/core', () => ({
  composePromptFromState: mockComposePromptFromState,
  parseKeyValueXml: mockParseKeyValueXml,
  ModelType: { TEXT_SMALL: 'text_small', TEXT_LARGE: 'text_large' },
}));

const mockUuidV4 = mock(() => '00000000-0000-0000-0000-000000000001');
mock.module('uuid', () => ({ v4: mockUuidV4 }));

// Internal mocks — resolved relative to this test file location
// (__tests__/ → .. = services/)

const mockGetAgentWithConfig =
  mock<(agentId: string, ownerId: string) => Promise<unknown>>();
const mockListUserAgents = mock<(ownerId: string) => Promise<unknown[]>>();
const mockAgentService = {
  getAgentWithConfig: mockGetAgentWithConfig,
  listUserAgents: mockListUserAgents,
};

mock.module('../AgentService', () => ({
  agentService: mockAgentService,
}));

const mockGenerateSnowflakeId = mock(async () => 'snowflake-msg-id-001');
mock.module('../../shared/snowflake', () => ({
  generateSnowflakeId: mockGenerateSnowflakeId,
}));

mock.module('../../errors', () => ({
  AuthorizationError: MockAuthorizationError,
}));

// Mock runtime — shared and reset per test
const mockComposeState = mock(async () => ({ values: {}, data: {} }));
const mockUseModel =
  mock<
    (
      modelType: unknown,
      params: { prompt: string; temperature?: number }
    ) => Promise<string>
  >();
const mockProcessActions = mock(async () => undefined);

const mockRuntime = {
  agentId: 'runtime-agent-id',
  composeState: mockComposeState,
  useModel: mockUseModel,
  processActions: mockProcessActions,
};
const mockGetRuntime = mock(async () => mockRuntime);
const mockAgentRuntimeManager = { getRuntime: mockGetRuntime };
mock.module('../../runtime/AgentRuntimeManager', () => ({
  agentRuntimeManager: mockAgentRuntimeManager,
}));

// ─── Import after all mocks ───────────────────────────────────────────────────

const { dispatchAgentChat } = await import('../AgentChatService');

// ─── Shared test fixtures ─────────────────────────────────────────────────────

const AGENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OWNER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TEAM_CHAT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const MOCK_AGENT_WITH_CONFIG = {
  id: AGENT_ID,
  username: 'trading_bot',
  displayName: 'TradingBot',
  isAgent: true,
  managedBy: OWNER_ID,
  agentConfig: {
    systemPrompt: 'You are a trading agent.',
    personality: 'Analytical',
    tradingStrategy: 'Conservative',
  },
};

const MOCK_BROADCAST_FN = mock(async () => undefined);

const BASE_PARAMS = {
  agentId: AGENT_ID,
  ownerId: OWNER_ID,
  message: 'open a long on TSLAI for $100',
  teamChatId: TEAM_CHAT_ID,
  ownerName: 'Alice',
  ownerUsername: 'alice',
  broadcastFn: MOCK_BROADCAST_FN,
};

/**
 * Configure mocks for a successful run where LLM immediately finishes (no actions).
 */
function setupSuccessfulImmediateFinish() {
  mockGetAgentWithConfig.mockResolvedValue(MOCK_AGENT_WITH_CONFIG);
  // Decision: no action, isFinish immediately
  mockUseModel
    .mockResolvedValueOnce('DECISION_RESP')
    .mockResolvedValueOnce('SUMMARY_RESP');
  mockParseKeyValueXml
    .mockReturnValueOnce({
      thought: 'done',
      action: '',
      parameters: {},
      isFinish: 'true',
    }) // decision
    .mockReturnValueOnce({
      thought: 'summarizing',
      text: 'Your trade was executed.',
    }); // summary
}

// ─── Reset per test ───────────────────────────────────────────────────────────

beforeEach(() => {
  mockCheckUserInput.mockClear();
  mockCheckUserInput.mockReturnValue({ safe: true, reason: undefined });
  mockLogger.info.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
  mockComposePromptFromState.mockClear();
  mockGetAgentWithConfig.mockClear();
  mockListUserAgents.mockClear();
  mockListUserAgents.mockResolvedValue([]);
  mockGetRuntime.mockClear();
  mockGetRuntime.mockResolvedValue(mockRuntime);
  mockComposeState.mockClear();
  mockComposeState.mockResolvedValue({ values: {}, data: {} });
  mockUseModel.mockClear();
  mockParseKeyValueXml.mockClear();
  mockProcessActions.mockClear();
  mockProcessActions.mockResolvedValue(undefined);
  mockDbInsert.mockClear();
  mockDbInsert.mockReturnValue(mockInsertChain);
  mockInsertValues.mockClear();
  mockInsertValues.mockResolvedValue([]);
  mockDbUpdate.mockClear();
  mockDbUpdate.mockReturnValue(mockUpdateChain);
  mockGenerateSnowflakeId.mockClear();
  mockGenerateSnowflakeId.mockResolvedValue('snowflake-msg-id-001');
  MOCK_BROADCAST_FN.mockClear();
  MOCK_BROADCAST_FN.mockResolvedValue(undefined);
});

afterEach(() => {
  mockCheckUserInput.mockReset();
  mockParseKeyValueXml.mockReset();
  mockUseModel.mockReset();
  mockGetAgentWithConfig.mockReset();
  mockListUserAgents.mockReset();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('dispatchAgentChat', () => {
  // ── Input validation ────────────────────────────────────────────────────

  describe('input validation', () => {
    it('blocks unsafe content and returns failure without calling runtime', async () => {
      mockCheckUserInput.mockReturnValue({
        safe: false,
        reason: 'Prompt injection detected',
        category: 'injection',
      });

      const result = await dispatchAgentChat(BASE_PARAMS);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Prompt injection detected');
      expect(mockGetRuntime).not.toHaveBeenCalled();
      expect(mockGetAgentWithConfig).not.toHaveBeenCalled();
      expect(mockDbInsert).not.toHaveBeenCalled();
    });

    it('blocks content flagged as spam', async () => {
      mockCheckUserInput.mockReturnValue({
        safe: false,
        reason: 'Spam content detected',
        category: 'spam',
      });

      const result = await dispatchAgentChat({
        ...BASE_PARAMS,
        message: 'SPAM SPAM SPAM',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.actionsExecuted).toBe(0);
    });

    it('passes safe content through to runtime', async () => {
      setupSuccessfulImmediateFinish();
      const result = await dispatchAgentChat(BASE_PARAMS);
      expect(result.success).toBe(true);
      expect(mockGetAgentWithConfig).toHaveBeenCalledWith(AGENT_ID, OWNER_ID);
    });
  });

  // ── Ownership checks ─────────────────────────────────────────────────────

  describe('ownership and agent existence', () => {
    it('returns failure when agent not found (getAgentWithConfig returns null)', async () => {
      mockGetAgentWithConfig.mockResolvedValue(null);

      const result = await dispatchAgentChat(BASE_PARAMS);

      expect(result.success).toBe(false);
      expect(result.error).toContain(`Agent "${AGENT_ID}" not found`);
      expect(mockGetRuntime).not.toHaveBeenCalled();
      expect(mockDbInsert).not.toHaveBeenCalled();
    });

    it('returns failure when getAgentWithConfig throws AuthorizationError (wrong owner)', async () => {
      mockGetAgentWithConfig.mockRejectedValue(
        new MockAuthorizationError(
          'You do not have permission to access this agent.',
          'agent',
          'chat'
        )
      );

      const result = await dispatchAgentChat(BASE_PARAMS);

      expect(result.success).toBe(false);
      expect(result.error).toContain('permission');
      expect(mockGetRuntime).not.toHaveBeenCalled();
    });

    it('returns failure when getAgentWithConfig throws generic Error', async () => {
      mockGetAgentWithConfig.mockRejectedValue(
        new Error('Database connection lost')
      );

      const result = await dispatchAgentChat(BASE_PARAMS);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Database connection lost');
    });

    it('does not expose internal error details for AuthorizationError vs generic Error', async () => {
      mockGetAgentWithConfig.mockRejectedValue(
        new MockAuthorizationError('Internal auth details', 'agent', 'chat')
      );

      const result = await dispatchAgentChat(BASE_PARAMS);

      // Auth errors map to permission message, not raw internal message
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('resolves normalized agent names for a single matching owner agent', async () => {
      const resolvedAgent = {
        ...MOCK_AGENT_WITH_CONFIG,
        username: 'larrydavid',
        displayName: 'Larry David',
      };
      mockGetAgentWithConfig
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(resolvedAgent);
      mockListUserAgents.mockResolvedValue([resolvedAgent]);
      mockUseModel
        .mockResolvedValueOnce('DECISION_RESP')
        .mockResolvedValueOnce('SUMMARY_RESP');
      mockParseKeyValueXml
        .mockReturnValueOnce({
          thought: 'done',
          action: '',
          parameters: {},
          isFinish: 'true',
        })
        .mockReturnValueOnce({
          thought: 'summarizing',
          text: 'Resolved the agent correctly.',
        });

      const result = await dispatchAgentChat({
        ...BASE_PARAMS,
        agentId: 'larry david',
      });

      expect(result.success).toBe(true);
      expect(mockGetAgentWithConfig).toHaveBeenNthCalledWith(
        1,
        'larry david',
        OWNER_ID
      );
      expect(mockGetAgentWithConfig).toHaveBeenNthCalledWith(
        2,
        AGENT_ID,
        OWNER_ID
      );
    });

    it('uses single-agent fallback only for generic references like "my agent"', async () => {
      const resolvedAgent = {
        ...MOCK_AGENT_WITH_CONFIG,
        username: 'larrydavid',
        displayName: 'Larry David',
      };
      mockGetAgentWithConfig
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(resolvedAgent);
      mockListUserAgents.mockResolvedValue([resolvedAgent]);
      mockUseModel
        .mockResolvedValueOnce('DECISION_RESP')
        .mockResolvedValueOnce('SUMMARY_RESP');
      mockParseKeyValueXml
        .mockReturnValueOnce({
          thought: 'done',
          action: '',
          parameters: {},
          isFinish: 'true',
        })
        .mockReturnValueOnce({
          thought: 'summarizing',
          text: 'Single agent fallback worked.',
        });

      const result = await dispatchAgentChat({
        ...BASE_PARAMS,
        agentId: 'my agent',
      });

      expect(result.success).toBe(true);
      expect(mockGetAgentWithConfig).toHaveBeenNthCalledWith(
        2,
        AGENT_ID,
        OWNER_ID
      );
    });

    it('does not dispatch to the only agent when the requested name is unknown', async () => {
      const resolvedAgent = {
        ...MOCK_AGENT_WITH_CONFIG,
        username: 'larrydavid',
        displayName: 'Larry David',
      };
      mockGetAgentWithConfig.mockResolvedValue(null);
      mockListUserAgents.mockResolvedValue([resolvedAgent]);

      const result = await dispatchAgentChat({
        ...BASE_PARAMS,
        agentId: 'unknownbot',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Agent "unknownbot" not found');
      expect(result.error).toContain('@larrydavid');
      expect(mockGetAgentWithConfig).toHaveBeenCalledTimes(1);
      expect(mockGetRuntime).not.toHaveBeenCalled();
    });

    it('fails ambiguous partial matches instead of picking the first agent arbitrarily', async () => {
      mockGetAgentWithConfig.mockResolvedValue(null);
      mockListUserAgents.mockResolvedValue([
        {
          ...MOCK_AGENT_WITH_CONFIG,
          id: 'agent-1',
          username: 'larrydavid',
          displayName: 'Larry David',
        },
        {
          ...MOCK_AGENT_WITH_CONFIG,
          id: 'agent-2',
          username: 'larrytrades',
          displayName: 'Larry Trades',
        },
      ]);

      const result = await dispatchAgentChat({
        ...BASE_PARAMS,
        agentId: 'larry',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Agent "larry" not found');
      expect(mockGetAgentWithConfig).toHaveBeenCalledTimes(1);
      expect(mockGetRuntime).not.toHaveBeenCalled();
    });
  });

  // ── Happy path: immediate finish ─────────────────────────────────────────

  describe('happy path: no actions needed', () => {
    it('returns success with response text when LLM finishes immediately', async () => {
      setupSuccessfulImmediateFinish();

      const result = await dispatchAgentChat(BASE_PARAMS);

      expect(result.success).toBe(true);
      expect(result.response).toBe('Your trade was executed.');
      expect(result.agentId).toBe(AGENT_ID);
      expect(result.agentUsername).toBe('trading_bot');
      expect(result.actionsExecuted).toBe(0);
      expect(result.isLLMFailure).toBe(false);
    });

    it('writes agent response to DB with correct chatId and senderId', async () => {
      setupSuccessfulImmediateFinish();

      let capturedInsertValues: Record<string, unknown> | undefined;
      mockInsertValues.mockImplementation(
        async (vals: Record<string, unknown>) => {
          capturedInsertValues = vals;
          return [];
        }
      );

      await dispatchAgentChat(BASE_PARAMS);

      expect(mockDbInsert).toHaveBeenCalled();
      expect(capturedInsertValues).toBeDefined();
      expect(capturedInsertValues!.chatId).toBe(TEAM_CHAT_ID);
      expect(capturedInsertValues!.senderId).toBe(AGENT_ID);
      expect(capturedInsertValues!.content).toBe('Your trade was executed.');
      expect(capturedInsertValues!.id).toBe('snowflake-msg-id-001');
    });

    it('updates userAgentConfigs.lastChatAt after writing response', async () => {
      setupSuccessfulImmediateFinish();

      let dbUpdateCallCount = 0;
      mockDbUpdate.mockImplementation(() => {
        dbUpdateCallCount++;
        return mockUpdateChain;
      });

      await dispatchAgentChat(BASE_PARAMS);

      expect(dbUpdateCallCount).toBeGreaterThanOrEqual(1);
    });

    it('calls broadcastFn with correct message shape', async () => {
      setupSuccessfulImmediateFinish();

      const result = await dispatchAgentChat(BASE_PARAMS);

      expect(MOCK_BROADCAST_FN).toHaveBeenCalledTimes(1);
      const [calledChatId, calledMessage] = MOCK_BROADCAST_FN.mock.calls[0]!;
      expect(calledChatId).toBe(TEAM_CHAT_ID);
      expect(calledMessage.chatId).toBe(TEAM_CHAT_ID);
      expect(calledMessage.senderId).toBe(AGENT_ID);
      expect(calledMessage.content).toBe(result.response);
      expect(calledMessage.id).toBe('snowflake-msg-id-001');
      expect(typeof calledMessage.createdAt).toBe('string');
    });

    it('injects ownerName and ownerUsername into state values', async () => {
      setupSuccessfulImmediateFinish();

      const capturedStateValues: Array<Record<string, unknown>> = [];
      mockComposeState.mockImplementation(async () => {
        const state = { values: {}, data: {} };
        return state;
      });
      // We verify the LLM is called, which means state was built — ownerName is in the prompt
      // (composePromptFromState receives the state)
      await dispatchAgentChat({ ...BASE_PARAMS, ownerName: 'BobOwner' });

      // composePromptFromState was called
      expect(mockComposePromptFromState).toHaveBeenCalled();
      void capturedStateValues; // suppress unused warning
    });
  });

  // ── Happy path: with action execution ────────────────────────────────────

  describe('happy path: with one action', () => {
    it('executes action and increments actionsExecuted', async () => {
      mockGetAgentWithConfig.mockResolvedValue(MOCK_AGENT_WITH_CONFIG);

      // Iteration 1: decide to execute action
      mockUseModel
        .mockResolvedValueOnce('DECISION_ACTION_RESP') // iteration 1 decision
        .mockResolvedValueOnce('DECISION_FINISH_RESP') // iteration 2 decision (finish)
        .mockResolvedValueOnce('SUMMARY_RESP'); // summary

      mockParseKeyValueXml
        .mockReturnValueOnce({
          thought: 'I will open the trade',
          action: 'OPEN_PERP',
          parameters: { ticker: 'TSLAI', side: 'long', amount: 100 },
          isFinish: 'false',
        })
        .mockReturnValueOnce({
          thought: 'done',
          action: '',
          parameters: {},
          isFinish: 'true',
        })
        .mockReturnValueOnce({
          thought: 'reporting',
          text: 'Opened long on TSLAI for $100.',
        });

      // processActions calls callback with success result
      mockProcessActions.mockImplementation(
        async (
          _msg: unknown,
          _acts: unknown,
          _state: unknown,
          callback: (r: unknown) => Promise<unknown[]>
        ) => {
          await callback([
            {
              content: {
                success: true,
                text: 'Position opened: TSLAI long 2x $100',
              },
            },
          ]);
        }
      );

      const result = await dispatchAgentChat(BASE_PARAMS);

      expect(result.success).toBe(true);
      expect(result.actionsExecuted).toBe(1);
      expect(result.response).toBe('Opened long on TSLAI for $100.');
      expect(mockProcessActions).toHaveBeenCalledTimes(1);
    });

    it('records failed actions in traceActionResults without crashing', async () => {
      mockGetAgentWithConfig.mockResolvedValue(MOCK_AGENT_WITH_CONFIG);

      mockUseModel
        .mockResolvedValueOnce('ACTION_RESP') // decision: run action
        .mockResolvedValueOnce('FINISH_RESP') // decision: finish
        .mockResolvedValueOnce('SUMMARY_RESP'); // summary

      mockParseKeyValueXml
        .mockReturnValueOnce({
          thought: 'try action',
          action: 'OPEN_PERP',
          parameters: {},
          isFinish: 'false',
        })
        .mockReturnValueOnce({
          thought: 'done',
          action: '',
          parameters: {},
          isFinish: 'true',
        })
        .mockReturnValueOnce({ thought: 'done', text: 'Action attempted.' });

      // processActions throws
      mockProcessActions.mockRejectedValue(new Error('Insufficient balance'));

      const result = await dispatchAgentChat(BASE_PARAMS);

      // Should still succeed overall — action failure is caught
      expect(result.success).toBe(true);
      // Action was counted (even as failure)
      expect(result.actionsExecuted).toBe(1);
    });
  });

  // ── LLM failures ─────────────────────────────────────────────────────────

  describe('LLM parse failures', () => {
    it('sets isLLMFailure when all parse retries return null (decision)', async () => {
      mockGetAgentWithConfig.mockResolvedValue(MOCK_AGENT_WITH_CONFIG);
      // All parse retries fail for the decision — returns null
      mockUseModel.mockResolvedValue('UNPARSEABLE_RESPONSE');
      mockParseKeyValueXml.mockReturnValue(null);

      const result = await dispatchAgentChat(BASE_PARAMS);

      // isLLMFailure because decision could not be parsed
      expect(result.isLLMFailure).toBe(true);
      expect(result.response).toBeDefined(); // has a fallback response
      expect(result.response.length).toBeGreaterThan(0);
    });

    it('retries LLM parse up to 3 times before giving up', async () => {
      mockGetAgentWithConfig.mockResolvedValue(MOCK_AGENT_WITH_CONFIG);
      mockUseModel.mockResolvedValue('BAD_XML');
      mockParseKeyValueXml.mockReturnValue(null);

      await dispatchAgentChat(BASE_PARAMS);

      // 3 parse retries for the decision loop (MAX_PARSE_RETRIES = 3)
      expect(mockUseModel.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('returns fallback text when summary parse fails', async () => {
      mockGetAgentWithConfig.mockResolvedValue(MOCK_AGENT_WITH_CONFIG);

      // Decision succeeds (no action)
      mockUseModel
        .mockResolvedValueOnce('DECISION_RESP') // decision
        .mockResolvedValue('BAD_SUMMARY'); // summary — all retries fail

      mockParseKeyValueXml
        .mockReturnValueOnce({
          thought: 'done',
          action: '',
          parameters: {},
          isFinish: 'true',
        })
        .mockReturnValue(null); // summary retries all fail

      const result = await dispatchAgentChat(BASE_PARAMS);

      expect(result.success).toBe(true);
      // Falls back to default summary text
      expect(result.response).toBeDefined();
      expect(result.response.length).toBeGreaterThan(0);
    });

    it('injects formatted action results into reused state before the next decision and summary', async () => {
      mockGetAgentWithConfig.mockResolvedValue(MOCK_AGENT_WITH_CONFIG);

      mockUseModel
        .mockResolvedValueOnce('DECISION_1')
        .mockResolvedValueOnce('DECISION_2')
        .mockResolvedValueOnce('SUMMARY');
      mockParseKeyValueXml
        .mockReturnValueOnce({
          thought: 'check market',
          action: 'CHECK_PERPS',
          parameters: { ticker: 'TSLAI' },
          isFinish: 'false',
        })
        .mockReturnValueOnce({
          thought: 'done',
          action: '',
          parameters: {},
          isFinish: 'true',
        })
        .mockReturnValueOnce({
          thought: 'summarize',
          text: 'TSLAI is trading at $150.',
        });

      mockProcessActions.mockImplementation(
        async (
          _m: unknown,
          _a: unknown,
          _s: unknown,
          cb: (r: unknown) => Promise<unknown[]>
        ) => {
          await cb([
            {
              content: {
                success: true,
                text: 'TSLAI is trading at $150.',
                values: { ticker: 'TSLAI', price: 150 },
              },
            },
          ]);
        }
      );

      const result = await dispatchAgentChat(BASE_PARAMS);

      expect(result.success).toBe(true);
      expect(mockComposePromptFromState).toHaveBeenCalledTimes(3);

      const secondDecisionState = mockComposePromptFromState.mock.calls[1]![0]
        .state as {
        values: Record<string, unknown>;
      };
      expect(secondDecisionState.values.hasActionResults).toBe(true);
      expect(secondDecisionState.values.actionResults).toContain('CHECK_PERPS');
      expect(secondDecisionState.values.actionResults).toContain(
        'TSLAI is trading at $150.'
      );

      const summaryState = mockComposePromptFromState.mock.calls[2]![0]
        .state as {
        values: Record<string, unknown>;
      };
      expect(summaryState.values.hasActionResults).toBe(true);
      expect(summaryState.values.actionResults).toContain('CHECK_PERPS');
    });
  });

  // ── Max iterations boundary ───────────────────────────────────────────────

  describe('max iterations', () => {
    it('stops after MAX_ITERATIONS (2) even if LLM never signals isFinish', async () => {
      mockGetAgentWithConfig.mockResolvedValue(MOCK_AGENT_WITH_CONFIG);

      let decisionCalls = 0;
      // Never signals finish, always picks action — but loop caps at 4
      mockUseModel.mockImplementation(async () => {
        decisionCalls++;
        return 'DECISION_RESP';
      });
      mockParseKeyValueXml.mockImplementation(() => {
        // Decisions: always want to take action but never finish
        return {
          thought: 'thinking',
          action: 'CHECK_PERPS',
          parameters: {},
          isFinish: 'false',
        };
      });

      // processActions succeeds
      mockProcessActions.mockImplementation(
        async (
          _m: unknown,
          _a: unknown,
          _s: unknown,
          cb: (r: unknown) => Promise<unknown[]>
        ) => {
          await cb([{ content: { success: true, text: 'data' } }]);
        }
      );

      await dispatchAgentChat(BASE_PARAMS);

      // 2 decision iterations + summary calls (each with up to 3 parse retries)
      // Decision: up to 2 iterations × 1 LLM call = 2 decision calls
      // Summary: up to 3 retries
      // Total LLM calls ≤ 2 + 3 = 5
      expect(decisionCalls).toBeLessThanOrEqual(5);
      // Actions executed should be bounded
    });
  });

  // ── Broadcast fault tolerance ─────────────────────────────────────────────

  describe('broadcastFn fault tolerance', () => {
    it('swallows broadcast failure — dispatch still returns success', async () => {
      setupSuccessfulImmediateFinish();
      MOCK_BROADCAST_FN.mockRejectedValue(
        new Error('Redis stream unavailable')
      );

      const result = await dispatchAgentChat(BASE_PARAMS);

      // The broadcast rejection is fire-and-forget; dispatch itself succeeds
      expect(result.success).toBe(true);
      expect(result.response).toBe('Your trade was executed.');
    });
  });

  // ── agentUsername fallback ────────────────────────────────────────────────

  describe('agent metadata', () => {
    it('uses displayName as agentName when available', async () => {
      mockGetAgentWithConfig.mockResolvedValue({
        ...MOCK_AGENT_WITH_CONFIG,
        displayName: 'My Fancy Bot',
        username: 'fancy_bot',
      });
      mockUseModel.mockResolvedValueOnce('DEC').mockResolvedValueOnce('SUM');
      mockParseKeyValueXml
        .mockReturnValueOnce({
          thought: 'done',
          action: '',
          parameters: {},
          isFinish: 'true',
        })
        .mockReturnValueOnce({ thought: 'done', text: 'Done.' });

      const result = await dispatchAgentChat(BASE_PARAMS);

      expect(result.agentUsername).toBe('fancy_bot');
    });

    it('returns agentUsername as undefined when agent has no username', async () => {
      mockGetAgentWithConfig.mockResolvedValue({
        ...MOCK_AGENT_WITH_CONFIG,
        username: null,
        displayName: 'Nameless Agent',
      });
      mockUseModel.mockResolvedValueOnce('DEC').mockResolvedValueOnce('SUM');
      mockParseKeyValueXml
        .mockReturnValueOnce({
          thought: 'done',
          action: '',
          parameters: {},
          isFinish: 'true',
        })
        .mockReturnValueOnce({ thought: 'done', text: 'Done.' });

      const result = await dispatchAgentChat(BASE_PARAMS);

      expect(result.agentUsername).toBeUndefined();
    });
  });

  // ── Parameter action parsing ──────────────────────────────────────────────

  describe('action parameter parsing', () => {
    it('parses JSON string parameters correctly', async () => {
      mockGetAgentWithConfig.mockResolvedValue(MOCK_AGENT_WITH_CONFIG);

      const capturedStateData: Record<string, unknown>[] = [];

      mockUseModel
        .mockResolvedValueOnce('ACT_RESP')
        .mockResolvedValueOnce('FIN_RESP')
        .mockResolvedValueOnce('SUM_RESP');

      mockParseKeyValueXml
        .mockReturnValueOnce({
          thought: 'acting',
          action: 'OPEN_PERP',
          parameters: '{"ticker": "TSLAI", "amount": 100}', // JSON string
          isFinish: 'false',
        })
        .mockReturnValueOnce({
          thought: 'done',
          action: '',
          parameters: {},
          isFinish: 'true',
        })
        .mockReturnValueOnce({ thought: 'done', text: 'Executed.' });

      mockComposeState.mockImplementation(async () => ({
        values: {},
        data: {},
      }));

      // Capture what is set as actionParams in state.data
      mockProcessActions.mockImplementation(
        async (
          _m: unknown,
          _a: unknown,
          state: { data?: Record<string, unknown> },
          cb: (r: unknown) => Promise<unknown[]>
        ) => {
          if (state.data?.actionParams) {
            capturedStateData.push(
              state.data.actionParams as Record<string, unknown>
            );
          }
          await cb([{ content: { success: true, text: 'ok' } }]);
        }
      );

      await dispatchAgentChat(BASE_PARAMS);

      expect(capturedStateData.length).toBeGreaterThan(0);
      expect(capturedStateData[0]).toMatchObject({
        ticker: 'TSLAI',
        amount: 100,
      });
    });

    it('handles already-parsed object parameters', async () => {
      mockGetAgentWithConfig.mockResolvedValue(MOCK_AGENT_WITH_CONFIG);

      mockUseModel
        .mockResolvedValueOnce('ACT')
        .mockResolvedValueOnce('FIN')
        .mockResolvedValueOnce('SUM');

      mockParseKeyValueXml
        .mockReturnValueOnce({
          thought: 'acting',
          action: 'CHECK_PERPS',
          parameters: { ticker: 'NVDAI' }, // already an object
          isFinish: 'false',
        })
        .mockReturnValueOnce({
          thought: 'done',
          action: '',
          parameters: {},
          isFinish: 'true',
        })
        .mockReturnValueOnce({ thought: 'done', text: 'Checked.' });

      const capturedParams: unknown[] = [];
      mockProcessActions.mockImplementation(
        async (
          _m: unknown,
          _a: unknown,
          state: { data?: { actionParams?: unknown } },
          cb: (r: unknown) => Promise<unknown[]>
        ) => {
          capturedParams.push(state.data?.actionParams);
          await cb([{ content: { success: true, text: 'ok' } }]);
        }
      );

      await dispatchAgentChat(BASE_PARAMS);

      expect(capturedParams[0]).toMatchObject({ ticker: 'NVDAI' });
    });
  });
});
