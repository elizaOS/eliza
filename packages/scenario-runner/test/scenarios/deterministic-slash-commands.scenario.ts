/**
 * Keyless catalog coverage for the slash-command surface. Runs on the
 * pr-deterministic lane under the LLM proxy.
 */
import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  type ClientCommandAction,
  type ConnectorCommand,
  getConnectorCommands,
} from "../../../../plugins/plugin-commands/src/index.ts";
import { handleCommandsRoutes } from "../../../agent/src/api/commands-routes.ts";

/**
 * Deterministic slash-command catalog coverage.
 *
 * `plugin-commands` is a registry-only plugin (no action handlers), and the wire
 * surface every client composer consumes is `GET /api/commands`. This scenario
 * boots the real `handleCommandsRoutes` handler on the runtime's route table and
 * dispatches it through the scenario loopback API server (the same real-dispatch
 * path the gold-standard generated-app-routes scenario uses). It asserts, over a
 * real socket with zero LLM calls, that:
 *   - the served catalog is exactly the projection of the `getConnectorCommands`
 *     source of truth (every command present, none invented),
 *   - each `target.kind` carries the correct effect (agent → message pipeline,
 *     navigate → a concrete in-app route, client → a known GUI/TUI behavior), and
 *   - chat connectors (Discord) drop GUI-only client commands but keep navigation.
 */

type ScenarioRoute = {
  type?: string;
  path: string;
  handler?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    runtime: unknown,
  ) => Promise<void> | void;
  __scenarioCommandsRoute?: boolean;
};

type RuntimeWithCommandRoutes = AgentRuntime & {
  routes?: ScenarioRoute[];
};

interface ServedCommand {
  key: string;
  nativeName: string;
  description: string;
  textAliases: string[];
  acceptsArgs: boolean;
  target:
    | { kind: "agent" }
    | { kind: "navigate"; path?: string; tab?: string; viewId?: string }
    | { kind: "client"; clientAction: ClientCommandAction };
}

interface CommandsBody {
  commands: ServedCommand[];
  surface: string | null;
  agentId: string | null;
  generatedAt: string;
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, message: string, status = 500): void {
  json(res, { error: message }, status);
}

async function scenarioCommandsRouteHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: unknown,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const handled = await handleCommandsRoutes({
    req,
    res,
    method,
    pathname: url.pathname,
    url,
    json,
    error,
    runtime: runtime as AgentRuntime,
  });
  if (!handled && !res.headersSent) {
    error(res, `No commands route handled ${method} ${url.pathname}`, 404);
  }
}

function registerCommandsRoute(runtime: RuntimeWithCommandRoutes): void {
  const routes = runtime.routes ?? [];
  runtime.routes = routes.filter(
    (route) => route.__scenarioCommandsRoute !== true,
  );
  runtime.routes.push({
    type: "GET",
    path: "/api/commands",
    handler: scenarioCommandsRouteHandler,
    __scenarioCommandsRoute: true,
  });
}

let capturedRuntime: RuntimeWithCommandRoutes | null = null;

async function seedCommands(ctx: ScenarioContext): Promise<string | undefined> {
  const runtime = ctx.runtime as RuntimeWithCommandRoutes | undefined;
  if (!runtime) return "scenario runtime was not available";
  capturedRuntime = runtime;
  registerCommandsRoute(runtime);
  return undefined;
}

function commandByKey(
  body: CommandsBody,
  key: string,
): ServedCommand | undefined {
  return body.commands.find((command) => command.key === key);
}

/** The served catalog must be exactly the source-of-truth projection. */
function expectGuiCatalog(status: number, body: unknown): string | undefined {
  if (status !== 200) return `expected 200, saw ${status}`;
  const payload = body as CommandsBody;
  if (!Array.isArray(payload.commands)) {
    return `expected commands array, saw ${typeof payload.commands}`;
  }
  if (payload.surface !== "gui") {
    return `expected surface=gui, saw ${JSON.stringify(payload.surface)}`;
  }

  const expected: ConnectorCommand[] = getConnectorCommands("gui");
  const servedNames = payload.commands.map((c) => c.key).sort();
  const expectedNames = expected.map((c) => c.name).sort();
  if (servedNames.join(",") !== expectedNames.join(",")) {
    return `served catalog drifted from getConnectorCommands.\n  served:   ${servedNames.join(", ")}\n  expected: ${expectedNames.join(", ")}`;
  }

  // Every command carries a well-formed, valid target effect.
  for (const command of payload.commands) {
    if (command.textAliases[0] !== `/${command.key}`) {
      return `command ${command.key} alias drifted: ${command.textAliases[0]}`;
    }
    if (command.target.kind === "navigate") {
      if (
        typeof command.target.path !== "string" ||
        !command.target.path.startsWith("/")
      ) {
        return `navigate command ${command.key} has no in-app path`;
      }
    } else if (command.target.kind === "client") {
      // The set of client actions evolves with the catalog, so validate shape
      // (a non-empty client action), not a frozen allowlist.
      if (
        typeof command.target.clientAction !== "string" ||
        command.target.clientAction.length === 0
      ) {
        return `client command ${command.key} has no client action`;
      }
    } else if (command.target.kind !== "agent") {
      return `command ${command.key} has unknown target kind`;
    }
  }

  // Representative commands across all three target kinds resolve their effect.
  const settings = commandByKey(payload, "settings");
  if (
    settings?.target.kind !== "navigate" ||
    settings.target.path !== "/settings"
  ) {
    return `expected /settings to navigate to /settings, saw ${JSON.stringify(settings?.target)}`;
  }
  const clear = commandByKey(payload, "clear");
  if (
    clear?.target.kind !== "client" ||
    clear.target.clientAction !== "clear-chat"
  ) {
    return `expected /clear to dispatch clear-chat, saw ${JSON.stringify(clear?.target)}`;
  }
  const think = commandByKey(payload, "think");
  if (think?.target.kind !== "agent") {
    return `expected /think to route through the agent pipeline, saw ${JSON.stringify(think?.target)}`;
  }
  return undefined;
}

/** Chat connectors drop GUI-only client commands but keep navigation + agent. */
function expectDiscordCatalog(
  status: number,
  body: unknown,
): string | undefined {
  if (status !== 200) return `expected 200, saw ${status}`;
  const payload = body as CommandsBody;
  if (payload.surface !== "discord") {
    return `expected surface=discord, saw ${JSON.stringify(payload.surface)}`;
  }
  const keys = new Set(payload.commands.map((c) => c.key));
  if (keys.has("clear") || keys.has("fullscreen")) {
    return "GUI-only client commands leaked onto the Discord surface";
  }
  if (!keys.has("settings") || !keys.has("think")) {
    return "navigation/agent commands missing from the Discord surface";
  }
  return undefined;
}

function finalCommandsCheck(ctx: ScenarioContext): string | undefined {
  const runtime =
    (ctx.runtime as RuntimeWithCommandRoutes | undefined) ??
    capturedRuntime ??
    undefined;
  if (!runtime) return "scenario runtime was not available in final check";
  const route = (runtime.routes ?? []).find(
    (candidate) => candidate.__scenarioCommandsRoute === true,
  );
  if (!route) return "commands route was not registered on the runtime";
  if (getConnectorCommands("gui").length === 0) {
    return "getConnectorCommands returned an empty catalog";
  }
  return undefined;
}

export default scenario({
  id: "deterministic-slash-commands",
  lane: "pr-deterministic",
  title: "Deterministic slash-command catalog coverage",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "commands", "routes"],
  isolation: "shared-runtime",
  seed: [
    {
      type: "custom",
      name: "register the real /api/commands handler on the runtime routes",
      apply: seedCommands,
    },
  ],
  turns: [
    {
      kind: "api",
      name: "GUI catalog matches the connector-command source of truth",
      method: "GET",
      path: "/api/commands?surface=gui",
      expectedStatus: 200,
      assertResponse: expectGuiCatalog,
    },
    {
      kind: "api",
      name: "Discord surface filters GUI-only client commands",
      method: "GET",
      path: "/api/commands?surface=discord",
      expectedStatus: 200,
      assertResponse: expectDiscordCatalog,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "real commands route stayed registered and the catalog is non-empty",
      predicate: finalCommandsCheck,
    },
  ],
});
