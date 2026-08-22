/**
 * Bounded process bridge for the Omarchy desktop integration. Every executable
 * and option is fixed here; caller text can occupy notification argument slots
 * but can never select a command, request notification click execution, or
 * enter a shell parser.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { ElizaError, type ProviderValue } from "@elizaos/core";

export interface CommandOutput {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<CommandOutput>;

export interface OmarchyPluginStatus {
  id: string;
  enabled: boolean;
  firstParty: boolean;
  kinds: string[];
  name: string;
}

export interface OmarchySnapshot extends Record<string, ProviderValue> {
  available: boolean;
  version?: string;
  theme?: string;
  plugins?: OmarchyPluginStatus[];
  reason?: string;
  errorCode?: "OMARCHY_PLUGIN_LIST_INVALID";
}

export type NotificationUrgency = "low" | "normal" | "critical";

const PROCESS_TIMEOUT_MS = 5_000;
const PROCESS_MAX_BUFFER = 256 * 1024;

const defaultRunner: CommandRunner = (executable, args) =>
  new Promise<CommandOutput>((resolve, reject) => {
    execFile(
      executable,
      [...args],
      { timeout: PROCESS_TIMEOUT_MS, maxBuffer: PROCESS_MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

function commandFailure(executable: string, cause: unknown): ElizaError {
  return new ElizaError(`Omarchy command ${executable} failed`, {
    code: "OMARCHY_COMMAND_FAILED",
    cause,
    context: { executable },
  });
}

function cleanNotificationText(
  value: string,
  field: "headline" | "body",
  maximumLength: number,
): string {
  const cleaned = value.trim();
  if (!cleaned) {
    throw new ElizaError(`Notification ${field} is required`, {
      code: "OMARCHY_NOTIFICATION_INVALID",
      context: { field },
    });
  }
  if (cleaned.length > maximumLength || cleaned.includes("\0")) {
    throw new ElizaError(`Notification ${field} is invalid`, {
      code: "OMARCHY_NOTIFICATION_INVALID",
      context: { field, maximumLength },
    });
  }
  // omarchy-notification-send recognizes options on both sides of its title.
  // Reject option-shaped text so user content can never become --exec or any
  // future control flag even though execFile itself does not invoke a shell.
  if (cleaned.startsWith("-")) {
    throw new ElizaError(`Notification ${field} cannot start with a hyphen`, {
      code: "OMARCHY_NOTIFICATION_INVALID",
      context: { field },
    });
  }
  return cleaned;
}

/** Validates urgency again at the process boundary because JS callers are untrusted. */
export function parseNotificationUrgency(value: unknown): NotificationUrgency {
  if (value !== "low" && value !== "normal" && value !== "critical") {
    throw new ElizaError("Notification urgency is invalid", {
      code: "OMARCHY_NOTIFICATION_INVALID",
      context: { field: "urgency" },
    });
  }
  return value;
}

function invalidPluginInventory(message: string, cause?: unknown): ElizaError {
  return new ElizaError(message, {
    code: "OMARCHY_PLUGIN_LIST_INVALID",
    cause,
  });
}

function requiredInventoryString(
  record: Record<string, unknown>,
  field: "id" | "name",
  index: number,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidPluginInventory(
      `Omarchy plugin inventory entry ${index} has an invalid ${field}`,
    );
  }
  return value;
}

function requiredInventoryKinds(value: unknown, index: number): string[] {
  if (!Array.isArray(value)) {
    throw invalidPluginInventory(
      `Omarchy plugin inventory entry ${index} has invalid kinds`,
    );
  }
  const kinds: string[] = [];
  for (const kind of value) {
    if (typeof kind !== "string" || kind.trim().length === 0) {
      throw invalidPluginInventory(
        `Omarchy plugin inventory entry ${index} has invalid kinds`,
      );
    }
    kinds.push(kind);
  }
  return kinds;
}

function parsePlugins(raw: string): OmarchyPluginStatus[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    // error-policy:J2 command output is untrusted; preserve the parse cause in
    // a typed error rather than fabricating an empty plugin inventory.
    throw invalidPluginInventory("Omarchy returned invalid plugin JSON", cause);
  }
  if (!Array.isArray(parsed)) {
    throw invalidPluginInventory("Omarchy plugin inventory was not an array");
  }

  return parsed.map((entry, index): OmarchyPluginStatus => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw invalidPluginInventory(
        `Omarchy plugin inventory entry ${index} was not an object`,
      );
    }
    const record = entry as Record<string, unknown>;
    const id = requiredInventoryString(record, "id", index);
    const name = requiredInventoryString(record, "name", index);
    const kinds = requiredInventoryKinds(record.kinds, index);
    if (
      typeof record.enabled !== "boolean" ||
      typeof record.firstParty !== "boolean"
    ) {
      throw invalidPluginInventory(
        `Omarchy plugin inventory entry ${index} has invalid ownership state`,
      );
    }
    return {
      id,
      enabled: record.enabled,
      firstParty: record.firstParty,
      kinds,
      name,
    };
  });
}

export function isOmarchyHost(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  pathExists: (path: string) => boolean = existsSync,
): boolean {
  return (
    platform === "linux" &&
    (Boolean(environment.OMARCHY_PATH?.trim()) ||
      pathExists("/usr/share/omarchy"))
  );
}

export class OmarchyBridge {
  constructor(private readonly run: CommandRunner = defaultRunner) {}

  private async invoke(
    executable: string,
    args: readonly string[] = [],
  ): Promise<CommandOutput> {
    try {
      return await this.run(executable, args);
    } catch (cause) {
      // error-policy:J2 preserve the failed executable without exposing its
      // stderr (which can contain local paths or notification text).
      throw commandFailure(executable, cause);
    }
  }

  async snapshot(): Promise<OmarchySnapshot> {
    let version: string;
    try {
      const output = await this.invoke("omarchy-version");
      version = output.stdout.trim();
      if (!version) throw new Error("empty version");
    } catch (error) {
      // error-policy:J4 an unavailable Omarchy binary is a designed,
      // visibly-distinct provider state rather than a healthy empty snapshot.
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    const [themeResult, pluginsResult] = await Promise.allSettled([
      this.invoke("omarchy-theme-current"),
      this.invoke("omarchy-plugin-list", ["--json"]),
    ]);

    if (themeResult.status === "rejected") {
      return {
        available: false,
        version,
        reason: "Omarchy theme state is unavailable",
      };
    }
    const theme = themeResult.value.stdout.trim();
    if (!theme) {
      return {
        available: false,
        version,
        reason: "Omarchy returned an empty theme",
      };
    }
    if (pluginsResult.status === "rejected") {
      return {
        available: false,
        version,
        theme,
        reason: "Omarchy plugin inventory is unavailable",
      };
    }

    try {
      return {
        available: true,
        version,
        theme,
        plugins: parsePlugins(pluginsResult.value.stdout),
      };
    } catch (error) {
      return {
        available: false,
        version,
        theme,
        reason: error instanceof Error ? error.message : String(error),
        errorCode: "OMARCHY_PLUGIN_LIST_INVALID",
      };
    }
  }

  async notify(
    headline: string,
    body: string,
    urgency: NotificationUrgency = "normal",
  ): Promise<void> {
    const safeHeadline = cleanNotificationText(headline, "headline", 120);
    const safeBody = cleanNotificationText(body, "body", 500);
    const safeUrgency = parseNotificationUrgency(urgency);
    await this.invoke("omarchy-notification-send", [
      "--app-name",
      "elizaos",
      "--urgency",
      safeUrgency,
      safeHeadline,
      safeBody,
    ]);
  }

  async showElizaPill(): Promise<void> {
    // The bar owns the effective plugin settings. Asking its fixed IPC method
    // to show the panel ensures endpoint, identity, and Workstation URL are
    // forwarded without accepting caller-controlled command arguments.
    const output = await this.invoke("omarchy-shell", [
      "elizaos.eliza.bar",
      "show",
    ]);
    if (output.stdout.trim() !== "ok") {
      throw new ElizaError("Omarchy could not open the Eliza quick-chat pill", {
        code: "OMARCHY_PILL_UNAVAILABLE",
      });
    }
  }
}

export const omarchyBridge = new OmarchyBridge();
