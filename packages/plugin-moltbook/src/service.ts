/**
 * Moltbook Service
 *
 * Core service for Moltbook integration. This is the central coordination point
 * for all Moltbook operations - authentication, posting, voting, etc.
 *
 * ## WHY THIS ARCHITECTURE?
 *
 * 1. **Single Service Instance**: Each agent gets one service instance.
 *    This ensures per-agent state (credentials, rate limits) stays isolated.
 *    Multiple agents can run simultaneously without conflicts.
 *
 * 2. **Non-Blocking Start**: The start() method returns immediately.
 *    WHY? The elizaOS runtime initializes all services concurrently with
 *    a 30-second timeout. If we block (API calls, DB operations), we risk
 *    causing OTHER services to timeout. All heavy work happens in background.
 *
 * 3. **Credential Priority**: ENV var > Stored creds > Auto-register
 *    WHY? Existing users want to use their API key directly. New users want
 *    zero-config startup. The priority chain satisfies both.
 *
 * 4. **Memory-Based Persistence**: Credentials stored in elizaOS memory DB.
 *    WHY? Memory is per-agent and survives restarts. Each agent has its own
 *    isolated credentials. Deterministic UUIDs ensure reliable retrieval.
 *
 * 5. **Graceful Degradation**: If task service unavailable, continue without it.
 *    WHY? The plugin should enhance the agent, not break it. Core features
 *    (posting, voting) work without background tasks.
 */

import {
  createUniqueUuid,
  type EventPayload,
  type IAgentRuntime,
  type Memory,
  Service,
} from "@elizaos/core";
import {
  AUTONOMY_DEFAULTS,
  CONTENT_LIMITS,
  CRED_MEMORY_KEY,
  CYCLE_INTERVAL_MS,
  MOLTBOOK_CYCLE_TASK,
  PLUGIN_NAME,
} from "./constants";
import * as api from "./lib/api";
import { getAgentState, getRateLimitStatus } from "./lib/rateLimiter";
import { moltbookCycleWorker } from "./tasks/index";
import type {
  CacheOptions,
  MoltbookComment,
  MoltbookCredentials,
  MoltbookFeed,
  MoltbookPost,
  MoltbookProfile,
  MoltbookSearchResults,
  MoltbookSubmolt,
} from "./types";
import { MEMORY_TABLES, MoltbookEventTypes } from "./types";

export class MoltbookService extends Service {
  /**
   * Service identifier used by runtime.getService('moltbook')
   * Must be unique across all plugins.
   */
  static serviceType = PLUGIN_NAME;

  /**
   * Human-readable description shown in agent capabilities.
   * Helps the agent understand what this service enables.
   */
  capabilityDescription =
    "Enables the agent to participate in the Moltbook social network - posting, commenting, voting, and engaging with the community.";

  /** Tracks if service has been started (prevents double-start) */
  private isRunning = false;

  /**
   * Settings for autonomy and new API methods (from next branch)
   */
  private settings: any = null;

  /**
   * Autonomy loop state (from next branch)
   */
  private autonomyRunning = false;
  private autonomyStepCount = 0;
  private autonomyTimeout: ReturnType<typeof setTimeout> | null = null;
  private initializationPromise: Promise<void> | null = null;
  private memory: string[] = [];

  constructor(protected runtime: IAgentRuntime) {
    super(runtime);
  }

  // ===========================================================================
  // SERVICE LIFECYCLE
  // ===========================================================================

  /**
   * Static factory method called by elizaOS runtime.
   *
   * WHY static? elizaOS service registration expects a static start method
   * that creates and initializes the service instance.
   */
  static async start(runtime: IAgentRuntime): Promise<MoltbookService> {
    const service = new MoltbookService(runtime);
    await service.start();
    return service;
  }

  /**
   * Static stop method for runtime cleanup.
   */
  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(MoltbookService.serviceType);
    if (!service) {
      throw new Error("Moltbook service not found");
    }
    await service.stop();
  }

  /**
   * Start the service.
   *
   * CRITICAL: This method MUST return immediately!
   *
   * WHY? The elizaOS runtime starts all services concurrently with a 30-second
   * timeout. If we block here (API calls, DB operations, waiting for other
   * services), we risk:
   *
   * 1. Our own service timing out
   * 2. Blocking other services from starting
   * 3. Causing a cascade of timeout failures
   *
   * SOLUTION: Use setImmediate() to defer ALL heavy work to the next event
   * loop tick. This allows start() to return instantly while initialization
   * happens in the background.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.runtime.logger.warn("Moltbook service is already running");
      return;
    }

    this.runtime.logger.info("Starting Moltbook service...");
    this.isRunning = true;

    // CRITICAL: Return immediately - do NOT await anything!
    // All heavy work happens in background after runtime is ready.
    //
    // WHY setImmediate? It schedules work for the next event loop iteration,
    // ensuring this function returns before any async work begins.
    setImmediate(() => {
      this.initializeInBackground();
    });
  }

  /**
   * Kick off background initialization with proper error handling.
   *
   * WHY a separate method? Cleaner separation of concerns. The start() method
   * handles the immediate return, this method handles the async work.
   *
   * WHY .catch() at the end? Promises without catch handlers cause
   * "unhandled promise rejection" warnings/errors. This ensures ANY error
   * from initialization is caught and logged, not thrown to the runtime.
   */
  private initializeInBackground(): void {
    this.initializationPromise = this.doInitialization().catch((error) => {
      // This catch handles any errors that slip through the inner try-catch
      this.runtime.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Unhandled error during Moltbook initialization"
      );
    });
  }

  /**
   * Actual initialization logic.
   *
   * ORDER MATTERS:
   * 1. Wait for runtime.initPromise - ensures DB, other core services ready
   * 2. Authenticate - may need DB for credential storage
   * 3. Wait for task service - we depend on it for scheduling
   * 4. Register task worker and create tasks
   *
   * WHY separated from initializeInBackground? The outer method handles the
   * promise wrapper with .catch(). This method contains the actual logic,
   * making it easier to read and maintain.
   */
  private async doInitialization(): Promise<void> {
    try {
      // Step 1: Wait for runtime to be fully ready
      // WHY? The runtime may still be initializing DB, loading other plugins, etc.
      // Operations that need DB or other services would fail without this.
      await this.runtime.initPromise;
      this.runtime.logger.debug("Runtime init complete, continuing Moltbook initialization");

      // Initialize settings for new API methods from next branch
      const { getMoltbookSettings } = await import("./environment");
      this.settings = getMoltbookSettings(this.runtime);

      // Start autonomy loop if enabled
      if (this.settings.autonomousMode) {
        this.runtime.logger.info("Autonomy mode enabled, starting autonomy loop");
        this.startAutonomyLoop();
      }

      // Step 2: Ensure we have valid credentials
      // WHY before task service? Authentication doesn't need the task service,
      // and we want credentials ready ASAP for any API calls.
      const autoRegister = this.runtime.getSetting("MOLTBOOK_AUTO_REGISTER") !== "false";
      if (autoRegister) {
        await this.ensureAuthenticated();
      }

      // Step 3: Wait for task service, then set up periodic tasks
      // WHY explicit wait? Calling registerTaskWorker or createTask before
      // the task service is ready would fail silently or error.
      try {
        this.runtime.logger.debug("Waiting for task service...");
        await this.runtime.getServiceLoadPromise("task");
        this.runtime.logger.debug("Task service ready");

        // Register our task worker - tells runtime how to execute MOLTBOOK_CYCLE tasks
        this.runtime.registerTaskWorker(moltbookCycleWorker);
        this.runtime.logger.debug("Registered MOLTBOOK_CYCLE task worker");

        // Create the periodic task (if it doesn't already exist)
        await this.setupCycleTask();
      } catch (taskError) {
        // GRACEFUL DEGRADATION: If task service unavailable, continue without it.
        // WHY? The plugin should enhance the agent, not break it.
        // Core features (posting, voting) still work without background tasks.
        this.runtime.logger.warn(
          { error: taskError instanceof Error ? taskError.message : String(taskError) },
          "Task service not available, cycle task will not be enabled"
        );
      }

      this.runtime.logger.info("Moltbook service initialization completed");
    } catch (error) {
      this.runtime.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Error during Moltbook service initialization"
      );
      // Re-throw so the outer .catch() can handle cleanup if needed
      throw error;
    }
  }

  /**
   * Setup the periodic cycle task
   */
  private async setupCycleTask(): Promise<void> {
    try {
      // Check if task already exists
      const existingTasks = await this.runtime.getTasksByName(MOLTBOOK_CYCLE_TASK);
      const agentTasks = existingTasks.filter((t) => t.worldId === this.runtime.agentId);

      if (agentTasks.length > 0) {
        this.runtime.logger.debug(
          { taskCount: agentTasks.length },
          "Moltbook cycle task already exists"
        );
        return;
      }

      // Create the periodic task
      await this.runtime.createTask({
        name: MOLTBOOK_CYCLE_TASK,
        description: "Periodic Moltbook community engagement cycle",
        worldId: this.runtime.agentId,
        metadata: {
          createdAt: Date.now() as any,
          updatedAt: Date.now() as any,
          updateInterval: CYCLE_INTERVAL_MS as any,
        },
        tags: ["queue", "repeat", "moltbook"],
      });

      this.runtime.logger.info(
        { intervalMinutes: CYCLE_INTERVAL_MS / 60000 },
        "Created Moltbook cycle task"
      );
    } catch (error) {
      this.runtime.logger.error({ error }, "Error setting up Moltbook cycle task");
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.runtime.logger.warn("Moltbook service is not running");
      return;
    }

    this.runtime.logger.info("Stopping Moltbook service...");

    // Stop autonomy loop if running
    this.stopAutonomyLoop();

    // Wait for any in-flight startup work before fully shutting down.
    if (this.initializationPromise) {
      try {
        await this.initializationPromise;
      } catch {
        // Initialization errors are already logged in initializeInBackground.
      } finally {
        this.initializationPromise = null;
      }
    }

    this.isRunning = false;
    this.runtime.logger.info("Moltbook service stopped");
  }

  // ===========================================================================
  // AUTHENTICATION
  // ===========================================================================

  /**
   * Ensure the agent has valid Moltbook credentials.
   * Priority: 1) MOLTBOOK_API_KEY env var, 2) stored credentials, 3) auto-register
   */
  async ensureAuthenticated(): Promise<MoltbookCredentials | null> {
    this.runtime.logger.debug("Moltbook: Checking authentication");

    // 1. Check for pre-configured API key (user already has an account)
    const envApiKey = this.runtime.getSetting("MOLTBOOK_API_KEY");
    if (envApiKey && typeof envApiKey === "string") {
      this.runtime.logger.debug("Moltbook: Found API key in settings, validating...");

      const validation = await api.validateKey(
        String(this.runtime.agentId),
        envApiKey,
        this.runtime.logger
      );
      if (validation.success && validation.data?.valid) {
        this.runtime.logger.info(
          { username: validation.data.name, isClaimed: validation.data.isClaimed },
          "Moltbook: API key from settings is valid"
        );

        const creds: MoltbookCredentials = {
          apiKey: String(envApiKey),
          userId: validation.data.name,
          username: validation.data.name,
          registeredAt: Date.now(),
          claimStatus: validation.data.isClaimed ? "claimed" : "unclaimed",
        };

        await this.saveCredentials(creds);
        return creds;
      }

      this.runtime.logger.warn(
        { error: validation.error },
        "Moltbook: API key from settings is invalid"
      );
    }

    // 2. Try to load existing credentials from memory
    let creds = await this.loadCredentials();

    if (creds) {
      this.runtime.logger.debug(
        { username: creds.username },
        "Moltbook: Found stored credentials, validating..."
      );

      // Validate the stored credentials via /agents/me
      const validation = await api.validateKey(
        this.runtime.agentId,
        creds.apiKey,
        this.runtime.logger
      );

      if (validation.success && validation.data?.valid) {
        this.runtime.logger.info(
          { username: validation.data.name, isClaimed: validation.data.isClaimed },
          "Moltbook: Credentials valid"
        );

        // Update claim status
        creds.claimStatus = validation.data.isClaimed ? "claimed" : "unclaimed";
        await this.saveCredentials(creds);

        return creds;
      }

      // Check if it's a 401 "not yet claimed" - this is NOT invalid credentials!
      // The API key is valid, but the human hasn't claimed the agent yet
      if (validation.status === 401 && validation.error?.includes("not yet claimed")) {
        // Extract claim URL from error hint
        const claimMatch = validation.error.match(/https:\/\/moltbook\.com\/claim\/[^\s"]+/);
        const claimUrl = claimMatch ? claimMatch[0] : creds.claimUrl;

        this.runtime.logger.info(
          { username: creds.username, claimUrl },
          "Moltbook: Agent registered but not yet claimed - credentials are still valid"
        );

        // Update credentials with claim status and URL
        creds.claimStatus = "unclaimed";
        if (claimUrl) {
          creds.claimUrl = claimUrl;
        }
        await this.saveCredentials(creds);

        // Log prominent banner for claim
        if (claimUrl) {
          this.logClaimBanner(creds.username, claimUrl, "Already registered");
        }

        return creds;
      }

      // Credentials truly invalid (not just unclaimed), clear them
      this.runtime.logger.warn(
        { error: validation.error, status: validation.status },
        "Moltbook: Stored credentials are invalid, will re-register"
      );
      creds = null;
    } else {
      this.runtime.logger.debug("Moltbook: No stored credentials found");
    }

    // 3. Register a new account
    const autoRegister = this.runtime.getSetting("MOLTBOOK_AUTO_REGISTER") !== "false";
    if (!autoRegister) {
      this.runtime.logger.info(
        "Moltbook: MOLTBOOK_AUTO_REGISTER is disabled, skipping registration"
      );
      return null;
    }

    return await this.registerNewAccount();
  }

  /**
   * Register a new Moltbook account for this agent
   * Per API: POST /agents/register with {name, description}
   *
   * Names are prefixed with "eos_" to identify elizaOS agents.
   * Name rules: 3-30 chars, alphanumeric with underscores/hyphens only.
   * Will retry with a unique suffix if name is taken (409 Conflict)
   */
  private async registerNewAccount(): Promise<MoltbookCredentials | null> {
    const characterName = this.runtime.character.name || "ElizaAgent";

    // Sanitize name for Moltbook API requirements
    // WHY all this complexity? Character names can contain:
    // - Unicode fancy text (𝚎𝚕𝚒𝚣𝚊 → eliza)
    // - Emojis (🤖 Agent → Agent)
    // - Special characters (Agent.v2 → Agent_v2)
    const sanitized = this.sanitizeAgentName(characterName);

    // Prefix with eos_ to identify elizaOS agents
    // Max 30 chars total, so leave room for "eos_" prefix (4 chars) and suffix (5 chars)
    const baseName = `eos_${sanitized}`.slice(0, 25);

    // Build description from character bio
    const bio = this.runtime.character.bio;
    const description = bio
      ? (Array.isArray(bio) ? bio.join(" ") : bio).slice(0, 200)
      : `An elizaOS agent named ${characterName}`;

    // Try up to 3 times with different suffixes
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // First attempt uses the name as-is, subsequent attempts add suffix
      const suffix = attempt === 0 ? "" : `_${Math.random().toString(36).slice(2, 6)}`;
      const agentName = `${baseName}${suffix}`;

      this.runtime.logger.info(
        {
          agentName,
          attempt: attempt + 1,
          maxAttempts,
        },
        "Moltbook: Attempting to register new agent"
      );

      const result = await api.register(
        this.runtime.agentId,
        agentName,
        description,
        this.runtime.logger
      );

      if (result.success && result.data) {
        const creds: MoltbookCredentials = {
          apiKey: result.data.apiKey,
          userId: agentName,
          username: agentName,
          registeredAt: Date.now(),
          claimStatus: "unclaimed",
          claimUrl: result.data.claimUrl,
        };

        await this.saveCredentials(creds);

        // Log prominent claim banner
        this.logClaimBanner(agentName, creds.claimUrl!, result.data.verificationCode);

        return creds;
      }

      // Check if name was taken (409 Conflict) - retry with suffix
      if (result.status === 409) {
        this.runtime.logger.warn(
          { agentName, attempt: attempt + 1 },
          "Moltbook: Name already taken, will try with suffix"
        );
        continue;
      }

      // Other error - don't retry
      this.runtime.logger.error(
        {
          error: result.error,
          status: result.status,
          agentName,
        },
        "Moltbook: Failed to register agent"
      );
      return null;
    }

    this.runtime.logger.error(
      { baseName, attempts: maxAttempts },
      "Moltbook: Failed to register after multiple attempts. Set MOLTBOOK_API_KEY if you already have an account."
    );
    return null;
  }

  /**
   * Sanitize a character name for Moltbook API requirements.
   *
   * WHY THIS COMPLEXITY?
   * Character names can contain all sorts of things:
   * - Unicode fancy text: 𝚎𝚕𝚒𝚣𝚊, 𝕖𝕝𝕚𝕫𝕒, ᴇʟɪᴢᴀ
   * - Emojis: 🤖 Agent, Agent 🚀
   * - Special chars: Agent.v2, Agent (Beta)
   *
   * Moltbook requires: 3-30 chars, alphanumeric + underscores/hyphens only.
   *
   * Our approach:
   * 1. Normalize Unicode to ASCII equivalents (NFKD normalization)
   * 2. Replace spaces/dots with underscores
   * 3. Strip remaining invalid characters
   * 4. Fall back to generated name if result is empty
   */
  private sanitizeAgentName(name: string): string {
    // Step 1: Normalize Unicode to ASCII equivalents
    // NFKD decomposition converts fancy Unicode to base characters
    // e.g., 𝚎 → e, 𝕖 → e, ᴇ → E
    let normalized = name.normalize("NFKD");

    // Step 2: Remove diacritical marks (accents, etc.)
    // After NFKD, accented chars become base char + combining mark
    // e.g., é → e + ́ (combining acute accent)
    // This regex removes the combining marks
    normalized = normalized.replace(/[\u0300-\u036f]/g, "");

    // Step 3: Replace spaces and dots with underscores
    let sanitized = normalized.replace(/[\s.]+/g, "_");

    // Step 4: Remove any remaining non-alphanumeric chars (except _ and -)
    sanitized = sanitized.replace(/[^a-zA-Z0-9_-]/g, "");

    // Step 5: Clean up underscores
    sanitized = sanitized
      .replace(/_+/g, "_") // Collapse multiple underscores
      .replace(/^_|_$/g, ""); // Trim leading/trailing underscores

    // Step 6: If we ended up with nothing useful, generate a fallback
    // WHY? Some names are entirely emojis or unsupported Unicode
    if (sanitized.length < 2) {
      // Use first 8 chars of agent ID as fallback (deterministic per agent)
      const agentIdShort = this.runtime.agentId.replace(/-/g, "").slice(0, 8);
      sanitized = `agent_${agentIdShort}`;
      this.runtime.logger.warn(
        { originalName: name, fallbackName: sanitized },
        "Moltbook: Character name could not be sanitized, using fallback"
      );
    }

    return sanitized;
  }

  /**
   * Log a prominent claim banner for new registrations
   */
  private logClaimBanner(agentName: string, claimUrl: string, verificationCode: string): void {
    const banner = `

╔══════════════════════════════════════════════════════════════════════════════╗
║                                                                              ║
║   🦞  MOLTBOOK REGISTRATION SUCCESSFUL!                                      ║
║                                                                              ║
║   Agent: ${agentName.padEnd(65)}║
║   Code:  ${verificationCode.padEnd(65)}║
║                                                                              ║
║   ⚠️  YOUR HUMAN NEEDS TO CLAIM THIS ACCOUNT:                                ║
║                                                                              ║
║   ${claimUrl.padEnd(72)}║
║                                                                              ║
║   Share this link with your human owner to activate your Moltbook account.   ║
║   They'll verify via Twitter/X and you'll be ready to post!                  ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝

`;
    // Use console.log for maximum visibility (bypasses log level filtering)
    console.log(banner);

    // Also log structured data for programmatic access
    this.runtime.logger.info(
      { agentName, claimUrl, verificationCode },
      "Moltbook registration complete - claim URL above"
    );
  }

  /**
   * Load credentials from elizaOS memory
   */
  private async loadCredentials(): Promise<MoltbookCredentials | null> {
    try {
      // Use deterministic ID for reliable retrieval
      const credId = createUniqueUuid(this.runtime, CRED_MEMORY_KEY);
      const memories = await this.runtime.getMemoriesByIds([credId], MEMORY_TABLES.CREDENTIALS);

      if (memories && memories.length > 0) {
        const memory = memories[0];
        const metadata = memory.metadata as any;
        if (metadata?.credentials) {
          return metadata.credentials as MoltbookCredentials;
        }
      }

      return null;
    } catch (error) {
      this.runtime.logger.error({ error }, "Error loading Moltbook credentials");
      return null;
    }
  }

  /**
   * Save credentials to elizaOS memory
   */
  private async saveCredentials(creds: MoltbookCredentials): Promise<void> {
    try {
      const credId = createUniqueUuid(this.runtime, CRED_MEMORY_KEY);

      // Check if memory already exists
      const existing = await this.runtime.getMemoriesByIds([credId], MEMORY_TABLES.CREDENTIALS);

      if (existing && existing.length > 0) {
        // Update existing
        await this.runtime.updateMemory({
          id: credId,
          metadata: {
            type: "moltbook_credentials",
            credentials: creds,
          } as any,
        });
      } else {
        // Create new
        const memory: Memory = {
          id: credId,
          entityId: this.runtime.agentId,
          agentId: this.runtime.agentId,
          roomId: this.runtime.agentId,
          content: {
            text: `Moltbook credentials for ${creds.username}`,
          },
          createdAt: Date.now(),
          metadata: {
            type: "moltbook_credentials",
            credentials: creds,
          } as any,
        };

        await this.runtime.createMemory(memory, MEMORY_TABLES.CREDENTIALS);
      }

      // Also store in agent state for fast access
      const state = getAgentState(this.runtime.agentId);
      state.credentials = creds;

      this.runtime.logger.debug("Moltbook credentials saved");
    } catch (error) {
      this.runtime.logger.error({ error }, "Error saving Moltbook credentials");
      throw error;
    }
  }

  /**
   * Get current credentials (from cache or memory)
   */
  async getCredentials(): Promise<MoltbookCredentials | null> {
    // Check cache first
    const state = getAgentState(this.runtime.agentId);
    if (state.credentials) {
      return state.credentials;
    }

    // Load from memory
    return await this.loadCredentials();
  }

  // ===========================================================================
  // FEED OPERATIONS
  // ===========================================================================

  /**
   * Get the personalized feed
   * Per API: GET /feed?sort=hot&limit=25
   */
  async getFeed(
    options: CacheOptions & {
      sort?: "hot" | "new" | "top" | "rising";
      limit?: number;
    } = {}
  ): Promise<MoltbookFeed | null> {
    const creds = await this.getCredentials();
    if (!creds) {
      this.runtime.logger.warn("Cannot get feed: not authenticated");
      return null;
    }

    // Check cache (only if using default sort)
    const state = getAgentState(this.runtime.agentId);
    if (!options.forceFresh && !options.sort && state.feedCache) {
      const age = Date.now() - state.feedCache.fetchedAt;
      const maxAge = options.maxAge ?? 5 * 60 * 1000; // 5 min default

      if (age < maxAge) {
        if (!options.newerThan || state.feedCache.fetchedAt > options.newerThan) {
          return state.feedCache.data;
        }
      }
    }

    // Fetch fresh
    const result = await api.getFeed(this.runtime.agentId, creds.apiKey, {
      sort: options.sort,
      limit: options.limit,
      logger: this.runtime.logger,
    });

    if (result.success && result.data) {
      // Update cache
      state.feedCache = {
        data: result.data,
        fetchedAt: Date.now(),
      };
      return result.data;
    }

    this.runtime.logger.error({ error: result.error }, "Failed to get feed");
    return state.feedCache?.data ?? null;
  }

  /**
   * Get global posts (not personalized, from all submolts)
   * Per API: GET /posts?sort=hot&limit=25
   */
  async getPosts(
    options: CacheOptions & {
      sort?: "hot" | "new" | "top" | "rising";
      submolt?: string;
      limit?: number;
    } = {}
  ): Promise<MoltbookFeed | null> {
    const creds = await this.getCredentials();
    if (!creds) {
      this.runtime.logger.warn("Cannot get posts: not authenticated");
      return null;
    }

    const result = await api.getPosts(this.runtime.agentId, creds.apiKey, {
      sort: options.sort,
      submolt: options.submolt,
      limit: options.limit,
      logger: this.runtime.logger,
    });

    if (result.success && result.data) {
      // Emit event (from next branch)
      this.runtime.emitEvent(
        MoltbookEventTypes.POSTS_BROWSED as string,
        {
          runtime: this.runtime,
          source: "moltbook",
        } as EventPayload
      );

      return result.data;
    }

    this.runtime.logger.error({ error: result.error }, "Failed to get posts");
    return null;
  }

  // ===========================================================================
  // POST OPERATIONS
  // ===========================================================================

  /**
   * Create a new post
   * Per API: POST /posts with {submolt, title, content}
   */
  async createPost(title: string, content: string, submolt?: string): Promise<MoltbookPost | null> {
    const creds = await this.getCredentials();
    if (!creds) {
      this.runtime.logger.warn("Cannot create post: not authenticated");
      return null;
    }

    // Content validation (from next branch)
    if (title.length > CONTENT_LIMITS.maxTitleLength) {
      this.runtime.logger.error(
        `Title exceeds maximum length of ${CONTENT_LIMITS.maxTitleLength} characters`
      );
      return null;
    }
    if (content.length > CONTENT_LIMITS.maxContentLength) {
      this.runtime.logger.error(
        `Content exceeds maximum length of ${CONTENT_LIMITS.maxContentLength} characters`
      );
      return null;
    }

    const result = await api.createPost(
      this.runtime.agentId,
      creds.apiKey,
      {
        title,
        content,
        submolt,
      },
      this.runtime.logger
    );

    if (result.success && result.data) {
      // Emit event (from next branch)
      this.runtime.emitEvent(
        MoltbookEventTypes.POST_CREATED as string,
        {
          runtime: this.runtime,
          source: "moltbook",
        } as EventPayload
      );

      this.runtime.logger.info({ postId: result.data.id, title }, "Created Moltbook post");
      return result.data;
    }

    this.runtime.logger.error({ error: result.error }, "Failed to create post");
    return null;
  }

  /**
   * Get a post by ID
   */
  async getPost(postId: string): Promise<MoltbookPost | null> {
    const creds = await this.getCredentials();
    if (!creds) return null;

    const result = await api.getPost(
      this.runtime.agentId,
      creds.apiKey,
      postId,
      this.runtime.logger
    );

    if (result.success && result.data) {
      // Emit event (from next branch)
      this.runtime.emitEvent(
        MoltbookEventTypes.POST_READ as string,
        {
          runtime: this.runtime,
          source: "moltbook",
        } as EventPayload
      );
    }

    return result.success ? (result.data ?? null) : null;
  }

  /**
   * Delete a post
   * Per API: DELETE /posts/POST_ID
   */
  async deletePost(postId: string): Promise<boolean> {
    const creds = await this.getCredentials();
    if (!creds) return false;

    const result = await api.deletePost(
      this.runtime.agentId,
      creds.apiKey,
      postId,
      this.runtime.logger
    );

    if (result.success) {
      this.runtime.logger.info({ postId }, "Deleted Moltbook post");
    }

    return result.success;
  }

  // ===========================================================================
  // COMMENT OPERATIONS
  // ===========================================================================

  /**
   * Create a comment on a post
   */
  async createComment(
    postId: string,
    content: string,
    parentId?: string
  ): Promise<MoltbookComment | null> {
    const creds = await this.getCredentials();
    if (!creds) {
      this.runtime.logger.warn("Cannot create comment: not authenticated");
      return null;
    }

    // Content validation (from next branch)
    if (content.length > CONTENT_LIMITS.maxCommentLength) {
      this.runtime.logger.error(
        `Comment exceeds maximum length of ${CONTENT_LIMITS.maxCommentLength} characters`
      );
      return null;
    }

    const result = await api.createComment(
      this.runtime.agentId,
      creds.apiKey,
      postId,
      {
        content,
        parentId,
      },
      this.runtime.logger
    );

    if (result.success && result.data) {
      // Emit event (from next branch)
      this.runtime.emitEvent(
        MoltbookEventTypes.COMMENT_CREATED as string,
        {
          runtime: this.runtime,
          source: "moltbook",
        } as EventPayload
      );

      this.runtime.logger.info({ postId, commentId: result.data.id }, "Created Moltbook comment");
      return result.data;
    }

    this.runtime.logger.error({ error: result.error }, "Failed to create comment");
    return null;
  }

  /**
   * Get comments for a post
   */
  async getComments(postId: string): Promise<MoltbookComment[]> {
    const creds = await this.getCredentials();
    if (!creds) return [];

    const result = await api.getComments(
      this.runtime.agentId,
      creds.apiKey,
      postId,
      this.runtime.logger
    );
    return result.success ? (result.data ?? []) : [];
  }

  // ===========================================================================
  // VOTE OPERATIONS
  // ===========================================================================

  /**
   * Vote on a post
   */
  /**
   * Vote on a post (upvote or downvote)
   * Note: Moltbook API has separate endpoints for upvote/downvote, no "none" option
   */
  async votePost(postId: string, direction: "up" | "down"): Promise<boolean> {
    const creds = await this.getCredentials();
    if (!creds) return false;

    const result = await api.votePost(
      this.runtime.agentId,
      creds.apiKey,
      postId,
      direction,
      this.runtime.logger
    );

    if (result.success) {
      this.runtime.logger.debug({ postId, direction }, "Voted on post");
    }

    return result.success;
  }

  /**
   * Vote on a comment (upvote or downvote)
   */
  async voteComment(commentId: string, direction: "up" | "down"): Promise<boolean> {
    const creds = await this.getCredentials();
    if (!creds) return false;

    const result = await api.voteComment(
      this.runtime.agentId,
      creds.apiKey,
      commentId,
      direction,
      this.runtime.logger
    );

    return result.success;
  }

  // ===========================================================================
  // FOLLOW OPERATIONS
  // ===========================================================================

  /**
   * Follow a molty by name
   */
  async follow(moltyName: string): Promise<boolean> {
    const creds = await this.getCredentials();
    if (!creds) return false;

    const result = await api.followUser(
      this.runtime.agentId,
      creds.apiKey,
      moltyName,
      this.runtime.logger
    );

    if (result.success) {
      this.runtime.logger.debug({ moltyName }, "Followed molty");
    }

    return result.success;
  }

  /**
   * Unfollow a molty by name
   */
  async unfollow(moltyName: string): Promise<boolean> {
    const creds = await this.getCredentials();
    if (!creds) return false;

    const result = await api.unfollowUser(
      this.runtime.agentId,
      creds.apiKey,
      moltyName,
      this.runtime.logger
    );

    return result.success;
  }

  // ===========================================================================
  // PROFILE OPERATIONS
  // ===========================================================================

  /**
   * Get own profile via /agents/me
   */
  async getOwnProfile(options: CacheOptions = {}): Promise<MoltbookProfile | null> {
    const creds = await this.getCredentials();
    if (!creds) return null;

    // Check cache
    const state = getAgentState(this.runtime.agentId);
    if (!options.forceFresh && state.profileCache) {
      const age = Date.now() - state.profileCache.fetchedAt;
      const maxAge = options.maxAge ?? 15 * 60 * 1000; // 15 min default

      if (age < maxAge) {
        return state.profileCache.data;
      }
    }

    const result = await api.getMyProfile(this.runtime.agentId, creds.apiKey, this.runtime.logger);

    if (result.success && result.data) {
      state.profileCache = {
        data: result.data,
        fetchedAt: Date.now(),
      };
      return result.data;
    }

    return state.profileCache?.data ?? null;
  }

  /**
   * Get another molty's profile by name
   */
  async getProfile(moltyName: string): Promise<MoltbookProfile | null> {
    const creds = await this.getCredentials();
    if (!creds) return null;

    const result = await api.getProfileByName(
      this.runtime.agentId,
      creds.apiKey,
      moltyName,
      this.runtime.logger
    );

    return result.success ? (result.data ?? null) : null;
  }

  // ===========================================================================
  // SUBMOLT OPERATIONS
  // ===========================================================================

  /**
   * Get list of all submolts
   */
  async getSubmolts(_sort?: string): Promise<MoltbookSubmolt[] | null> {
    const creds = await this.getCredentials();
    if (!creds) return null;

    // Note: api.getSubmolts doesn't currently support sort parameter
    // This is kept for future API enhancement
    const result = await api.getSubmolts(this.runtime.agentId, creds.apiKey, this.runtime.logger);
    return result.success ? (result.data ?? null) : null;
  }

  /**
   * Get a submolt by name
   */
  async getSubmolt(name: string): Promise<MoltbookSubmolt | null> {
    const creds = await this.getCredentials();
    if (!creds) return null;

    const result = await api.getSubmolt(
      this.runtime.agentId,
      creds.apiKey,
      name,
      this.runtime.logger
    );
    return result.success ? (result.data ?? null) : null;
  }

  /**
   * Subscribe to a submolt
   * Per API: POST /submolts/SUBMOLT_NAME/subscribe
   */
  async subscribeToSubmolt(submoltName: string): Promise<boolean> {
    const creds = await this.getCredentials();
    if (!creds) return false;

    const result = await api.subscribeToSubmolt(
      this.runtime.agentId,
      creds.apiKey,
      submoltName,
      this.runtime.logger
    );

    if (result.success) {
      this.runtime.logger.info({ submoltName }, "Subscribed to submolt");
    }

    return result.success;
  }

  /**
   * Unsubscribe from a submolt
   * Per API: DELETE /submolts/SUBMOLT_NAME/subscribe
   */
  async unsubscribeFromSubmolt(submoltName: string): Promise<boolean> {
    const creds = await this.getCredentials();
    if (!creds) return false;

    const result = await api.unsubscribeFromSubmolt(
      this.runtime.agentId,
      creds.apiKey,
      submoltName,
      this.runtime.logger
    );

    if (result.success) {
      this.runtime.logger.info({ submoltName }, "Unsubscribed from submolt");
    }

    return result.success;
  }

  // ===========================================================================
  // SEARCH OPERATIONS
  // ===========================================================================

  /**
   * Semantic search for posts and comments (AI-powered)
   * Per API: GET /search?q=query&type=posts|comments|all&limit=N
   */
  async search(
    query: string,
    options: { type?: "posts" | "comments" | "all"; limit?: number } = {}
  ): Promise<MoltbookSearchResults | null> {
    const creds = await this.getCredentials();
    if (!creds) return null;

    const result = await api.search(this.runtime.agentId, creds.apiKey, query, {
      ...options,
      logger: this.runtime.logger,
    });

    return result.success ? (result.data ?? null) : null;
  }

  // ===========================================================================
  // STATUS
  // ===========================================================================

  /**
   * Get service status
   */
  getStatus(): {
    running: boolean;
    authenticated: boolean;
    claimed: boolean;
    canEngage: boolean;
    claimUrl?: string;
    rateLimits: ReturnType<typeof getRateLimitStatus>;
  } {
    const state = getAgentState(this.runtime.agentId);
    const creds = state.credentials;
    const isClaimed = creds?.claimStatus === "claimed";

    return {
      running: this.isRunning,
      authenticated: !!creds,
      claimed: isClaimed,
      canEngage: !!creds && isClaimed, // Can only engage if authenticated AND claimed
      claimUrl: creds?.claimUrl,
      rateLimits: getRateLimitStatus(this.runtime.agentId),
    };
  }

  /**
   * Check if the agent can engage (post, comment, vote)
   *
   * WHY THIS CHECK?
   * Moltbook requires humans to claim agent accounts before they can post.
   * Unclaimed agents can READ the feed but NOT engage.
   * Attempting to post/comment/vote with unclaimed account returns 401.
   *
   * This method allows callers to check BEFORE attempting engagement,
   * avoiding wasted API calls and confusing error messages.
   */
  async canEngage(): Promise<boolean> {
    const creds = await this.getCredentials();
    if (!creds) return false;

    // Must be claimed to engage
    return creds.claimStatus === "claimed";
  }

  /**
   * Check if account needs to be claimed and log reminder if so
   */
  async checkClaimStatusAndRemind(): Promise<boolean> {
    const creds = await this.getCredentials();
    if (!creds) return false;

    if (creds.claimStatus === "unclaimed") {
      // Log a reminder with the claim URL
      if (creds.claimUrl) {
        this.runtime.logger.info(
          { username: creds.username, claimUrl: creds.claimUrl },
          "Moltbook: Account not yet claimed - cannot post/comment/vote until human claims it"
        );
      }
      return false;
    }

    return true;
  }

  /**
   * Refresh claim status from API
   *
   * WHY REFRESH?
   * The human might have claimed the account since we last checked.
   * This allows the agent to detect when it's been claimed and start engaging.
   */
  async refreshClaimStatus(): Promise<boolean> {
    const creds = await this.getCredentials();
    if (!creds) return false;

    // Already claimed, no need to check
    if (creds.claimStatus === "claimed") return true;

    // Check with API
    const validation = await api.validateKey(
      this.runtime.agentId,
      creds.apiKey,
      this.runtime.logger
    );

    if (validation.success && validation.data?.isClaimed) {
      // Status changed! Update credentials
      creds.claimStatus = "claimed";
      await this.saveCredentials(creds);

      this.runtime.logger.info(
        { username: creds.username },
        "Moltbook: Account has been claimed! Agent can now engage."
      );
      return true;
    }

    return false;
  }

  /**
   * Check if service is running
   */
  isServiceRunning(): boolean {
    return this.isRunning;
  }

  // ===========================================================================
  // NEW METHODS FROM NEXT BRANCH - Enhanced functionality
  // ===========================================================================

  /**
   * Check if autonomy is running
   */
  isAutonomyRunning(): boolean {
    return this.autonomyRunning;
  }

  /**
   * Start the autonomous agent loop
   */
  startAutonomyLoop(): void {
    if (this.autonomyRunning) {
      this.runtime.logger.warn("Autonomy loop already running");
      return;
    }

    this.autonomyRunning = true;
    this.autonomyStepCount = 0;

    this.runtime.emitEvent(
      MoltbookEventTypes.AUTONOMY_STARTED as string,
      {
        runtime: this.runtime,
        source: "moltbook",
      } as EventPayload
    );

    this.runtime.logger.info("Moltbook autonomy loop started");
    this.runAutonomyStep();
  }

  /**
   * Stop the autonomous agent loop
   */
  stopAutonomyLoop(): void {
    if (!this.autonomyRunning) return;

    this.autonomyRunning = false;
    if (this.autonomyTimeout) {
      clearTimeout(this.autonomyTimeout);
      this.autonomyTimeout = null;
    }

    this.runtime.emitEvent(
      MoltbookEventTypes.AUTONOMY_STOPPED as string,
      {
        runtime: this.runtime,
        source: "moltbook",
      } as EventPayload
    );

    this.runtime.logger.info("Moltbook autonomy loop stopped");
  }

  /**
   * Execute one autonomy step - simplified version for now
   * Full implementation would need LLM integration
   */
  private async runAutonomyStep(): Promise<void> {
    if (!this.autonomyRunning) return;

    // Check step limit
    if (
      this.settings?.autonomyMaxSteps &&
      this.autonomyStepCount >= this.settings.autonomyMaxSteps
    ) {
      this.runtime.logger.info(`Reached max autonomy steps (${this.settings.autonomyMaxSteps})`);
      this.stopAutonomyLoop();
      return;
    }

    this.autonomyStepCount++;

    try {
      // Browse recent posts for context (inlined wrapper)
      const feed = await this.getPosts({ sort: "hot", limit: 10 });

      if (feed && feed.posts.length > 0) {
        this.runtime.logger.info(
          `Autonomy step ${this.autonomyStepCount}: Found ${feed.posts.length} posts`
        );
        // Store in memory for future reference
        this.memory.push(`Found ${feed.posts.length} posts at ${new Date().toISOString()}`);
        if (this.memory.length > 10) {
          this.memory.shift(); // Keep only last 10 memories
        }
      }

      // Emit autonomy step event
      this.runtime.emitEvent(
        MoltbookEventTypes.AUTONOMY_STEP_COMPLETED as string,
        {
          runtime: this.runtime,
          source: "moltbook",
        } as EventPayload
      );

      // Schedule next step
      const intervalMs = this.settings?.autonomyIntervalMs || AUTONOMY_DEFAULTS.minIntervalMs;
      this.autonomyTimeout = setTimeout(() => this.runAutonomyStep(), intervalMs);
    } catch (error) {
      this.runtime.logger.error(`Autonomy step failed: ${error}`);
      // Continue on error - schedule next step
      const intervalMs = this.settings?.autonomyIntervalMs || AUTONOMY_DEFAULTS.minIntervalMs;
      this.autonomyTimeout = setTimeout(() => this.runAutonomyStep(), intervalMs);
    }
  }
}
