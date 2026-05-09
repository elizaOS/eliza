import { z } from "zod";
import {
  AgentDefaultsSchema,
  AgentEntrySchema,
  ToolsSchema,
} from "./zod-schema.agent-runtime.ts";
import {
  ChannelHeartbeatVisibilitySchema,
  GroupPolicySchema,
  HexColorSchema,
  MediaConfigSchema,
  ModelsConfigSchema,
  TranscribeAudioSchema,
} from "./zod-schema.core.ts";
import {
  HookMappingSchema,
  HooksGmailSchema,
  InstallRecordSchema,
  InternalHooksSchema,
} from "./zod-schema.hooks.ts";
import {
  BlueBubblesConnectorConfigSchema,
  CustomRtmpConfigSchema,
  DiscordConfigSchema,
  DiscordLocalConfigSchema,
  GoogleChatConfigSchema,
  IMessageConfigSchema,
  MSTeamsConfigSchema,
  NamedRtmpSourceSchema,
  PumpfunStreamConfigSchema,
  SignalConfigSchema,
  SlackConfigSchema,
  TelegramAccountConnectorSchema,
  TelegramConfigSchema,
  TwitchConnectorConfigSchema,
  TwitchStreamConfigSchema,
  TwitterConfigSchema,
  WhatsAppConfigSchema,
  XStreamConfigSchema,
  YoutubeStreamConfigSchema,
} from "./zod-schema.providers-core.ts";
import {
  CommandsSchema,
  MessagesSchema,
  SessionSchema,
  SessionSendPolicySchema,
} from "./zod-schema.session.ts";

// --- Agents (merged from zod-schema.agents.ts) ---

const AgentsSchema = z
  .object({
    defaults: z.lazy(() => AgentDefaultsSchema).optional(),
    list: z.array(AgentEntrySchema).optional(),
  })
  .strict()
  .optional();

const BindingsSchema = z
  .array(
    z
      .object({
        agentId: z.string(),
        match: z
          .object({
            channel: z.string(),
            accountId: z.string().optional(),
            peer: z
              .object({
                kind: z.union([
                  z.literal("dm"),
                  z.literal("group"),
                  z.literal("channel"),
                ]),
                id: z.string(),
              })
              .strict()
              .optional(),
            guildId: z.string().optional(),
            teamId: z.string().optional(),
          })
          .strict(),
      })
      .strict(),
  )
  .optional();

const BroadcastStrategySchema = z.enum(["parallel", "sequential"]);

const BroadcastSchema = z
  .object({
    strategy: BroadcastStrategySchema.optional(),
  })
  .catchall(z.array(z.string()))
  .optional();

const AudioSchema = z
  .object({
    transcription: TranscribeAudioSchema,
  })
  .strict()
  .optional();

// --- Approvals (merged from zod-schema.approvals.ts) ---

const ExecApprovalForwardTargetSchema = z
  .object({
    channel: z.string().min(1),
    to: z.string().min(1),
    accountId: z.string().optional(),
    threadId: z.union([z.string(), z.number()]).optional(),
  })
  .strict();

const ExecApprovalForwardingSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z
      .union([z.literal("session"), z.literal("targets"), z.literal("both")])
      .optional(),
    agentFilter: z.array(z.string()).optional(),
    sessionFilter: z.array(z.string()).optional(),
    targets: z.array(ExecApprovalForwardTargetSchema).optional(),
  })
  .strict()
  .optional();

const ApprovalsSchema = z
  .object({
    exec: ExecApprovalForwardingSchema,
  })
  .strict()
  .optional();

// --- Connectors (messaging platform connectors) ---

const ConnectorsSchema = z
  .object({
    defaults: z
      .object({
        groupPolicy: GroupPolicySchema.optional(),
        heartbeat: ChannelHeartbeatVisibilitySchema,
      })
      .strict()
      .optional(),
    bluebubbles: BlueBubblesConnectorConfigSchema.optional(),
    whatsapp: WhatsAppConfigSchema.optional(),
    telegram: TelegramConfigSchema.optional(),
    telegramAccount: TelegramAccountConnectorSchema.optional(),
    discord: DiscordConfigSchema.optional(),
    discordLocal: DiscordLocalConfigSchema.optional(),
    twitter: TwitterConfigSchema.optional(),
    googlechat: GoogleChatConfigSchema.optional(),
    slack: SlackConfigSchema.optional(),
    signal: SignalConfigSchema.optional(),
    imessage: IMessageConfigSchema.optional(),
    msteams: MSTeamsConfigSchema.optional(),
    twitch: TwitchConnectorConfigSchema.optional(),
  })
  .passthrough() // Allow extension connector configs (nostr, matrix, zalo, etc.)
  .optional();

// --- Streaming destinations ---

const StreamingSchema = z
  .object({
    activeDestination: z.string().optional(),
    twitch: TwitchStreamConfigSchema.optional(),
    youtube: YoutubeStreamConfigSchema.optional(),
    customRtmp: CustomRtmpConfigSchema.optional(),
    pumpfun: PumpfunStreamConfigSchema.optional(),
    x: XStreamConfigSchema.optional(),
    rtmpSources: z.array(NamedRtmpSourceSchema).optional(),
  })
  .passthrough() // Allow extension streaming destination configs
  .optional();

const BrowserSnapshotDefaultsSchema = z
  .object({
    mode: z.literal("efficient").optional(),
  })
  .strict()
  .optional();

const NodeHostSchema = z
  .object({
    browserProxy: z
      .object({
        enabled: z.boolean().optional(),
        allowProfiles: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const MemoryQmdPathSchema = z
  .object({
    path: z.string(),
    name: z.string().optional(),
    pattern: z.string().optional(),
  })
  .strict();

const MemoryQmdSessionSchema = z
  .object({
    enabled: z.boolean().optional(),
    exportDir: z.string().optional(),
    retentionDays: z.number().int().nonnegative().optional(),
  })
  .strict();

const MemoryQmdUpdateSchema = z
  .object({
    interval: z.string().optional(),
    debounceMs: z.number().int().nonnegative().optional(),
    onBoot: z.boolean().optional(),
    embedInterval: z.string().optional(),
  })
  .strict();

const MemoryQmdLimitsSchema = z
  .object({
    maxResults: z.number().int().positive().optional(),
    maxSnippetChars: z.number().int().positive().optional(),
    maxInjectedChars: z.number().int().positive().optional(),
    timeoutMs: z.number().int().nonnegative().optional(),
  })
  .strict();

const MemoryQmdSchema = z
  .object({
    command: z.string().optional(),
    includeDefaultMemory: z.boolean().optional(),
    paths: z.array(MemoryQmdPathSchema).optional(),
    sessions: MemoryQmdSessionSchema.optional(),
    update: MemoryQmdUpdateSchema.optional(),
    limits: MemoryQmdLimitsSchema.optional(),
    scope: SessionSendPolicySchema.optional(),
  })
  .strict();

const MemorySchema = z
  .object({
    backend: z.union([z.literal("builtin"), z.literal("qmd")]).optional(),
    citations: z
      .union([z.literal("auto"), z.literal("on"), z.literal("off")])
      .optional(),
    qmd: MemoryQmdSchema.optional(),
  })
  .strict()
  .optional();

const RolesSchema = z
  .object({
    connectorAdmins: z.record(z.string(), z.array(z.string())).optional(),
  })
  .strict()
  .optional();

// --- Character schema ---

const MessageExampleContentSchema = z
  .object({
    text: z.string().min(1),
    actions: z.array(z.string()).optional(),
  })
  .strict();

const MessageExampleSchema = z
  .object({
    name: z.string().min(1),
    content: MessageExampleContentSchema,
  })
  .strict();

const MessageExampleGroupSchema = z
  .object({
    examples: z.array(MessageExampleSchema).min(1),
  })
  .strict();

const CharacterStyleSchema = z
  .object({
    all: z.array(z.string()).optional(),
    chat: z.array(z.string()).optional(),
    post: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

const LinkedAccountSchema = z
  .object({
    status: z.union([z.literal("linked"), z.literal("unlinked")]).optional(),
    source: z
      .union([
        z.literal("api-key"),
        z.literal("oauth"),
        z.literal("credentials"),
        z.literal("subscription"),
      ])
      .optional(),
    userId: z.string().optional(),
    organizationId: z.string().optional(),
  })
  .strict();

const ServiceRouteSchema = z
  .object({
    backend: z.string().optional(),
    transport: z
      .union([
        z.literal("direct"),
        z.literal("cloud-proxy"),
        z.literal("remote"),
      ])
      .optional(),
    accountId: z.string().optional(),
    primaryModel: z.string().optional(),
    nanoModel: z.string().optional(),
    smallModel: z.string().optional(),
    mediumModel: z.string().optional(),
    largeModel: z.string().optional(),
    megaModel: z.string().optional(),
    responseHandlerModel: z.string().optional(),
    shouldRespondModel: z.string().optional(),
    actionPlannerModel: z.string().optional(),
    plannerModel: z.string().optional(),
    responseModel: z.string().optional(),
    mediaDescriptionModel: z.string().optional(),
    remoteApiBase: z.string().optional(),
  })
  .strict();

const ServiceRoutingSchema = z
  .object({
    llmText: ServiceRouteSchema.optional(),
    tts: ServiceRouteSchema.optional(),
    media: ServiceRouteSchema.optional(),
    embeddings: ServiceRouteSchema.optional(),
    rpc: ServiceRouteSchema.optional(),
  })
  .strict();

const DeploymentTargetSchema = z
  .object({
    runtime: z.union([
      z.literal("local"),
      z.literal("cloud"),
      z.literal("remote"),
    ]),
    provider: z
      .union([z.literal("elizacloud"), z.literal("remote")])
      .optional(),
    remoteApiBase: z.string().optional(),
    remoteAccessToken: z.string().optional(),
  })
  .strict();

export const CharacterSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    username: z.string().max(50).optional(),
    bio: z.union([z.string(), z.array(z.string())]).optional(),
    system: z.string().max(10000).optional(),
    adjectives: z.array(z.string().min(1).max(100)).optional(),
    topics: z.array(z.string().min(1).max(100)).optional(),
    style: CharacterStyleSchema,
    messageExamples: z.array(MessageExampleGroupSchema).optional(),
    postExamples: z.array(z.string()).optional(),
  })
  .strict();

// --- Main config schema ---

export const ElizaSchema = z
  .object({
    meta: z
      .object({
        onboardingComplete: z.boolean().optional(),
        lastTouchedVersion: z.string().optional(),
        lastTouchedAt: z.string().optional(),
      })
      .strict()
      .optional(),
    env: z
      .object({
        shellEnv: z
          .object({
            enabled: z.boolean().optional(),
            timeoutMs: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        vars: z.record(z.string(), z.string()).optional(),
      })
      .catchall(z.string())
      .optional(),
    deploymentTarget: DeploymentTargetSchema.optional(),
    linkedAccounts: z.record(z.string(), LinkedAccountSchema).optional(),
    serviceRouting: ServiceRoutingSchema.optional(),
    wizard: z
      .object({
        lastRunAt: z.string().optional(),
        lastRunVersion: z.string().optional(),
        lastRunCommit: z.string().optional(),
        lastRunCommand: z.string().optional(),
        lastRunMode: z
          .union([z.literal("local"), z.literal("remote")])
          .optional(),
      })
      .strict()
      .optional(),
    diagnostics: z
      .object({
        enabled: z.boolean().optional(),
        flags: z.array(z.string()).optional(),
        otel: z
          .object({
            enabled: z.boolean().optional(),
            endpoint: z.string().optional(),
            protocol: z
              .union([z.literal("http/protobuf"), z.literal("grpc")])
              .optional(),
            headers: z.record(z.string(), z.string()).optional(),
            serviceName: z.string().optional(),
            traces: z.boolean().optional(),
            metrics: z.boolean().optional(),
            logs: z.boolean().optional(),
            sampleRate: z.number().min(0).max(1).optional(),
            flushIntervalMs: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        cacheTrace: z
          .object({
            enabled: z.boolean().optional(),
            filePath: z.string().optional(),
            includeMessages: z.boolean().optional(),
            includePrompt: z.boolean().optional(),
            includeSystem: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    logging: z
      .object({
        level: z
          .union([
            z.literal("silent"),
            z.literal("fatal"),
            z.literal("error"),
            z.literal("warn"),
            z.literal("info"),
            z.literal("debug"),
            z.literal("trace"),
          ])
          .optional(),
        file: z.string().optional(),
        consoleLevel: z
          .union([
            z.literal("silent"),
            z.literal("fatal"),
            z.literal("error"),
            z.literal("warn"),
            z.literal("info"),
            z.literal("debug"),
            z.literal("trace"),
          ])
          .optional(),
        consoleStyle: z
          .union([z.literal("pretty"), z.literal("compact"), z.literal("json")])
          .optional(),
        redactSensitive: z
          .union([z.literal("off"), z.literal("tools")])
          .optional(),
        redactPatterns: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    update: z
      .object({
        channel: z
          .union([z.literal("stable"), z.literal("beta"), z.literal("dev")])
          .optional(),
        checkOnStart: z.boolean().optional(),
      })
      .strict()
      .optional(),
    browser: z
      .object({
        enabled: z.boolean().optional(),
        evaluateEnabled: z.boolean().optional(),
        cdpUrl: z.string().optional(),
        remoteCdpTimeoutMs: z.number().int().nonnegative().optional(),
        remoteCdpHandshakeTimeoutMs: z.number().int().nonnegative().optional(),
        color: z.string().optional(),
        executablePath: z.string().optional(),
        headless: z.boolean().optional(),
        noSandbox: z.boolean().optional(),
        attachOnly: z.boolean().optional(),
        defaultProfile: z.string().optional(),
        snapshotDefaults: BrowserSnapshotDefaultsSchema,
        profiles: z
          .record(
            z
              .string()
              .regex(
                /^[a-z0-9-]+$/,
                "Profile names must be alphanumeric with hyphens only",
              ),
            z
              .object({
                cdpPort: z.number().int().min(1).max(65535).optional(),
                cdpUrl: z.string().optional(),
                driver: z
                  .union([z.literal("cdp"), z.literal("extension")])
                  .optional(),
                color: HexColorSchema,
              })
              .strict()
              .refine((value) => value.cdpPort || value.cdpUrl, {
                message: "Profile must set cdpPort or cdpUrl",
              }),
          )
          .optional(),
      })
      .strict()
      .optional(),
    ui: z
      .object({
        seamColor: HexColorSchema.optional(),
        assistant: z
          .object({
            name: z.string().max(50).optional(),
            avatar: z.string().max(200).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    auth: z
      .object({
        profiles: z
          .record(
            z.string(),
            z
              .object({
                provider: z.string(),
                mode: z.union([
                  z.literal("api_key"),
                  z.literal("oauth"),
                  z.literal("token"),
                ]),
                email: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
        order: z.record(z.string(), z.array(z.string())).optional(),
        cooldowns: z
          .object({
            billingBackoffHours: z.number().positive().optional(),
            billingBackoffHoursByProvider: z
              .record(z.string(), z.number().positive())
              .optional(),
            billingMaxHours: z.number().positive().optional(),
            failureWindowHours: z.number().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    models: ModelsConfigSchema,
    nodeHost: NodeHostSchema,
    agents: AgentsSchema,
    tools: ToolsSchema,
    bindings: BindingsSchema,
    broadcast: BroadcastSchema,
    audio: AudioSchema,
    media: MediaConfigSchema,
    messages: MessagesSchema,
    commands: CommandsSchema,
    approvals: ApprovalsSchema,
    session: SessionSchema,
    cron: z
      .object({
        enabled: z.boolean().optional(),
        store: z.string().optional(),
        maxConcurrentRuns: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    hooks: z
      .object({
        enabled: z.boolean().optional(),
        path: z.string().optional(),
        token: z.string().optional(),
        maxBodyBytes: z.number().int().positive().optional(),
        presets: z.array(z.string()).optional(),
        transformsDir: z.string().optional(),
        mappings: z.array(HookMappingSchema).optional(),
        gmail: HooksGmailSchema,
        internal: InternalHooksSchema,
      })
      .strict()
      .optional(),
    web: z
      .object({
        enabled: z.boolean().optional(),
        heartbeatSeconds: z.number().int().positive().optional(),
        reconnect: z
          .object({
            initialMs: z.number().positive().optional(),
            maxMs: z.number().positive().optional(),
            factor: z.number().positive().optional(),
            jitter: z.number().min(0).max(1).optional(),
            maxAttempts: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    connectors: ConnectorsSchema,
    streaming: StreamingSchema,

    discovery: z
      .object({
        wideArea: z
          .object({
            enabled: z.boolean().optional(),
          })
          .strict()
          .optional(),
        mdns: z
          .object({
            mode: z.enum(["off", "minimal", "full"]).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    talk: z
      .object({
        voiceId: z.string().optional(),
        voiceAliases: z.record(z.string(), z.string()).optional(),
        modelId: z.string().optional(),
        outputFormat: z.string().optional(),
        apiKey: z.string().optional(),
        interruptOnSpeech: z.boolean().optional(),
      })
      .strict()
      .optional(),
    gateway: z
      .object({
        port: z.number().int().positive().optional(),
        mode: z.union([z.literal("local"), z.literal("remote")]).optional(),
        bind: z
          .union([
            z.literal("auto"),
            z.literal("lan"),
            z.literal("loopback"),
            z.literal("custom"),
            z.literal("tailnet"),
          ])
          .optional(),
        controlUi: z
          .object({
            enabled: z.boolean().optional(),
            basePath: z.string().optional(),
            root: z.string().optional(),
            allowedOrigins: z.array(z.string()).optional(),
            allowInsecureAuth: z.boolean().optional(),
            dangerouslyDisableDeviceAuth: z.boolean().optional(),
          })
          .strict()
          .optional(),
        auth: z
          .object({
            mode: z
              .union([z.literal("token"), z.literal("password")])
              .optional(),
            token: z.string().optional(),
            password: z.string().optional(),
            allowTailscale: z.boolean().optional(),
          })
          .strict()
          .optional(),
        trustedProxies: z.array(z.string()).optional(),
        tailscale: z
          .object({
            mode: z
              .union([
                z.literal("off"),
                z.literal("serve"),
                z.literal("funnel"),
              ])
              .optional(),
            resetOnExit: z.boolean().optional(),
          })
          .strict()
          .optional(),
        remote: z
          .object({
            url: z.string().optional(),
            transport: z
              .union([z.literal("ssh"), z.literal("direct")])
              .optional(),
            token: z.string().optional(),
            password: z.string().optional(),
            tlsFingerprint: z.string().optional(),
            sshTarget: z.string().optional(),
            sshIdentity: z.string().optional(),
          })
          .strict()
          .optional(),
        reload: z
          .object({
            mode: z
              .union([
                z.literal("off"),
                z.literal("restart"),
                z.literal("hot"),
                z.literal("hybrid"),
              ])
              .optional(),
            debounceMs: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
        tls: z
          .object({
            enabled: z.boolean().optional(),
            autoGenerate: z.boolean().optional(),
            certPath: z.string().optional(),
            keyPath: z.string().optional(),
            caPath: z.string().optional(),
          })
          .optional(),
        http: z
          .object({
            endpoints: z
              .object({
                chatCompletions: z
                  .object({
                    enabled: z.boolean().optional(),
                  })
                  .strict()
                  .optional(),
                responses: z
                  .object({
                    enabled: z.boolean().optional(),
                    maxBodyBytes: z.number().int().positive().optional(),
                    files: z
                      .object({
                        allowUrl: z.boolean().optional(),
                        allowedMimes: z.array(z.string()).optional(),
                        maxBytes: z.number().int().positive().optional(),
                        maxChars: z.number().int().positive().optional(),
                        maxRedirects: z.number().int().nonnegative().optional(),
                        timeoutMs: z.number().int().positive().optional(),
                        pdf: z
                          .object({
                            maxPages: z.number().int().positive().optional(),
                            maxPixels: z.number().int().positive().optional(),
                            minTextChars: z
                              .number()
                              .int()
                              .nonnegative()
                              .optional(),
                          })
                          .strict()
                          .optional(),
                      })
                      .strict()
                      .optional(),
                    images: z
                      .object({
                        allowUrl: z.boolean().optional(),
                        allowedMimes: z.array(z.string()).optional(),
                        maxBytes: z.number().int().positive().optional(),
                        maxRedirects: z.number().int().nonnegative().optional(),
                        timeoutMs: z.number().int().positive().optional(),
                      })
                      .strict()
                      .optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        nodes: z
          .object({
            browser: z
              .object({
                mode: z
                  .union([
                    z.literal("auto"),
                    z.literal("manual"),
                    z.literal("off"),
                  ])
                  .optional(),
                node: z.string().optional(),
              })
              .strict()
              .optional(),
            allowCommands: z.array(z.string()).optional(),
            denyCommands: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    memory: MemorySchema,
    roles: RolesSchema,
    embedding: z
      .object({
        model: z.string().optional(),
        modelRepo: z.string().optional(),
        dimensions: z.number().int().positive().optional(),
        contextSize: z.number().int().positive().optional(),
        gpuLayers: z
          .union([z.literal("auto"), z.literal("max"), z.number().int().min(0)])
          .optional(),
        idleTimeoutMinutes: z.number().min(0).optional(),
      })
      .strict()
      .optional(),
    skills: z
      .object({
        allowBundled: z.array(z.string()).optional(),
        denyBundled: z.array(z.string()).optional(),
        load: z
          .object({
            extraDirs: z.array(z.string()).optional(),
            watch: z.boolean().optional(),
            watchDebounceMs: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
        install: z
          .object({
            preferBrew: z.boolean().optional(),
            nodeManager: z
              .union([z.literal("npm"), z.literal("yarn"), z.literal("bun")])
              .optional(),
          })
          .strict()
          .optional(),
        entries: z
          .record(
            z.string(),
            z
              .object({
                enabled: z.boolean().optional(),
                apiKey: z.string().optional(),
                env: z.record(z.string(), z.string()).optional(),
                config: z.record(z.string(), z.unknown()).optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    plugins: z
      .object({
        enabled: z.boolean().optional(),
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
        load: z
          .object({
            paths: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        slots: z
          .object({
            memory: z.string().optional(),
          })
          .strict()
          .optional(),
        entries: z
          .record(
            z.string(),
            z
              .object({
                enabled: z.boolean().optional(),
                config: z.record(z.string(), z.unknown()).optional(),
              })
              .strict(),
          )
          .optional(),
        installs: z.record(z.string(), InstallRecordSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const agents = cfg.agents?.list ?? [];
    if (agents.length === 0) {
      return;
    }
    const agentIds = new Set(agents.map((agent) => agent.id));

    const broadcast = cfg.broadcast;
    if (!broadcast) {
      return;
    }

    for (const [peerId, ids] of Object.entries(broadcast)) {
      if (peerId === "strategy") {
        continue;
      }
      if (!Array.isArray(ids)) {
        continue;
      }
      for (let idx = 0; idx < ids.length; idx += 1) {
        const agentId = ids[idx];
        if (!agentIds.has(agentId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["broadcast", peerId, idx],
            message: `Unknown agent id "${agentId}" (not in agents.list).`,
          });
        }
      }
    }
  });
