import { expect, type Page } from "@playwright/test";

const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==",
  "base64",
);

const NOW = Date.parse("2026-03-17T18:30:00.000Z");

function iso(offsetMs = 0): string {
  return new Date(NOW + offsetMs).toISOString();
}

function timestamp(offsetMs = 0): number {
  return NOW + offsetMs;
}

function createPlugin(
  overrides: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    category: "feature",
    configured: true,
    description: "Plugin fixture",
    enabled: true,
    envKey: null,
    id: "plugin",
    isActive: true,
    name: "Plugin",
    parameters: [],
    source: "bundled",
    validationErrors: [],
    validationWarnings: [],
    ...overrides,
  };
}

function createHomeState(options?: { onboardingComplete?: boolean }) {
  const onboardingComplete = options?.onboardingComplete ?? true;
  const character = {
    adjectives: ["helpful", "precise"],
    bio: ["A fully fledged Eliza Home agent."],
    messageExamples: [
      {
        examples: [
          {
            content: { text: "Status is green." },
            name: "Rin",
          },
        ],
      },
    ],
    name: "Rin",
    postExamples: ["Status is green."],
    style: {
      all: ["Speak directly."],
      chat: ["Keep replies tight."],
      post: ["Be concise."],
    },
    system: "You are Rin.",
    topics: ["automation", "wallets"],
    username: "rin",
  };

  const baseConversation = {
    createdAt: iso(-86_400_000),
    id: "conv-1",
    roomId: "room-1",
    title: "General",
    updatedAt: iso(-60_000),
  };

  const state = {
    agentStatus: {
      agentName: character.name,
      model: "gpt-5.4-mini",
      startedAt: timestamp(-3_600_000),
      state: "running",
      uptime: 3_600,
    },
    character,
    cloudCredits: {
      balance: null,
      connected: false,
      critical: false,
      low: false,
    },
    cloudStatus: {
      connected: false,
      enabled: false,
      hasApiKey: false,
      reason: "offline",
    },
    config: {
      messages: {
        swabble: {
          minPostTriggerGap: 0.45,
          modelSize: "base",
          triggers: ["eliza", "hey eliza"],
        },
        tts: {
          mode: "own-key",
          provider: "edge",
        },
      },
      ui: {
        avatarIndex: 1,
      },
    },
    conversations: onboardingComplete ? [baseConversation] : [],
    customActions: [
      {
        createdAt: iso(-86_400_000),
        description: "Send a quick morning ping.",
        enabled: true,
        handler: {
          type: "http",
          method: "POST",
          url: "https://example.com/webhooks/morning",
        },
        id: "action-1",
        name: "Morning Handshake",
        parameters: [
          {
            description: "Target channel",
            name: "channel",
            required: true,
          },
        ],
        similes: ["morning_ping"],
        updatedAt: iso(-3_600_000),
      },
    ],
    databaseRows: {
      memories: {
        columns: ["id", "content", "createdAt"],
        rows: [
          {
            content: "Remember the sunrise briefing.",
            createdAt: iso(-43_200_000),
            id: "mem-1",
          },
        ],
        table: "memories",
      },
    },
    databaseStatus: {
      connected: true,
      pgliteDataDir: "/tmp/eliza-home-db",
      postgresHost: null,
      provider: "pglite",
      serverVersion: "0.2.0",
      tableCount: 1,
    },
    databaseTables: [
      {
        columns: [
          {
            defaultValue: null,
            isPrimaryKey: true,
            name: "id",
            nullable: false,
            type: "text",
          },
          {
            defaultValue: null,
            isPrimaryKey: false,
            name: "content",
            nullable: false,
            type: "text",
          },
          {
            defaultValue: null,
            isPrimaryKey: false,
            name: "createdAt",
            nullable: false,
            type: "timestamp",
          },
        ],
        name: "memories",
        rowCount: 1,
        schema: "public",
      },
    ],
    dropStatus: {
      currentSupply: 0,
      dropEnabled: false,
      maxSupply: 0,
      mintedOut: false,
      publicMintOpen: false,
      shinyPrice: "0",
      userHasMinted: false,
      whitelistMintOpen: false,
    },
    extensionStatus: {
      extensionPath: null,
      relayPort: 18_792,
      relayReachable: false,
    },
    knowledgeDocuments: [
      {
        contentType: "text/markdown",
        createdAt: timestamp(-172_800_000),
        fileSize: 256,
        filename: "roadmap.md",
        fragmentCount: 1,
        id: "doc-1",
        source: "upload",
      },
    ],
    knowledgeFragments: {
      "doc-1": {
        count: 1,
        documentId: "doc-1",
        fragments: [
          {
            createdAt: timestamp(-172_800_000),
            id: "frag-1",
            position: 0,
            text: "Milestone: ship Eliza Home end-to-end coverage.",
          },
        ],
      },
    },
    logs: [
      {
        level: "info",
        message: "Boot sequence complete",
        source: "runtime",
        tags: ["startup"],
        timestamp: timestamp(-30_000),
      },
    ],
    messagesByConversation: onboardingComplete
      ? {
          "conv-1": [
            {
              id: "msg-1",
              role: "assistant",
              source: "agent_greeting",
              text: "Ready when you are.",
              timestamp: timestamp(-45_000),
            },
          ],
        }
      : {},
    nextConversationId: 2,
    onboardingComplete,
    onboardingOptions: {
      cloudProviders: [
        {
          description: "Managed Eliza Cloud hosting",
          id: "elizacloud",
          name: "Eliza Cloud",
        },
      ],
      inventoryProviders: [],
      models: {
        large: [],
        small: [],
      },
      names: ["Rin", "Ai", "Anzu", "Aya"],
      openrouterModels: [],
      piAiDefaultModel: "",
      piAiModels: [],
      providers: [
        {
          description: "Run locally with Ollama",
          envKey: null,
          id: "ollama",
          keyPrefix: null,
          name: "Ollama",
          pluginName: "@elizaos/plugin-ollama",
        },
        {
          description: "Use OpenAI hosted models",
          envKey: "OPENAI_API_KEY",
          id: "openai",
          keyPrefix: "sk-",
          name: "OpenAI",
          pluginName: "@elizaos/plugin-openai",
        },
      ],
      sharedStyleRules: "Always be concise and direct.",
      styles: [
        {
          adjectives: ["sharp", "grounded"],
          bio: ["A grounded operator with a dry sense of humor."],
          catchphrase: "Noted.",
          hint: "grounded operator",
          messageExamples: [
            [
              {
                content: { text: "I have it handled." },
                user: "{{agentName}}",
              },
            ],
          ],
          postExamples: ["Task complete."],
          style: {
            all: ["Be precise."],
            chat: ["Answer directly."],
            post: ["Avoid filler."],
          },
          system: "You are {{name}}.",
        },
        {
          adjectives: ["playful"],
          bio: ["An upbeat assistant."],
          catchphrase: "uwu~",
          hint: "playful",
          messageExamples: [],
          postExamples: [],
          style: { all: ["Be playful."], chat: [], post: [] },
          system: "You are {{name}}.",
        },
        {
          adjectives: ["minimal"],
          bio: ["A terse assistant."],
          catchphrase: "lol k",
          hint: "minimal",
          messageExamples: [],
          postExamples: [],
          style: { all: ["Be terse."], chat: [], post: [] },
          system: "You are {{name}}.",
        },
        {
          adjectives: ["bright"],
          bio: ["A bright assistant."],
          catchphrase: "hehe~",
          hint: "bright",
          messageExamples: [],
          postExamples: [],
          style: { all: ["Be bright."], chat: [], post: [] },
          system: "You are {{name}}.",
        },
      ],
    },
    permissions: {
      accessibility: {
        canRequest: true,
        id: "accessibility",
        lastChecked: NOW,
        status: "granted",
      },
      camera: {
        canRequest: true,
        id: "camera",
        lastChecked: NOW,
        status: "granted",
      },
      microphone: {
        canRequest: true,
        id: "microphone",
        lastChecked: NOW,
        status: "granted",
      },
      shell: {
        canRequest: false,
        id: "shell",
        lastChecked: NOW,
        status: "not-applicable",
      },
      "screen-recording": {
        canRequest: true,
        id: "screen-recording",
        lastChecked: NOW,
        status: "granted",
      },
    },
    plugins: [
      createPlugin({
        category: "streaming",
        description: "Streaming control plane",
        id: "streaming-base",
        name: "Streaming Base",
      }),
      createPlugin({
        category: "connector",
        description: "Telegram Connector",
        id: "telegram-connector",
        name: "Telegram Connector",
      }),
      createPlugin({
        category: "feature",
        description: "Skill catalog browser",
        id: "skill-lab",
        name: "Skill Lab",
      }),
    ],
    registryStatus: {
      agentEndpoint: "",
      agentName: "",
      capabilitiesHash: "",
      configured: false,
      isActive: false,
      registered: false,
      tokenId: 0,
      tokenURI: "",
      totalAgents: 0,
      walletAddress: "0x0000000000000000000000000000000000000000",
    },
    runtimeSnapshot: {
      generatedAt: NOW,
      meta: {
        actionCount: 1,
        agentName: character.name,
        agentState: "running",
        evaluatorCount: 1,
        model: "gpt-5.4-mini",
        pluginCount: 3,
        providerCount: 1,
        serviceCount: 1,
        serviceTypeCount: 1,
      },
      order: {
        actions: [
          {
            className: "MorningHandshakeAction",
            id: "action-1",
            index: 0,
            name: "Morning Handshake",
          },
        ],
        evaluators: [
          {
            className: "SafetyEvaluator",
            id: "eval-1",
            index: 0,
            name: "safety",
          },
        ],
        plugins: [
          {
            className: "StreamingBasePlugin",
            id: "streaming-base",
            index: 0,
            name: "streaming-base",
          },
          {
            className: "TelegramConnector",
            id: "telegram-connector",
            index: 1,
            name: "telegram-connector",
          },
        ],
        providers: [
          {
            className: "OllamaProvider",
            id: "provider-1",
            index: 0,
            name: "ollama",
          },
        ],
        services: [
          {
            count: 1,
            index: 0,
            instances: [
              {
                className: "MemoryService",
                id: "service-1",
                index: 0,
                name: "memory",
              },
            ],
            serviceType: "memory",
          },
        ],
      },
      runtimeAvailable: true,
      sections: {
        actions: [{ id: "action-1", name: "Morning Handshake" }],
        evaluators: [{ name: "safety" }],
        plugins: [{ id: "streaming-base", name: "Streaming Base" }],
        providers: [{ name: "ollama" }],
        runtime: { mode: "ready", shell: "native" },
        services: [{ name: "memory" }],
      },
      settings: {
        maxArrayLength: 1_000,
        maxDepth: 10,
        maxObjectEntries: 1_000,
        maxStringLength: 500,
      },
    },
    securityEntries: [
      {
        metadata: {
          path: "/api/custom-actions",
        },
        severity: "info",
        summary: "Custom action registry enumerated",
        timestamp: iso(-90_000),
        traceId: "trace-1",
        type: "privileged_capability_invocation",
      },
    ],
    skills: [
      {
        description: "Release preflight checklist",
        enabled: true,
        id: "release-checklist",
        name: "Release Checklist",
        scanStatus: "clean",
      },
    ],
    stream: {
      destinations: [{ id: "local-preview", name: "Local Preview" }],
      live: false,
      overlayLayout: {},
      settings: {
        avatarIndex: 1,
        theme: "dark",
      },
      source: { type: "stream-tab" },
      voice: {
        autoSpeak: false,
        configuredProvider: "edge",
        enabled: false,
        hasApiKey: false,
        isAttached: false,
        isSpeaking: false,
        ok: true,
        provider: "edge",
      },
    },
    trainingDatasets: [
      {
        createdAt: iso(-172_800_000),
        id: "dataset-1",
        jsonlPath: "/tmp/datasets/dataset-1.jsonl",
        metadataPath: "/tmp/datasets/dataset-1.metadata.json",
        sampleCount: 12,
        trajectoryCount: 1,
        trajectoryDir: "/tmp/trajectories",
      },
    ],
    trainingJobs: [
      {
        adapterPath: null,
        completedAt: null,
        createdAt: iso(-86_400_000),
        datasetId: "dataset-1",
        error: null,
        exitCode: null,
        id: "job-1",
        logPath: "/tmp/jobs/job-1.log",
        logs: ["starting"],
        modelId: null,
        modelPath: null,
        options: {
          backend: "cpu",
          datasetId: "dataset-1",
        },
        outputDir: "/tmp/jobs/job-1",
        phase: "queued",
        progress: 0,
        pythonRoot: "/tmp/python",
        scriptPath: "/tmp/train.py",
        signal: null,
        startedAt: null,
        status: "queued",
      },
    ],
    trainingModels: [
      {
        active: true,
        adapterPath: null,
        backend: "cpu",
        benchmark: {
          lastRunAt: null,
          output: null,
          status: "not_run",
        },
        createdAt: iso(-259_200_000),
        id: "model-1",
        jobId: "job-1",
        modelPath: "/tmp/models/model-1",
        ollamaModel: "eliza-home",
        outputDir: "/tmp/models/model-1",
        sourceModel: "llama3.2",
      },
    ],
    trainingStatus: {
      completedJobs: 1,
      datasetCount: 1,
      failedJobs: 0,
      modelCount: 1,
      queuedJobs: 1,
      runningJobs: 0,
      runtimeAvailable: true,
    },
    trainingTrajectoryDetails: {
      "traj-1": {
        agentId: "agent-1",
        aiJudgeReasoning: "Consistent execution.",
        aiJudgeReward: 0.92,
        archetype: "support",
        createdAt: iso(-86_400_000),
        episodeLength: 3,
        hasLlmCalls: true,
        id: "train-traj-1",
        llmCallCount: 4,
        stepsJson: '[{"step":"plan"},{"step":"reply"}]',
        totalReward: 0.92,
        trajectoryId: "traj-1",
      },
    },
    trainingTrajectoryList: {
      available: true,
      total: 1,
      trajectories: [
        {
          agentId: "agent-1",
          aiJudgeReward: 0.92,
          archetype: "support",
          createdAt: iso(-86_400_000),
          episodeLength: 3,
          hasLlmCalls: true,
          id: "train-traj-1",
          llmCallCount: 4,
          totalReward: 0.92,
          trajectoryId: "traj-1",
        },
      ],
    },
    trajectories: {
      config: {
        enabled: true,
      },
      list: {
        limit: 50,
        offset: 0,
        total: 1,
        trajectories: [
          {
            agentId: "agent-1",
            conversationId: "conv-1",
            createdAt: iso(-86_400_000),
            durationMs: 4_200,
            endTime: timestamp(-86_396_000),
            entityId: null,
            id: "traj-1",
            llmCallCount: 4,
            metadata: {
              label: "Morning routine",
            },
            providerAccessCount: 1,
            roomId: "room-1",
            source: "chat",
            startTime: timestamp(-86_400_000),
            status: "completed",
            totalCompletionTokens: 240,
            totalPromptTokens: 180,
            updatedAt: iso(-86_396_000),
          },
        ],
      },
      stats: {
        averageDurationMs: 4_200,
        byModel: {
          "gpt-5.4-mini": 1,
        },
        bySource: {
          chat: 1,
        },
        totalCompletionTokens: 240,
        totalLlmCalls: 4,
        totalPromptTokens: 180,
        totalProviderAccesses: 1,
        totalTrajectories: 1,
      },
    },
    triggerHealth: {
      activeTriggers: 1,
      disabledTriggers: 0,
      lastExecutionAt: timestamp(-600_000),
      totalExecutions: 5,
      totalFailures: 0,
      totalSkipped: 0,
      triggersEnabled: true,
    },
    triggerRunsById: {
      "trigger-1": [
        {
          error: undefined,
          finishedAt: timestamp(-600_000),
          latencyMs: 120,
          source: "scheduler",
          startedAt: timestamp(-600_120),
          status: "success",
          taskId: "task-1",
          triggerId: "trigger-1",
          triggerRunId: "run-1",
        },
      ],
    },
    triggers: [
      {
        createdBy: "user",
        cronExpression: undefined,
        displayName: "Morning Check-In",
        enabled: true,
        id: "trigger-1",
        instructions: "Send the morning systems summary.",
        intervalMs: 3_600_000,
        lastError: undefined,
        lastRunAtIso: iso(-600_000),
        lastStatus: "success",
        maxRuns: undefined,
        nextRunAtMs: timestamp(1_800_000),
        runCount: 5,
        scheduledAtIso: undefined,
        taskId: "task-1",
        timezone: "America/Los_Angeles",
        triggerType: "interval",
        updatedAt: timestamp(-600_000),
        wakeMode: "inject_now",
      },
    ],
    updateStatus: {
      channel: "stable",
      channels: {
        beta: null,
        nightly: null,
        stable: "2.0.0",
      },
      currentVersion: "2.0.0",
      distTags: {
        beta: "beta",
        nightly: "nightly",
        stable: "latest",
      },
      error: null,
      installMethod: "bun",
      lastCheckAt: iso(-3_600_000),
      latestVersion: null,
      updateAvailable: false,
    },
    walletAddresses: {
      evmAddress: "0x1234567890123456789012345678901234567890",
      solanaAddress: "So1ana111111111111111111111111111111111111",
    },
    walletBalances: {
      evm: {
        address: "0x1234567890123456789012345678901234567890",
        chains: [
          {
            chain: "ethereum",
            chainId: 1,
            error: null,
            nativeBalance: "1.5",
            nativeSymbol: "ETH",
            nativeValueUsd: "3000",
            tokens: [
              {
                balance: "2500",
                contractAddress: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
                decimals: 6,
                logoUrl: "",
                name: "USD Coin",
                symbol: "USDC",
                valueUsd: "2500",
              },
            ],
          },
        ],
      },
      solana: {
        address: "So1ana111111111111111111111111111111111111",
        solBalance: "12",
        solValueUsd: "1800",
        tokens: [],
      },
    },
    walletConfig: {
      alchemyKeySet: true,
      ankrKeySet: true,
      avalancheBalanceReady: false,
      baseBalanceReady: true,
      birdeyeKeySet: false,
      bscBalanceReady: true,
      cloudManagedAccess: false,
      ethereumBalanceReady: true,
      evmAddress: "0x1234567890123456789012345678901234567890",
      evmBalanceReady: true,
      evmChains: ["ethereum", "base", "bsc"],
      heliusKeySet: false,
      infuraKeySet: false,
      legacyCustomChains: [],
      managedBscRpcReady: true,
      selectedRpcProviders: {
        bsc: "alchemy",
        evm: "alchemy",
        solana: "helius-birdeye",
      },
      solanaAddress: "So1ana111111111111111111111111111111111111",
      solanaBalanceReady: true,
      tradePermissionMode: "user-sign-only",
    },
    walletNfts: {
      evm: [
        {
          chain: "ethereum",
          nfts: [
            {
              collectionName: "Milady Home",
              contractAddress: "0x0000000000000000000000000000000000000001",
              description: "First NFT",
              imageUrl: "https://example.com/nft.png",
              name: "Milady Home #1",
              tokenId: "1",
              tokenType: "ERC721",
            },
          ],
        },
      ],
      solana: {
        nfts: [],
      },
    },
    workbench: {
      autonomy: {
        enabled: true,
        lastEventAt: timestamp(-60_000),
        thinking: false,
      },
      tasks: [],
      todos: [],
      triggers: [],
      tasksAvailable: true,
      todosAvailable: true,
      triggersAvailable: true,
    },
  };

  return state;
}

function updateConversationTimestamp(
  state: ReturnType<typeof createHomeState>,
  conversationId: string,
) {
  const updatedAt = iso();
  state.conversations = state.conversations.map((conversation) =>
    conversation.id === conversationId ? { ...conversation, updatedAt } : conversation,
  );
}

function ensureConversationMessages(
  state: ReturnType<typeof createHomeState>,
  conversationId: string,
) {
  if (!state.messagesByConversation[conversationId]) {
    state.messagesByConversation[conversationId] = [];
  }
  return state.messagesByConversation[conversationId];
}

function buildGreetingText(state: ReturnType<typeof createHomeState>) {
  return `${state.character.name} is online.`;
}

function buildAssistantReply(text: string) {
  return `Acknowledged: ${text}`;
}

function jsonBody(request: { postData(): string | null }): Record<string, unknown> {
  const raw = request.postData();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sse(body: Record<string, unknown>[]) {
  return body
    .map((payload) => `data: ${JSON.stringify(payload)}\n\n`)
    .join("");
}

export async function installHomeMocks(
  page: Page,
  options?: { onboardingComplete?: boolean },
) {
  const state = createHomeState(options);
  const pageErrors: string[] = [];
  const unhandledApiRequests = new Set<string>();

  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("eliza:ui-language", "en");
    localStorage.setItem("eliza:ui-shell-mode", "native");
    // Seed a persisted connection mode so the startup sequence reaches the
    // backend API (which the Playwright route mocks intercept) instead of
    // short-circuiting into the fresh-install onboarding path.
    localStorage.setItem(
      "eliza:connection-mode",
      JSON.stringify({ runMode: "local" }),
    );

    window.scrollTo = () => undefined;
    window.open = () => null;
    window.confirm = () => true;

    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: async () => undefined,
    });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", {
      configurable: true,
      value: () => undefined,
    });

    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: () => undefined,
    });

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        addEventListener: () => undefined,
        addListener: () => undefined,
        dispatchEvent: () => true,
        matches: false,
        media: query,
        onchange: null,
        removeEventListener: () => undefined,
        removeListener: () => undefined,
      }),
    });

    class MockResizeObserver {
      disconnect() {}
      observe() {}
      unobserve() {}
    }

    class MockIntersectionObserver {
      disconnect() {}
      observe() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    }

    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      private listeners = new Map<string, Set<(event: Event) => void>>();
      readyState = MockWebSocket.OPEN;
      url: string;
      onclose: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onopen: ((event: Event) => void) | null = null;

      constructor(url: string) {
        this.url = url;
        setTimeout(() => {
          const event = new Event("open");
          this.onopen?.(event);
          this.emit("open", event);
        }, 0);
      }

      addEventListener(type: string, listener: (event: Event) => void) {
        if (!this.listeners.has(type)) {
          this.listeners.set(type, new Set());
        }
        this.listeners.get(type)?.add(listener);
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        const event = new Event("close");
        this.onclose?.(event);
        this.emit("close", event);
      }

      emit(type: string, event: Event) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }

      removeEventListener(type: string, listener: (event: Event) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      send() {}
    }

    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: MockResizeObserver,
    });
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: MockIntersectionObserver,
    });
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      value: MockWebSocket,
    });

    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: async () => ({
          onchange: null,
          state: "granted",
        }),
      },
    });

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [
          { deviceId: "mic-1", kind: "audioinput", label: "Default Mic" },
        ],
        getUserMedia: async () => ({
          getTracks: () => [
            {
              enabled: true,
              kind: "audio",
              stop: () => undefined,
            },
          ],
        }),
      },
    });
  });

  await page.route("**/vrms/**/*.png", async (route) => {
    await route.fulfill({
      body: TRANSPARENT_PNG,
      contentType: "image/png",
      status: 200,
    });
  });

  await page.route(
    (url) => {
      const { pathname } = new URL(url.toString());
      return pathname === "/api" || pathname.startsWith("/api/");
    },
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const path = url.pathname;

      const fulfillJson = async (data: unknown, status = 200) => {
        await route.fulfill({
          body: JSON.stringify(data),
          contentType: "application/json",
          status,
        });
      };

      if (method === "HEAD" && path === "/api/avatar/vrm") {
        await route.fulfill({ body: "", status: 404 });
        return;
      }

      if (method === "HEAD" && path === "/api/avatar/background") {
        await route.fulfill({ body: "", status: 404 });
        return;
      }

      if (method === "GET" && path === "/api/auth/status") {
        await fulfillJson({
          expiresAt: null,
          pairingEnabled: false,
          required: false,
        });
        return;
      }

      if (method === "GET" && path === "/api/onboarding/status") {
        await fulfillJson({ complete: state.onboardingComplete });
        return;
      }

      if (method === "GET" && path === "/api/onboarding/options") {
        await fulfillJson(state.onboardingOptions);
        return;
      }

      if (method === "POST" && path === "/api/onboarding") {
        const body = jsonBody(request);
        state.onboardingComplete = true;
        const submittedName = body.name;
        if (typeof submittedName === "string" && submittedName.trim()) {
          state.character = {
            ...state.character,
            name: submittedName.trim(),
            username: submittedName.trim().toLowerCase(),
          };
          state.agentStatus = {
            ...state.agentStatus,
            agentName: submittedName.trim(),
          };
        }
        await fulfillJson({ ok: true });
        return;
      }

      if (method === "GET" && path === "/api/config") {
        await fulfillJson(state.config);
        return;
      }

      if (method === "PUT" && path === "/api/config") {
        const body = jsonBody(request);
        state.config = {
          ...state.config,
          ...body,
        };
        await fulfillJson({ ok: true });
        return;
      }

      if (method === "GET" && path === "/api/status") {
        await fulfillJson(state.agentStatus);
        return;
      }

    if (
      method === "POST" &&
      (path === "/api/agent/restart" ||
        path === "/api/agent/start" ||
        path === "/api/agent/stop")
    ) {
      await fulfillJson({ status: state.agentStatus });
      return;
    }

    if (method === "GET" && path === "/api/workbench/overview") {
      await fulfillJson(state.workbench);
      return;
    }

    if (method === "GET" && path === "/api/agent/events") {
      await fulfillJson({
        events: [],
        latestEventId: null,
        replayed: true,
        totalBuffered: 0,
      });
      return;
    }

    if (method === "GET" && path === "/api/coding-agents/coordinator/status") {
      await fulfillJson({ tasks: [] });
      return;
    }

    if (method === "GET" && path === "/api/conversations") {
      await fulfillJson({ conversations: state.conversations });
      return;
    }

    if (method === "POST" && path === "/api/conversations") {
      const body = jsonBody(request);
      const conversationId = `conv-${state.nextConversationId++}`;
      const title =
        typeof body.title === "string" && body.title.trim()
          ? body.title.trim()
          : `Chat ${conversationId}`;
      const conversation = {
        createdAt: iso(),
        id: conversationId,
        roomId: `room-${conversationId}`,
        title,
        updatedAt: iso(),
      };
      state.conversations = [conversation, ...state.conversations];
      ensureConversationMessages(state, conversationId);

      const basicCapabilitiesGreeting = body["basic-capabilitiesGreeting"] === true;
      if (basicCapabilitiesGreeting) {
        const greetingText = buildGreetingText(state);
        state.messagesByConversation[conversationId].push({
          id: `greeting-${conversationId}`,
          role: "assistant",
          source: "agent_greeting",
          text: greetingText,
          timestamp: timestamp(),
        });
        await fulfillJson({
          conversation,
          greeting: {
            agentName: state.agentStatus.agentName,
            generated: true,
            persisted: true,
            text: greetingText,
          },
        });
        return;
      }

      await fulfillJson({ conversation });
      return;
    }

    const conversationMessagesMatch =
      method === "GET"
        ? path.match(/^\/api\/conversations\/([^/]+)\/messages$/)
        : null;
    if (conversationMessagesMatch) {
      const conversationId = decodeURIComponent(conversationMessagesMatch[1]);
      await fulfillJson({
        messages: state.messagesByConversation[conversationId] ?? [],
      });
      return;
    }

    const conversationGreetingMatch =
      method === "POST"
        ? path.match(/^\/api\/conversations\/([^/]+)\/greeting$/)
        : null;
    if (conversationGreetingMatch) {
      const conversationId = decodeURIComponent(conversationGreetingMatch[1]);
      const greetingText = buildGreetingText(state);
      const messages = ensureConversationMessages(state, conversationId);
      messages.push({
        id: `greeting-${conversationId}-${messages.length + 1}`,
        role: "assistant",
        source: "agent_greeting",
        text: greetingText,
        timestamp: timestamp(),
      });
      updateConversationTimestamp(state, conversationId);
      await fulfillJson({
        agentName: state.agentStatus.agentName,
        generated: true,
        persisted: true,
        text: greetingText,
      });
      return;
    }

    const conversationStreamMatch =
      method === "POST"
        ? path.match(/^\/api\/conversations\/([^/]+)\/messages\/stream$/)
        : null;
    if (conversationStreamMatch) {
      const conversationId = decodeURIComponent(conversationStreamMatch[1]);
      const body = jsonBody(request);
      const text =
        typeof body.text === "string" && body.text.trim()
          ? body.text.trim()
          : "Ping";
      const messages = ensureConversationMessages(state, conversationId);
      messages.push({
        id: `user-${messages.length + 1}`,
        role: "user",
        text,
        timestamp: timestamp(),
      });
      const reply = buildAssistantReply(text);
      messages.push({
        id: `assistant-${messages.length + 1}`,
        role: "assistant",
        text: reply,
        timestamp: timestamp(1_000),
      });
      updateConversationTimestamp(state, conversationId);

      await route.fulfill({
        body: sse([
          {
            fullText: reply,
            text: reply,
            type: "token",
          },
          {
            agentName: state.agentStatus.agentName,
            fullText: reply,
            type: "done",
            usage: {
              completionTokens: 12,
              promptTokens: 8,
              totalTokens: 20,
            },
          },
        ]),
        contentType: "text/event-stream",
        headers: {
          "cache-control": "no-cache",
        },
        status: 200,
      });
      return;
    }

    if (method === "GET" && path === "/api/plugins") {
      await fulfillJson({ plugins: state.plugins });
      return;
    }

    if (method === "GET" && path === "/api/plugins/core") {
      await fulfillJson({ core: [], optional: [] });
      return;
    }

    if (method === "GET" && path === "/api/skills") {
      await fulfillJson({ skills: state.skills });
      return;
    }

    if (method === "POST" && path === "/api/skills/refresh") {
      await fulfillJson({ ok: true, skills: state.skills });
      return;
    }

    if (method === "GET" && path === "/api/logs") {
      await fulfillJson({
        entries: state.logs,
        sources: ["runtime"],
        tags: ["startup"],
      });
      return;
    }

    if (method === "GET" && path === "/api/triggers") {
      await fulfillJson({ triggers: state.triggers });
      return;
    }

    if (method === "GET" && path === "/api/triggers/health") {
      await fulfillJson(state.triggerHealth);
      return;
    }

    const triggerRunsMatch =
      method === "GET" ? path.match(/^\/api\/triggers\/([^/]+)\/runs$/) : null;
    if (triggerRunsMatch) {
      const triggerId = decodeURIComponent(triggerRunsMatch[1]);
      await fulfillJson({ runs: state.triggerRunsById[triggerId] ?? [] });
      return;
    }

    if (method === "GET" && path === "/api/custom-actions") {
      await fulfillJson({ actions: state.customActions });
      return;
    }

    if (method === "GET" && path === "/api/security/audit") {
      const severity = url.searchParams.get("severity");
      const entries = severity
        ? state.securityEntries.filter((entry) => entry.severity === severity)
        : state.securityEntries;
      await fulfillJson({
        entries,
        replayed: true,
        totalBuffered: state.securityEntries.length,
      });
      return;
    }

    if (method === "GET" && path === "/api/runtime") {
      await fulfillJson(state.runtimeSnapshot);
      return;
    }

    if (method === "GET" && path === "/api/database/status") {
      await fulfillJson(state.databaseStatus);
      return;
    }

    if (method === "GET" && path === "/api/database/tables") {
      await fulfillJson({ tables: state.databaseTables });
      return;
    }

    const databaseRowsMatch =
      method === "GET"
        ? path.match(/^\/api\/database\/tables\/([^/]+)\/rows$/)
        : null;
    if (databaseRowsMatch) {
      const tableName = decodeURIComponent(databaseRowsMatch[1]);
      await fulfillJson(
        state.databaseRows[tableName] ?? {
          columns: [],
          rows: [],
          table: tableName,
        },
      );
      return;
    }

    if (method === "POST" && path === "/api/database/query") {
      await fulfillJson({
        columns: ["id", "content"],
        rows: [{ content: "Remember the sunrise briefing.", id: "mem-1" }],
      });
      return;
    }

    if (method === "GET" && path === "/api/trajectories") {
      await fulfillJson(state.trajectories.list);
      return;
    }

    if (method === "GET" && path === "/api/trajectories/stats") {
      await fulfillJson(state.trajectories.stats);
      return;
    }

    if (method === "GET" && path === "/api/trajectories/config") {
      await fulfillJson(state.trajectories.config);
      return;
    }

    if (method === "GET" && path === "/api/training/status") {
      await fulfillJson(state.trainingStatus);
      return;
    }

    if (method === "GET" && path === "/api/training/trajectories") {
      await fulfillJson(state.trainingTrajectoryList);
      return;
    }

    const trainingTrajectoryMatch =
      method === "GET"
        ? path.match(/^\/api\/training\/trajectories\/([^/]+)$/)
        : null;
    if (trainingTrajectoryMatch) {
      const trajectoryId = decodeURIComponent(trainingTrajectoryMatch[1]);
      await fulfillJson({
        trajectory: state.trainingTrajectoryDetails[trajectoryId],
      });
      return;
    }

    if (method === "GET" && path === "/api/training/datasets") {
      await fulfillJson({ datasets: state.trainingDatasets });
      return;
    }

    if (method === "GET" && path === "/api/training/jobs") {
      await fulfillJson({ jobs: state.trainingJobs });
      return;
    }

    if (method === "GET" && path === "/api/training/models") {
      await fulfillJson({ models: state.trainingModels });
      return;
    }

    if (method === "GET" && path === "/api/update/status") {
      await fulfillJson(state.updateStatus);
      return;
    }

    if (method === "GET" && path === "/api/subscription/status") {
      await fulfillJson({ providers: [] });
      return;
    }

    if (method === "GET" && path === "/api/cloud/status") {
      await fulfillJson(state.cloudStatus);
      return;
    }

    if (method === "GET" && path === "/api/cloud/credits") {
      await fulfillJson(state.cloudCredits);
      return;
    }

    if (method === "GET" && path === "/api/character") {
      await fulfillJson({ character: state.character });
      return;
    }

    if (method === "GET" && path === "/api/drop/status") {
      await fulfillJson(state.dropStatus);
      return;
    }

    if (method === "GET" && path === "/api/registry/status") {
      await fulfillJson(state.registryStatus);
      return;
    }

    if (method === "GET" && path === "/api/wallet/addresses") {
      await fulfillJson(state.walletAddresses);
      return;
    }

    if (method === "GET" && path === "/api/wallet/config") {
      await fulfillJson(state.walletConfig);
      return;
    }

    if (method === "GET" && path === "/api/wallet/balances") {
      await fulfillJson(state.walletBalances);
      return;
    }

    if (method === "GET" && path === "/api/wallet/nfts") {
      await fulfillJson(state.walletNfts);
      return;
    }

    if (method === "GET" && path === "/api/knowledge/documents") {
      await fulfillJson({
        documents: state.knowledgeDocuments,
        limit: 100,
        offset: 0,
        total: state.knowledgeDocuments.length,
      });
      return;
    }

    const knowledgeDocumentMatch =
      method === "GET"
        ? path.match(/^\/api\/knowledge\/documents\/([^/]+)$/)
        : null;
    if (knowledgeDocumentMatch) {
      const documentId = decodeURIComponent(knowledgeDocumentMatch[1]);
      const document = state.knowledgeDocuments.find((entry) => entry.id === documentId);
      await fulfillJson({
        document: {
          ...document,
          content: {
            text: "Milestone: ship Eliza Home end-to-end coverage.",
          },
        },
      });
      return;
    }

    const knowledgeFragmentsMatch =
      method === "GET"
        ? path.match(/^\/api\/knowledge\/fragments\/([^/]+)$/)
        : null;
    if (knowledgeFragmentsMatch) {
      const documentId = decodeURIComponent(knowledgeFragmentsMatch[1]);
      await fulfillJson(
        state.knowledgeFragments[documentId] ?? {
          count: 0,
          documentId,
          fragments: [],
        },
      );
      return;
    }

    if (method === "GET" && path === "/api/extension/status") {
      await fulfillJson(state.extensionStatus);
      return;
    }

    if (method === "GET" && path === "/api/permissions") {
      await fulfillJson(state.permissions);
      return;
    }

    const requestPermissionMatch =
      method === "POST"
        ? path.match(/^\/api\/permissions\/([^/]+)\/request$/)
        : null;
    if (requestPermissionMatch) {
      const permissionId = decodeURIComponent(requestPermissionMatch[1]);
      await fulfillJson({
        canRequest: true,
        id: permissionId,
        lastChecked: NOW,
        status: "granted",
      });
      return;
    }

    if (method === "GET" && path === "/api/stream/status") {
      await fulfillJson({
        audioSource: "system",
        destination: null,
        ffmpegAlive: false,
        frameCount: 0,
        inputMode: "stream-tab",
        muted: false,
        ok: true,
        running: state.stream.live,
        uptime: 0,
        volume: 100,
      });
      return;
    }

    if (method === "GET" && path === "/api/stream/settings") {
      await fulfillJson({
        ok: true,
        settings: state.stream.settings,
      });
      return;
    }

    if (method === "POST" && path === "/api/stream/settings") {
      const body = jsonBody(request);
      const nextSettings =
        body.settings && typeof body.settings === "object"
          ? (body.settings as Record<string, unknown>)
          : {};
      state.stream.settings = {
        ...state.stream.settings,
        ...nextSettings,
      };
      await fulfillJson({
        ok: true,
        settings: state.stream.settings,
      });
      return;
    }

    if (method === "GET" && path === "/api/streaming/destinations") {
      await fulfillJson({
        destinations: state.stream.destinations,
        ok: true,
      });
      return;
    }

    if (method === "GET" && path === "/api/stream/voice") {
      await fulfillJson(state.stream.voice);
      return;
    }

    if (method === "GET" && path === "/api/stream/overlay-layout") {
      await fulfillJson({ layout: state.stream.overlayLayout, ok: true });
      return;
    }

    if (method === "POST" && path === "/api/stream/overlay-layout") {
      const body = jsonBody(request);
      state.stream.overlayLayout =
        body.layout && typeof body.layout === "object"
          ? body.layout
          : state.stream.overlayLayout;
      await fulfillJson({ layout: state.stream.overlayLayout, ok: true });
      return;
    }

    if (method === "GET" && path === "/api/stream/source") {
      await fulfillJson({ source: state.stream.source });
      return;
    }

    if (method === "GET" && path === "/api/models") {
      const provider = url.searchParams.get("provider") ?? "unknown";
      await fulfillJson({
        models: [
          {
            category: "chat",
            id: `${provider}-default`,
            name: `${provider} Default`,
          },
        ],
        provider,
      });
      return;
    }

    if (method === "GET" && path === "/api/coding-agents/preflight") {
      await fulfillJson([
        { adapter: "claude", installed: true },
        { adapter: "gemini", installed: true },
        { adapter: "codex", installed: true },
        { adapter: "aider", installed: true },
      ]);
      return;
    }

    unhandledApiRequests.add(`${method} ${path}`);
    await fulfillJson(
      {
        error: "Unhandled mocked API route",
        method,
        path,
      },
      501,
    );
    },
  );

  return {
    async assertHealthy() {
      await page.waitForTimeout(150);
      expect(pageErrors).toEqual([]);
      expect(
        [...unhandledApiRequests],
        `Unhandled mocked API requests: ${[...unhandledApiRequests].join(", ")}`,
      ).toEqual([]);
    },
  };
}
