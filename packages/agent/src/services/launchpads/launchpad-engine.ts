/**
 * Launchpad playbook engine.
 *
 * Iterates a LaunchpadProfile's steps, narrating each one and dispatching
 * the matching BrowserWorkspaceCommand. The engine assumes a watch-mode
 * page-browser scope (cursor visible, narration goes into the chat
 * conversation) and prefers the realistic-* subactions added in
 * browser-workspace-desktop.ts.
 *
 * The engine never auto-signs transactions. The `confirmTx` step pauses
 * for the user to approve the tx in the steward sheet (or the in-page
 * wallet popup) and then waits for confirmation evidence. In dryRun mode
 * the engine stops before clicking submit.
 */

import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
} from "./../browser-workspace-types.js";
import { executeBrowserWorkspaceCommand } from "./../browser-workspace.js";
import type {
  LaunchpadDryRun,
  LaunchpadNarrate,
  LaunchpadProfile,
  LaunchpadResult,
  LaunchpadStep,
  LaunchpadTokenMetadata,
} from "./launchpad-types.js";

interface EngineOptions {
  /** Browser-workspace tab id the playbook drives. */
  tabId: string;
  /** Token metadata the playbook fills into the launchpad form. */
  metadata: LaunchpadTokenMetadata;
  /** Narration callback (synthetic agent message). */
  narrate: LaunchpadNarrate;
  /** Stop the engine before clicking submit when "stop-before-tx". */
  dryRun?: LaunchpadDryRun;
  /** Optional environment override (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Per-step retry limit on recoverable errors. */
  maxRetries?: number;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_WAIT_TIMEOUT_MS = 8_000;
const DEFAULT_TX_AWAIT_TIMEOUT_MS = 90_000;
const STEP_GAP_MS = 350;

function fieldValue(
  field: LaunchpadStep & { kind: "fillField" },
  metadata: LaunchpadTokenMetadata,
): string {
  switch (field.field) {
    case "name":
      return metadata.name;
    case "symbol":
      return metadata.symbol;
    case "description":
      return metadata.description;
    case "twitter":
    case "telegram":
    case "website":
      // Optional social links — empty string is fine; the launchpad form
      // typically treats empty fields as skipped.
      return "";
  }
}

function defaultNarration(step: LaunchpadStep, profileName: string): string {
  switch (step.kind) {
    case "navigate":
      return `Navigating to ${profileName}`;
    case "waitFor":
      return step.selector
        ? `Waiting for ${step.selector}`
        : "Waiting for page to settle";
    case "connectWallet":
      return `Connecting ${step.chain.toUpperCase()} wallet`;
    case "fillField":
      return `Filling ${step.field}`;
    case "uploadImage":
      return "Uploading token image";
    case "click":
      return step.text
        ? `Clicking "${step.text}"`
        : `Clicking ${step.selector ?? "element"}`;
    case "confirmTx":
      return "Submitting — please confirm in your wallet";
    case "awaitTxResult":
      return "Waiting for transaction confirmation";
  }
}

function commandForStep(
  step: LaunchpadStep,
  options: EngineOptions,
): BrowserWorkspaceCommand | null {
  const id = options.tabId;
  switch (step.kind) {
    case "navigate":
      return { id, subaction: "navigate", url: step.url };
    case "waitFor":
      return {
        id,
        subaction: "wait",
        selector: step.selector,
        text: step.text,
        timeoutMs: step.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
        state: "visible",
      };
    case "connectWallet":
      return {
        id,
        subaction: "realistic-click",
        selector: step.connectButton,
      };
    case "fillField":
      return {
        id,
        subaction: "realistic-fill",
        selector: step.selector,
        value: fieldValue(step, options.metadata),
        replace: true,
      };
    case "uploadImage":
      return {
        id,
        subaction: "realistic-upload",
        selector: step.selector,
        files: [options.metadata.imageUrl],
      };
    case "click":
      return {
        id,
        subaction: "realistic-click",
        selector: step.selector,
        text: step.text,
      };
    case "confirmTx":
      // The tx submission click itself is a separate "click" step; this
      // step is the wait-for-confirmation pause. The engine treats it as
      // a no-op command — narration runs, dryRun gate fires, then the
      // followup awaitTxResult step polls.
      return null;
    case "awaitTxResult":
      return {
        id,
        subaction: "wait",
        text: step.explorerUrlPattern,
        timeoutMs: step.timeoutMs ?? DEFAULT_TX_AWAIT_TIMEOUT_MS,
        state: "visible",
      };
  }
}

function isRecoverable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // These keywords reflect transient races (element not yet rendered,
  // network blip, etc). Anything else is treated as fatal.
  return /not found|timed out|navigation|not visible|stale/i.test(message);
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStep(
  step: LaunchpadStep,
  options: EngineOptions,
  profile: LaunchpadProfile,
): Promise<BrowserWorkspaceCommandResult | null> {
  const command = commandForStep(step, options);
  if (!command) {
    return null;
  }
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await executeBrowserWorkspaceCommand(command, options.env);
    } catch (error) {
      lastError = error;
      if (!isRecoverable(error) || attempt === maxRetries) {
        throw error;
      }
      // Light backoff between retries.
      await delay(400 * (attempt + 1));
    }
  }
  // Should be unreachable; appeases the type system.
  if (lastError instanceof Error) throw lastError;
  throw new Error(
    `Launchpad ${profile.id} step ${step.kind} failed without a captured error.`,
  );
}

export async function runLaunchpad(
  profile: LaunchpadProfile,
  options: EngineOptions,
): Promise<LaunchpadResult> {
  const dryRun: LaunchpadDryRun = options.dryRun ?? "off";

  for (let stepIndex = 0; stepIndex < profile.steps.length; stepIndex += 1) {
    const step = profile.steps[stepIndex];
    const narration = step.narration ?? defaultNarration(step, profile.displayName);

    if (dryRun === "stop-before-tx" && step.kind === "confirmTx") {
      await options.narrate(
        `[dry-run] Stopped before submitting on ${profile.displayName}.`,
      );
      return {
        ok: true,
        profileId: profile.id,
        stoppedAtStep: stepIndex,
        reason: "dry-run stopped before transaction",
      };
    }

    await options.narrate(narration);

    try {
      await runStep(step, options, profile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await options.narrate(
        `Stopped on step ${stepIndex + 1} (${step.kind}): ${message}`,
      );
      return {
        ok: false,
        profileId: profile.id,
        stoppedAtStep: stepIndex,
        reason: message,
      };
    }

    // Small gap between steps so the cursor animation completes and the
    // page has a tick to react. The realistic-* subactions already animate;
    // this is a safety margin for sites that mount components after click.
    await delay(STEP_GAP_MS);
  }

  return {
    ok: true,
    profileId: profile.id,
    stoppedAtStep: profile.steps.length - 1,
    reason: "completed",
  };
}
