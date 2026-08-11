#!/usr/bin/env node

/**
 * Drives the real registered BlueBubbles loop through the local Mac relay,
 * Cloud routing, a bound Eliza agent, and Messages delivery to a test phone.
 */

import crypto from "node:crypto";

function usage() {
  return [
    "Usage: node packages/app-core/scripts/verify-bluebubbles-registered-e2e.mjs --sender <phone-or-email> [options]",
    "",
    "Options:",
    "  --sender <value>          Real phone/email that will receive the agent reply (required).",
    "  --agent-id <uuid>         Expected routed agent id.",
    "  --bridge-url <url>        Local relay webhook (default http://127.0.0.1:8795/webhooks/bluebubbles).",
    "  --service <iMessage|SMS>  BlueBubbles service (default iMessage).",
    "  --message <text>          Inbound test text (default includes a unique marker).",
    "  --wait-real               Wait for that text to arrive from the real phone instead of injecting it.",
    "  --timeout-seconds <n>     Real-inbound wait timeout (default 180).",
  ].join("\n");
}

function parseArgs(argv) {
  const marker = crypto.randomUUID();
  const args = {
    sender: "",
    agentId: "",
    bridgeUrl: "http://127.0.0.1:8795/webhooks/bluebubbles",
    service: "iMessage",
    message: `BlueBubbles registered gateway E2E ${marker}. Reply with the word verified.`,
    marker,
    waitReal: false,
    timeoutSeconds: 180,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--sender") args.sender = next().trim();
    else if (arg === "--agent-id") args.agentId = next().trim();
    else if (arg === "--bridge-url") args.bridgeUrl = next().trim();
    else if (arg === "--service") args.service = next().trim();
    else if (arg === "--message") args.message = next().trim();
    else if (arg === "--wait-real") args.waitReal = true;
    else if (arg === "--timeout-seconds") {
      args.timeoutSeconds = Number.parseInt(next(), 10);
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  if (!args.sender) throw new Error(`--sender is required\n${usage()}`);
  if (args.service !== "iMessage" && args.service !== "SMS") {
    throw new Error("--service must be iMessage or SMS");
  }
  if (!Number.isFinite(args.timeoutSeconds) || args.timeoutSeconds <= 0) {
    throw new Error("--timeout-seconds must be a positive integer");
  }
  return args;
}

async function readJson(response, label) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    // error-policy:J2 preserve the invalid response as context for the verifier boundary.
    throw new Error(`${label} returned invalid JSON: ${text.slice(0, 240)}`, {
      cause: error,
    });
  }
}

function assertDeliveredRoute(result, args) {
  if (result.handled !== true) {
    throw new Error(
      `Cloud did not handle the message: ${JSON.stringify(result)}`,
    );
  }
  if (args.agentId && result.agentId !== args.agentId) {
    throw new Error(
      `Message routed to ${result.agentId ?? "no agent"}, expected ${args.agentId}`,
    );
  }
  if (result.replied !== true || result.replyQueued === true) {
    throw new Error(
      `Reply was not delivered through Messages: ${JSON.stringify(result)}`,
    );
  }
}

async function injectInbound(args) {
  const response = await fetch(args.bridgeUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "new-message",
      data: {
        guid: `eliza-bb-e2e-${args.marker}`,
        text: args.message,
        isFromMe: false,
        handle: { address: args.sender, service: args.service },
        chats: [
          {
            guid: `${args.service};-;${args.sender}`,
            chatIdentifier: args.sender,
          },
        ],
        dateCreated: Date.now(),
        metadata: { e2eMarker: args.marker },
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const result = await readJson(response, "local bridge webhook");
  if (!response.ok || result.success !== true) {
    throw new Error(
      `Local bridge webhook failed (${response.status}): ${JSON.stringify(result)}`,
    );
  }
  return result;
}

async function waitForRealInbound(args, health) {
  const startedAt = new Date().toISOString();
  const eventMarker = args.message.slice(0, 120).trim();
  process.stdout.write(
    `${JSON.stringify(
      {
        action: "send-real-message",
        from: args.sender,
        to: health.gatewayPhoneNumber,
        text: args.message,
        timeoutSeconds: args.timeoutSeconds,
      },
      null,
      2,
    )}\n`,
  );

  const deadline = Date.now() + args.timeoutSeconds * 1_000;
  while (Date.now() < deadline) {
    const eventsUrl = new URL("/inbound-events", args.bridgeUrl);
    eventsUrl.searchParams.set("since", startedAt);
    eventsUrl.searchParams.set("sender", args.sender);
    eventsUrl.searchParams.set("marker", eventMarker);
    eventsUrl.searchParams.set("limit", "1");
    try {
      const response = await fetch(eventsUrl, {
        signal: AbortSignal.timeout(10_000),
      });
      const body = await readJson(response, "local bridge inbound events");
      const event = Array.isArray(body.events) ? body.events[0] : undefined;
      if (response.ok && event) return event;
    } catch {
      // error-policy:J5 the next bounded poll observes the same relay event stream.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `No real BlueBubbles inbound event containing ${eventMarker} arrived from ${args.sender} within ${args.timeoutSeconds}s`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const healthUrl = new URL("/health", args.bridgeUrl).toString();
  const healthResponse = await fetch(healthUrl, {
    signal: AbortSignal.timeout(10_000),
  });
  const health = await readJson(healthResponse, "local bridge health");
  if (!healthResponse.ok || health.status !== "ok") {
    throw new Error(`Local bridge is not healthy: ${JSON.stringify(health)}`);
  }
  if (health.gatewayAuthMode !== "registered-device") {
    throw new Error(
      `Local bridge is using ${health.gatewayAuthMode ?? "unknown"} auth; registered-device is required`,
    );
  }
  if (health.outboundReadiness?.ready !== true) {
    throw new Error(
      `Outbound Messages delivery is not ready: ${JSON.stringify(health.outboundReadiness ?? {})}`,
    );
  }

  const result = args.waitReal
    ? await waitForRealInbound(args, health)
    : await injectInbound(args);
  assertDeliveredRoute(result, args);

  process.stdout.write(
    `${JSON.stringify(
      {
        success: true,
        mode: args.waitReal ? "real-inbound" : "injected-inbound",
        marker: args.marker,
        messageId: result.messageId,
        bridgeId: health.bridgeId,
        agentId: result.agentId,
        organizationId: result.organizationId,
        userId: result.userId,
        replied: result.replied,
        replyQueued: result.replyQueued,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
