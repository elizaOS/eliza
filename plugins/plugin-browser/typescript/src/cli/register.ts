import type { CliContext } from "@elizaos/plugin-cli";
import { BrowserService, type Session } from "../services/browser-service.js";

/**
 * Get the Browser service from runtime
 */
function getBrowserService(ctx: CliContext): BrowserService | null {
  const runtime = ctx.getRuntime?.();
  if (!runtime) {
    return null;
  }
  return runtime.getService<BrowserService>(BrowserService.serviceType);
}

/**
 * Handle errors in browser commands
 */
function handleError(error: Error | string): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}

/**
 * Ensure service is available
 */
function requireService(ctx: CliContext): BrowserService {
  const service = getBrowserService(ctx);
  if (!service) {
    handleError("Browser service not available. Ensure the agent runtime is initialized.");
  }
  return service;
}

/**
 * Format navigation result for display
 */
function formatNavigationResult(result: { success: boolean; url: string; title: string }): string {
  return [`Success: ${result.success}`, `URL: ${result.url}`, `Title: ${result.title}`].join("\n");
}

/**
 * Register Browser CLI commands
 *
 * Commands:
 * - browser status: Show browser service status
 * - browser start: Start a browser session
 * - browser stop: Stop browser service
 * - browser navigate: Navigate to a URL
 * - browser click: Click an element
 * - browser type: Type text into a field
 * - browser select: Select an option from dropdown
 * - browser extract: Extract information from the page
 * - browser screenshot: Take a screenshot
 * - browser back/forward/refresh: Navigation controls
 *
 * @param ctx - CLI context with program and optional runtime
 */
export function registerBrowserCli(ctx: CliContext): void {
  const browser = ctx.program
    .command("browser")
    .description("Browser automation commands")
    .option("--json", "Output as JSON", false);

  // Status command
  browser
    .command("status")
    .description("Show browser service status")
    .action(async (_opts, cmd) => {
      const parent = cmd.parent?.opts() as { json?: boolean } | undefined;
      const service = getBrowserService(ctx);

      const status = {
        serviceAvailable: service !== null,
        serverConnected: service?.getClient?.()?.isConnected?.() ?? false,
      };

      let currentSession: Session | undefined;
      if (service) {
        currentSession = await service.getCurrentSession();
      }

      const output = {
        ...status,
        hasActiveSession: !!currentSession,
        sessionId: currentSession?.id ?? null,
      };

      if (parent?.json) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log("Browser Service Status:");
        console.log(`  Service available: ${output.serviceAvailable}`);
        console.log(`  Server connected: ${output.serverConnected}`);
        console.log(`  Active session: ${output.hasActiveSession ? output.sessionId : "none"}`);
      }
    });

  // Start command
  browser
    .command("start")
    .description("Start or ensure browser session is active")
    .action(async (_opts, cmd) => {
      const parent = cmd.parent?.opts() as { json?: boolean } | undefined;
      const service = requireService(ctx);

      const session = await service.getOrCreateSession();

      if (parent?.json) {
        console.log(
          JSON.stringify({ sessionId: session.id, createdAt: session.createdAt }, null, 2)
        );
      } else {
        console.log(`Browser session active: ${session.id}`);
      }
    });

  // Stop command
  browser
    .command("stop")
    .description("Stop browser service")
    .action(async (_opts, cmd) => {
      const parent = cmd.parent?.opts() as { json?: boolean } | undefined;
      const service = requireService(ctx);

      await service.stop();

      if (parent?.json) {
        console.log(JSON.stringify({ stopped: true }, null, 2));
      } else {
        console.log("Browser service stopped");
      }
    });

  // Navigate command
  browser
    .command("navigate")
    .description("Navigate to a URL")
    .argument("<url>", "URL to navigate to")
    .action(async (url: string, _opts, cmd) => {
      const parent = cmd.parent?.opts() as { json?: boolean } | undefined;
      const service = requireService(ctx);
      const client = service.getClient();

      const session = await service.getOrCreateSession();
      const result = await client.navigate(session.id, url);

      if (parent?.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatNavigationResult(result));
      }
    });

  // Go back command
  browser
    .command("back")
    .description("Navigate back in browser history")
    .action(async (_opts, cmd) => {
      const parent = cmd.parent?.opts() as { json?: boolean } | undefined;
      const service = requireService(ctx);
      const client = service.getClient();

      const session = await service.getCurrentSession();
      if (!session) {
        handleError("No active browser session");
      }

      const result = await client.goBack(session.id);

      if (parent?.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatNavigationResult(result));
      }
    });

  // Go forward command
  browser
    .command("forward")
    .description("Navigate forward in browser history")
    .action(async (_opts, cmd) => {
      const parent = cmd.parent?.opts() as { json?: boolean } | undefined;
      const service = requireService(ctx);
      const client = service.getClient();

      const session = await service.getCurrentSession();
      if (!session) {
        handleError("No active browser session");
      }

      const result = await client.goForward(session.id);

      if (parent?.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatNavigationResult(result));
      }
    });

  // Refresh command
  browser
    .command("refresh")
    .description("Refresh the current page")
    .action(async (_opts, cmd) => {
      const parent = cmd.parent?.opts() as { json?: boolean } | undefined;
      const service = requireService(ctx);
      const client = service.getClient();

      const session = await service.getCurrentSession();
      if (!session) {
        handleError("No active browser session");
      }

      const result = await client.refresh(session.id);

      if (parent?.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatNavigationResult(result));
      }
    });

  // Click command
  browser
    .command("click")
    .description("Click an element on the page")
    .argument("<description>", "Description of the element to click (natural language)")
    .action(async (description: string, _opts, cmd) => {
      const parent = cmd.parent?.opts() as { json?: boolean } | undefined;
      const service = requireService(ctx);
      const client = service.getClient();

      const session = await service.getCurrentSession();
      if (!session) {
        handleError("No active browser session");
      }

      const result = await client.click(session.id, description);

      if (parent?.json) {
        console.log(JSON.stringify(result.data ?? { success: true }, null, 2));
      } else {
        console.log(`Clicked: ${description}`);
        if (result.data) {
          console.log(JSON.stringify(result.data, null, 2));
        }
      }
    });

  // Type command
  browser
    .command("type")
    .description("Type text into a field")
    .argument("<text>", "Text to type")
    .requiredOption("--field <description>", "Description of the field (natural language)")
    .action(async (text: string, opts: { field: string }, cmd) => {
      const parent = cmd.parent?.opts() as { json?: boolean } | undefined;
      const service = requireService(ctx);
      const client = service.getClient();

      const session = await service.getCurrentSession();
      if (!session) {
        handleError("No active browser session");
      }

      const result = await client.type(session.id, text, opts.field);

      if (parent?.json) {
        console.log(JSON.stringify(result.data ?? { success: true }, null, 2));
      } else {
        console.log(`Typed "${text}" into: ${opts.field}`);
        if (result.data) {
          console.log(JSON.stringify(result.data, null, 2));
        }
      }
    });

  // Select command
  browser
    .command("select")
    .description("Select an option from a dropdown")
    .argument("<option>", "Option to select")
    .requiredOption("--dropdown <description>", "Description of the dropdown (natural language)")
    .action(async (option: string, opts: { dropdown: string }, cmd) => {
      const parent = cmd.parent?.opts() as { json?: boolean } | undefined;
      const service = requireService(ctx);
      const client = service.getClient();

      const session = await service.getCurrentSession();
      if (!session) {
        handleError("No active browser session");
      }

      const result = await client.select(session.id, option, opts.dropdown);

      if (parent?.json) {
        console.log(JSON.stringify(result.data ?? { success: true }, null, 2));
      } else {
        console.log(`Selected "${option}" from: ${opts.dropdown}`);
        if (result.data) {
          console.log(JSON.stringify(result.data, null, 2));
        }
      }
    });

  // Extract command
  browser
    .command("extract")
    .description("Extract information from the page")
    .argument("<instruction>", "What to extract (natural language)")
    .action(async (instruction: string, _opts, cmd) => {
      const parent = cmd.parent?.opts() as { json?: boolean } | undefined;
      const service = requireService(ctx);
      const client = service.getClient();

      const session = await service.getCurrentSession();
      if (!session) {
        handleError("No active browser session");
      }

      const result = await client.extract(session.id, instruction);

      if (parent?.json) {
        console.log(JSON.stringify(result.data ?? {}, null, 2));
      } else {
        console.log(`Extracted: ${instruction}`);
        console.log(JSON.stringify(result.data ?? {}, null, 2));
      }
    });

  // Screenshot command
  browser
    .command("screenshot")
    .description("Take a screenshot of the current page")
    .option("--output <path>", "Output file path")
    .action(async (opts: { output?: string }, cmd) => {
      const parent = cmd.parent?.opts() as { json?: boolean } | undefined;
      const service = requireService(ctx);
      const client = service.getClient();

      const session = await service.getCurrentSession();
      if (!session) {
        handleError("No active browser session");
      }

      const result = await client.screenshot(session.id);
      const data = result.data as { screenshot?: string } | undefined;

      if (parent?.json) {
        console.log(
          JSON.stringify(
            {
              success: !!data?.screenshot,
              hasScreenshot: !!data?.screenshot,
              outputPath: opts.output ?? null,
            },
            null,
            2
          )
        );
      } else {
        if (data?.screenshot) {
          if (opts.output) {
            const fs = await import("node:fs/promises");
            const buffer = Buffer.from(data.screenshot, "base64");
            await fs.writeFile(opts.output, buffer);
            console.log(`Screenshot saved to: ${opts.output}`);
          } else {
            console.log("Screenshot captured (use --output to save to file)");
            console.log(`Base64 length: ${data.screenshot.length}`);
          }
        } else {
          console.log("Failed to capture screenshot");
        }
      }
    });

  // State command
  browser
    .command("state")
    .description("Get current browser state")
    .action(async (_opts, cmd) => {
      const parent = cmd.parent?.opts() as { json?: boolean } | undefined;
      const service = requireService(ctx);
      const client = service.getClient();

      const session = await service.getCurrentSession();
      if (!session) {
        handleError("No active browser session");
      }

      const state = await client.getState(session.id);

      if (parent?.json) {
        console.log(JSON.stringify(state, null, 2));
      } else {
        console.log("Browser State:");
        console.log(`  URL: ${state.url}`);
        console.log(`  Title: ${state.title}`);
        console.log(`  Session ID: ${state.sessionId}`);
      }
    });

  // Solve captcha command
  browser
    .command("solve-captcha")
    .description("Attempt to solve a captcha on the page")
    .action(async (_opts, cmd) => {
      const parent = cmd.parent?.opts() as { json?: boolean } | undefined;
      const service = requireService(ctx);
      const client = service.getClient();

      const session = await service.getCurrentSession();
      if (!session) {
        handleError("No active browser session");
      }

      const result = await client.solveCaptcha(session.id);

      if (parent?.json) {
        console.log(JSON.stringify(result.data ?? { attempted: true }, null, 2));
      } else {
        console.log("Captcha solve attempted");
        if (result.data) {
          console.log(JSON.stringify(result.data, null, 2));
        }
      }
    });

  // Health command
  browser
    .command("health")
    .description("Check browser server health")
    .action(async (_opts, cmd) => {
      const parent = cmd.parent?.opts() as { json?: boolean } | undefined;
      const service = getBrowserService(ctx);

      let healthy = false;
      if (service) {
        const client = service.getClient();
        healthy = await client.health();
      }

      if (parent?.json) {
        console.log(JSON.stringify({ healthy, serviceAvailable: !!service }, null, 2));
      } else {
        console.log(`Browser server health: ${healthy ? "OK" : "UNHEALTHY"}`);
        console.log(`Service available: ${!!service}`);
      }
    });
}
