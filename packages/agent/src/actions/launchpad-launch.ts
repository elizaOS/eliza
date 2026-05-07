/**
 * LAUNCHPAD_LAUNCH action — drives an in-app browser tab through a
 * profile-driven launchpad playbook (four.meme, flap.sh) while the user
 * watches in the right-side chat panel.
 *
 * Decisions:
 *   - User confirms each launch tx in the steward approval surface; this
 *     action never auto-signs.
 *   - Image + metadata generation happen before the browser run so the
 *     engine has everything it needs before the cursor starts moving.
 *   - dryRun: "stop-before-tx" lets smoke tests exercise the entire
 *     pre-launch flow without submitting on a live network.
 */

import type {
  Action,
  ActionExample,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { hasRoleAccess } from "../security/access.js";
import { resolveDesktopBrowserWorkspaceTargetTabId } from "../services/browser-workspace-desktop.js";
import { runLaunchpadImageGeneration } from "../services/launchpads/image-generator.js";
import { runLaunchpad } from "../services/launchpads/launchpad-engine.js";
import type {
  LaunchpadDryRun,
  LaunchpadProfile,
} from "../services/launchpads/launchpad-types.js";
import {
  type GeneratedTokenMetadata,
  generateTokenMetadata,
} from "../services/launchpads/metadata-generator.js";
import {
  flapShMainnetProfile,
  flapShTestnetProfile,
} from "../services/launchpads/profiles/flap-sh.js";
import {
  fourMemeMainnetProfile,
  fourMemeTestnetProfile,
} from "../services/launchpads/profiles/four-meme.js";

type LaunchpadKey =
  | "four-meme"
  | "four-meme:testnet"
  | "flap-sh"
  | "flap-sh:testnet";

interface LaunchpadLaunchParameters {
  /** Which launchpad to drive. */
  launchpad: LaunchpadKey;
  /**
   * Optional browser-workspace tab id. When omitted the action auto-
   * resolves the currently-active tab from the desktop bridge so the user
   * doesn't have to pass an opaque id from chat.
   */
  tabId?: string;
  /** Optional theme hint shaping the LLM-generated metadata. */
  theme?: string;
  /** Optional symbol seed if the user already has one in mind. */
  symbolHint?: string;
  /** Stop before submitting the on-chain transaction. */
  dryRun?: LaunchpadDryRun;
}

function resolveProfile(key: LaunchpadKey): LaunchpadProfile {
  switch (key) {
    case "four-meme":
      return fourMemeMainnetProfile;
    case "four-meme:testnet":
      return fourMemeTestnetProfile;
    case "flap-sh":
      return flapShMainnetProfile;
    case "flap-sh:testnet":
      return flapShTestnetProfile;
  }
}

function resolveImageUrl(
  metadata: GeneratedTokenMetadata,
  generated: { imageUrl: string | null; imageBase64: string | null } | null,
): string {
  if (generated?.imageUrl) return generated.imageUrl;
  if (generated?.imageBase64) {
    return `data:image/png;base64,${generated.imageBase64}`;
  }
  // Last-resort placeholder so the engine doesn't stall on the upload step.
  // Picsum returns a deterministic-ish image keyed by the symbol.
  const seed = encodeURIComponent(metadata.symbol);
  return `https://picsum.photos/seed/${seed}/1024/1024`;
}

export const launchpadLaunchAction: Action = {
  name: "LAUNCHPAD_LAUNCH",
  contexts: ["finance", "payments", "wallet", "crypto", "browser"],
  roleGate: { minRole: "OWNER" },
  similes: ["LAUNCH_TOKEN", "CREATE_MEME_COIN", "LAUNCH_MEME", "LAUNCH_COIN"],
  description:
    "Drive an in-app browser tab through a launchpad (four.meme or flap.sh, both on BNB Chain) to launch a token while the user watches. Generates token metadata + image, fills the form with realistic cursor movement, and stops at the wallet confirmation sheet — the user approves each transaction. Use dryRun: 'stop-before-tx' for testnet runs.",
  descriptionCompressed:
    "drive in-app browser tab through launchpad (four meme flap sh, both BNB Chain) launch token user watch generate token metadata + image, fill form w/ realistic cursor movement, stop wallet confirmation sheet user approve each transaction use dryrun: stop-before-tx testnet run",
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    hasRoleAccess(runtime, message, "USER"),
  handler: async (runtime, message, _state, options) => {
    const params = (options as HandlerOptions | undefined)
      ?.parameters as unknown as LaunchpadLaunchParameters | undefined;
    if (!params?.launchpad) {
      return {
        text: "LAUNCHPAD_LAUNCH requires a `launchpad` parameter (one of four-meme, four-meme:testnet, flap-sh, flap-sh:testnet).",
        success: false,
        values: { success: false, error: "LAUNCHPAD_LAUNCH_BAD_PARAMS" },
      };
    }

    const profile = resolveProfile(params.launchpad);
    const dryRun: LaunchpadDryRun = params.dryRun ?? "off";

    // Auto-resolve the active tab when chat didn't provide an explicit
    // tabId. The desktop bridge sorts tabs by lastFocusedAt so the front
    // of the list is what the user is currently watching.
    let resolvedTabId: string;
    try {
      resolvedTabId =
        params.tabId?.trim() ||
        (await resolveDesktopBrowserWorkspaceTargetTabId(
          { subaction: "navigate", id: undefined } as Parameters<
            typeof resolveDesktopBrowserWorkspaceTargetTabId
          >[0],
          process.env,
        ));
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : "no active browser tab";
      return {
        text: `LAUNCHPAD_LAUNCH could not pick a target tab: ${reason}. Open a browser tab first, then ask again.`,
        success: false,
        values: { success: false, error: "LAUNCHPAD_LAUNCH_NO_TAB" },
      };
    }

    try {
      const metadata = await generateTokenMetadata(runtime, {
        theme: params.theme,
        symbolHint: params.symbolHint,
      });
      const image = await runLaunchpadImageGeneration(
        runtime,
        metadata.imagePrompt,
      );
      const imageUrl = resolveImageUrl(metadata, image);

      logger.info(
        `[launchpad] starting ${profile.id} for tab ${resolvedTabId} (dryRun=${dryRun})`,
      );

      // Stream each step's narration into the page-browser conversation as
      // a synthetic agent message so the user sees the timeline unfold in
      // chat as the cursor moves. Mirror to logger for dev/CI visibility.
      const narrate = async (line: string): Promise<void> => {
        logger.info(`[launchpad:${profile.id}] ${line}`);
        try {
          const narrationMemory: Memory = {
            id: crypto.randomUUID() as UUID,
            entityId: runtime.agentId,
            roomId: message.roomId,
            worldId: message.worldId,
            content: {
              text: line,
              source: "launchpad",
              type: "system",
            },
          };
          await runtime.createMemory(narrationMemory, "messages");
        } catch (err) {
          // Never let a narration failure abort the launchpad run — the
          // logger mirror above is enough to recover the timeline.
          logger.warn(
            `[launchpad] narrate failed for ${profile.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      };

      const result = await runLaunchpad(profile, {
        tabId: resolvedTabId,
        metadata: {
          name: metadata.name,
          symbol: metadata.symbol,
          description: metadata.description,
          imageUrl,
          theme: metadata.theme,
        },
        narrate,
        dryRun,
      });

      return {
        text: result.ok
          ? `Launchpad ${profile.displayName}: ${result.reason} (token: ${metadata.name} / ${metadata.symbol}).`
          : `Launchpad ${profile.displayName} stopped: ${result.reason}`,
        success: result.ok,
        values: {
          success: result.ok,
          launchpad: profile.id,
          stoppedAtStep: result.stoppedAtStep,
        },
        data: {
          actionName: "LAUNCHPAD_LAUNCH",
          profileId: profile.id,
          metadata,
          imageUrl,
          result,
          dryRun,
        },
      };
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : "Launchpad run failed";
      logger.warn(`[launchpad] ${profile.id} threw: ${messageText}`);
      return {
        text: `Launchpad ${profile.displayName} failed: ${messageText}`,
        success: false,
        values: { success: false, error: "LAUNCHPAD_LAUNCH_FAILED" },
        data: { actionName: "LAUNCHPAD_LAUNCH", profileId: profile.id },
      };
    }
  },
  parameters: [
    {
      name: "launchpad",
      description:
        "Which launchpad to drive: four-meme, four-meme:testnet, flap-sh, flap-sh:testnet",
      required: true,
      schema: {
        type: "string" as const,
        enum: ["four-meme", "four-meme:testnet", "flap-sh", "flap-sh:testnet"],
      },
    },
    {
      name: "tabId",
      description:
        "Browser-workspace tab id (optional — defaults to the user's active tab)",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "theme",
      description: "Optional theme hint shaping the generated token metadata",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "symbolHint",
      description: "Optional symbol seed if the user already has one in mind",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "dryRun",
      description:
        "Set to 'stop-before-tx' to exercise the full flow without submitting on-chain",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["off", "stop-before-tx"],
      },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Launch a meme token on four.meme in testnet mode." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Launchpad four.meme: dry-run stopped before transaction (token: Eliza WAGMI / WAGMI).",
        },
      },
    ],
  ] as ActionExample[][],
};
