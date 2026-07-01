#!/usr/bin/env node
/**
 * Guarded BlueBubbles outbound validation.
 *
 * This sends a real message through the local bridge only when explicitly
 * confirmed with --confirm-real-send. A successful run writes the bridge's
 * outbound validation record, which unblocks the strict egress verifier.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const defaultEvidencePath = path.join(
  repoRoot,
  ".eliza-local",
  "bluebubbles-outbound-validation-latest.json",
);

function usage() {
  return [
    "Usage: node packages/app-core/scripts/validate-bluebubbles-outbound.mjs [options]",
    "",
    "Options:",
    "  --recipient <phone>       Validation recipient. Defaults to +14153024399.",
    "  --chat-guid <guid>        Explicit BlueBubbles chat guid. Defaults from recipient.",
    "  --message <text>         Message text. Defaults to a timestamped validation message.",
    "  --method <method>        apple-script, private-api, or shortcuts. Defaults to bridge config.",
    "  --bridge-url <url>       Local bridge URL. Defaults to http://127.0.0.1:8795.",
    "  --evidence <path>        Write structured validation evidence. Defaults to .eliza-local/bluebubbles-outbound-validation-latest.json.",
    "  --no-evidence            Do not write validation evidence.",
    "  --confirm-real-send      Required. Acknowledges this sends a real SMS/iMessage.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    recipient: "+14153024399",
    chatGuid: "",
    message: "",
    method: "",
    bridgeUrl: "http://127.0.0.1:8795",
    evidencePath: defaultEvidencePath,
    confirmRealSend: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };

    if (arg === "--recipient") args.recipient = next();
    else if (arg === "--chat-guid") args.chatGuid = next();
    else if (arg === "--message") args.message = next();
    else if (arg === "--method") args.method = next();
    else if (arg === "--bridge-url") args.bridgeUrl = next().replace(/\/$/, "");
    else if (arg === "--evidence") args.evidencePath = path.resolve(next());
    else if (arg === "--no-evidence") args.evidencePath = null;
    else if (arg === "--confirm-real-send") args.confirmRealSend = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }

  if (!args.recipient.trim() && !args.chatGuid.trim()) {
    throw new Error("--recipient or --chat-guid is required");
  }
  if (
    args.method &&
    !["apple-script", "private-api", "shortcuts"].includes(args.method)
  ) {
    throw new Error("--method must be apple-script, private-api, or shortcuts");
  }

  return args;
}

function writeEvidence({
  evidencePath,
  ok,
  bridgeUrl,
  payload,
  doctor,
  diagnostics,
  result,
  blocker,
  error,
}) {
  if (!evidencePath) return;
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  const evidence = {
    ok,
    bridgeUrl,
    checkedAt: new Date().toISOString(),
    recipient: payload.recipient ?? null,
    chatGuid: payload.chatGuid ?? null,
    method: payload.method ?? null,
    messagePreview: payload.message,
    doctorStatus: doctor?.status ?? null,
    checks: Array.isArray(doctor?.checks) ? doctor.checks : [],
    shortcut: diagnostics?.bridge?.shortcutsRunTarget
      ? {
          target: diagnostics.bridge.shortcutsRunTarget,
          inputContract: diagnostics.bridge.shortcutsInputContract ?? null,
          latestInputPath: Array.isArray(
            diagnostics.bridge.recentShortcutInputs,
          )
            ? (diagnostics.bridge.recentShortcutInputs[0]?.path ?? null)
            : null,
        }
      : null,
    blocker: blocker ?? null,
    result: result ?? null,
    error: error ? String(error) : null,
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[bluebubbles-validate] evidence=${evidencePath}`);
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok)
    throw new Error(`${url} failed (${response.status}): ${text}`);
  return body;
}

async function getOptionalJson(url) {
  try {
    return await getJson(url);
  } catch {
    return null;
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok)
    throw new Error(`${url} failed (${response.status}): ${text}`);
  return parsed;
}

function defaultMessage() {
  return `Eliza Cloud gateway validation ${new Date().toISOString()}`;
}

function summarizeDoctor(doctor) {
  const checks = Array.isArray(doctor.checks) ? doctor.checks : [];
  return checks
    .map(
      (check) =>
        `${check.name}=${check.status}${check.detail ? ` (${check.detail})` : ""}`,
    )
    .join("; ");
}

function isAllowedValidationBlocker(check) {
  if (check.name === "pending-replies") return true;
  return (
    check.name === "outbound" &&
    /Shortcut outbound validation missing/.test(check.detail ?? "")
  );
}

function unexpectedDoctorBlockers(doctor) {
  const checks = Array.isArray(doctor.checks) ? doctor.checks : [];
  return checks.filter(
    (check) => check.status !== "pass" && !isAllowedValidationBlocker(check),
  );
}

function printShortcutDiagnostics(diagnostics) {
  const bridge = diagnostics?.bridge;
  if (!bridge?.shortcutsRunTarget) return;

  const contract = bridge.shortcutsInputContract;
  const requiredKeys = Array.isArray(contract?.requiredKeys)
    ? contract.requiredKeys.join(",")
    : "unknown";
  const optionalKeys = Array.isArray(contract?.optionalKeys)
    ? contract.optionalKeys.join(",")
    : "none";
  const latestInput = Array.isArray(bridge.recentShortcutInputs)
    ? bridge.recentShortcutInputs[0]
    : null;
  console.log(
    `[bluebubbles-validate] shortcut target=${bridge.shortcutsRunTarget} input=${contract?.inputType ?? "unknown"} required=${requiredKeys} optional=${optionalKeys}`,
  );
  if (latestInput?.path) {
    console.log(
      `[bluebubbles-validate] latest preserved Shortcut input=${latestInput.path}`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const message = args.message.trim() || defaultMessage();
  const payload = {
    recipient: args.recipient.trim() || undefined,
    chatGuid: args.chatGuid.trim() || undefined,
    message,
    method: args.method || undefined,
  };

  const doctor = await getJson(`${args.bridgeUrl}/doctor`);
  const diagnostics = await getOptionalJson(`${args.bridgeUrl}/diagnostics`);
  console.log(
    `[bluebubbles-validate] bridge doctor: ${doctor.status}; ${summarizeDoctor(doctor)}`,
  );
  printShortcutDiagnostics(diagnostics);
  console.log(
    `[bluebubbles-validate] prepared real send to ${payload.chatGuid ?? payload.recipient}: ${message}`,
  );

  if (!args.confirmRealSend) {
    const error =
      "Refusing to send without --confirm-real-send. This command transmits a real SMS/iMessage.";
    writeEvidence({
      evidencePath: args.evidencePath,
      ok: false,
      bridgeUrl: args.bridgeUrl,
      payload,
      doctor,
      diagnostics,
      blocker: "needs_confirm_real_send",
      error,
    });
    throw new Error(error);
  }

  const unexpectedBlockers = unexpectedDoctorBlockers(doctor);
  if (unexpectedBlockers.length > 0) {
    const error = `Refusing to validate while bridge prerequisites are blocked: ${unexpectedBlockers
      .map((check) => `${check.name}: ${check.detail ?? check.status}`)
      .join("; ")}`;
    writeEvidence({
      evidencePath: args.evidencePath,
      ok: false,
      bridgeUrl: args.bridgeUrl,
      payload,
      doctor,
      diagnostics,
      blocker: "bridge_prerequisites_blocked",
      error,
    });
    throw new Error(error);
  }

  const result = await postJson(`${args.bridgeUrl}/outbound/validate`, payload);
  if (!result?.ok || !result.validation?.validatedAt) {
    const error = `Outbound validation did not return a validation record: ${JSON.stringify(result)}`;
    writeEvidence({
      evidencePath: args.evidencePath,
      ok: false,
      bridgeUrl: args.bridgeUrl,
      payload,
      doctor,
      diagnostics,
      result,
      blocker: "validation_record_missing",
      error,
    });
    throw new Error(error);
  }

  writeEvidence({
    evidencePath: args.evidencePath,
    ok: true,
    bridgeUrl: args.bridgeUrl,
    payload,
    doctor,
    diagnostics,
    result,
  });
  console.log(
    `[bluebubbles-validate] PASS ${result.validation.method} validated at ${result.validation.validatedAt}`,
  );
  console.log(
    "[bluebubbles-validate] Next: bun run --cwd packages/app-core sms-gateway:verify:bluebubbles",
  );
}

main().catch((error) => {
  console.error(
    `[bluebubbles-validate] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
