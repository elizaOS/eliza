/**
 * E2B sandbox service — lazy SDK load so monorepo tests work without @e2b installed.
 * Runtime binds this as a long-lived Service when plugin is registered.
 */

export type SandboxSession = {
  id: string;
  template: string;
  createdAt: number;
};

export type RunCodeResult = {
  text: string | null;
  logs: { stdout: string[]; stderr: string[] };
  error: string | null;
  dryRun: boolean;
};

export type E2BSandboxDriver = {
  create: (template: string) => Promise<SandboxSession>;
  runCode: (sessionId: string, code: string) => Promise<RunCodeResult>;
  kill: (sessionId: string) => Promise<void>;
};

/** In-memory dry-run driver when E2B_API_KEY is missing */
export function createDryRunDriver(): E2BSandboxDriver {
  const sessions = new Map<string, SandboxSession>();
  return {
    async create(template) {
      const s: SandboxSession = {
        id: `dry-${Date.now().toString(36)}`,
        template,
        createdAt: Date.now(),
      };
      sessions.set(s.id, s);
      return s;
    },
    async runCode(sessionId, code) {
      if (!sessions.has(sessionId)) {
        return {
          text: null,
          logs: { stdout: [], stderr: ["session not found"] },
          error: "SESSION_NOT_FOUND",
          dryRun: true,
        };
      }
      return {
        text: `[dry-run] would execute ${code.length} chars in ${sessionId}`,
        logs: { stdout: [`# dry-run\n${code.slice(0, 200)}`], stderr: [] },
        error: null,
        dryRun: true,
      };
    },
    async kill(sessionId) {
      sessions.delete(sessionId);
    },
  };
}

export type LiveE2BFactory = () => Promise<E2BSandboxDriver>;

/**
 * Attempts to load @e2b/code-interpreter. Falls back to dry-run.
 */
export async function resolveE2BDriver(opts: {
  apiKey: string | null;
  factory?: LiveE2BFactory;
}): Promise<{ driver: E2BSandboxDriver; mode: "live" | "dry-run" }> {
  if (!opts.apiKey) {
    return { driver: createDryRunDriver(), mode: "dry-run" };
  }
  if (opts.factory) {
    return { driver: await opts.factory(), mode: "live" };
  }
  try {
    // Dynamic import — optional peer; keep types loose for optional dependency
    type E2BSandbox = {
      sandboxId?: string;
      runCode: (code: string) => Promise<{
        text?: string;
        logs?: { stdout?: string[]; stderr?: string[] };
        error?: { value?: string };
      }>;
      kill: () => Promise<void>;
    };
    type E2BSandboxCtor = {
      create: (o: { apiKey: string }) => Promise<E2BSandbox>;
    };

    const mod = (await import("@e2b/code-interpreter")) as {
      Sandbox?: E2BSandboxCtor;
    };
    const Sandbox = mod.Sandbox;
    if (!Sandbox) throw new Error("Sandbox export missing");

    const live = new Map<string, E2BSandbox>();
    const apiKey = opts.apiKey;
    const driver: E2BSandboxDriver = {
      async create(template) {
        const sbx = await Sandbox.create({ apiKey });
        const id = sbx.sandboxId || `e2b-${Date.now()}`;
        live.set(id, sbx);
        return { id, template, createdAt: Date.now() };
      },
      async runCode(sessionId, code) {
        const sbx = live.get(sessionId);
        if (!sbx) {
          return {
            text: null,
            logs: { stdout: [], stderr: [] },
            error: "SESSION_NOT_FOUND",
            dryRun: false,
          };
        }
        const execution = await sbx.runCode(code);
        return {
          text: execution.text ?? null,
          logs: {
            stdout: execution.logs?.stdout ?? [],
            stderr: execution.logs?.stderr ?? [],
          },
          error: execution.error?.value ?? null,
          dryRun: false,
        };
      },
      async kill(sessionId) {
        const sbx = live.get(sessionId);
        if (sbx) {
          await sbx.kill();
          live.delete(sessionId);
        }
      },
    };
    return { driver, mode: "live" };
  } catch {
    return { driver: createDryRunDriver(), mode: "dry-run" };
  }
}

/** Lightweight service state holder (runtime wraps this) */
export class E2BComputerService {
  static serviceType = "e2b-computer" as const;
  capabilityDescription = "E2B code-interpreter sandbox computer for agent tool use";

  private driver: E2BSandboxDriver | null = null;
  private mode: "live" | "dry-run" = "dry-run";
  private session: SandboxSession | null = null;
  private template = "code-interpreter-v1";

  constructor(
    private getSetting: (key: string) => string | undefined | null = () => undefined,
  ) {}

  async start(): Promise<void> {
    const apiKey = (this.getSetting("E2B_API_KEY") || "").trim() || null;
    this.template =
      this.getSetting("E2B_TEMPLATE") ||
      this.getSetting("E2B_SANDBOX_TEMPLATE") ||
      "code-interpreter-v1";
    const resolved = await resolveE2BDriver({ apiKey });
    this.driver = resolved.driver;
    this.mode = resolved.mode;
  }

  async stop(): Promise<void> {
    if (this.session && this.driver) {
      await this.driver.kill(this.session.id);
    }
    this.session = null;
    this.driver = null;
  }

  getMode(): "live" | "dry-run" {
    return this.mode;
  }

  async ensureSession(): Promise<SandboxSession> {
    if (!this.driver) await this.start();
    if (!this.session) {
      this.session = await this.driver!.create(this.template);
    }
    return this.session;
  }

  async runPython(code: string): Promise<RunCodeResult> {
    const session = await this.ensureSession();
    return this.driver!.runCode(session.id, code);
  }
}
