// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * System actions: LIST_MODELS, SETUP_PERSISTENCE, HELP.
 *
 * These are deterministic responders that don't need the LLM — same shape
 * as milady's settings-actions.ts but scoped to usbeliza's surface.
 */

import type { Action } from "@elizaos/core";

import {
    formatPickResultForChat,
    recommendModelTier,
} from "../../local-inference/picker.ts";

export const LIST_MODELS_ACTION: Action = {
    name: "LIST_MODELS",
    similes: [
        "list models",
        "show models",
        "what models",
        "available models",
        "list llms",
        "show llms",
        "what local models",
        "list local inference",
    ],
    description:
        "List local models that fit the user's RAM with size recommendations, " +
        "read from the bundled catalog.",

    validate: async () => true,

    handler: async (_runtime, _message, _state, _options, callback) => {
        let text: string;
        try {
            const result = recommendModelTier();
            text = formatPickResultForChat(result);
        } catch (err) {
            text =
                `I couldn't read /proc/meminfo to size the recommendation (${(err as Error).message}). ` +
                'Try "help" for the catalog overview instead.';
        }
        if (callback) await callback({ text, actions: ["LIST_MODELS"] });
        return { success: true, text };
    },
};

const PERSISTENCE_REPLY =
    "I can set up encrypted storage on this stick — your apps, your Wi-Fi, your downloaded " +
    "models all survive a reboot. The walk-through is conversational: I'll ask for a " +
    "passphrase, format a LUKS partition on the stick, and you'll see a passphrase prompt " +
    "the next time you boot. " +
    "(For now the actual creation runs from a terminal — say 'open a terminal' and I'll " +
    "show you the script. Phase 1.5 wires the full passphrase flow into this chat box.)";

export const SETUP_PERSISTENCE_ACTION: Action = {
    name: "SETUP_PERSISTENCE",
    similes: [
        "set up persistence",
        "setup persistence",
        "enable persistence",
        "turn on persistence",
        "create encrypted partition",
        "encrypt my disk",
        "enable luks",
        "make my stuff persist",
    ],
    description:
        "Walk the user through enabling LUKS-encrypted persistence on the USB stick.",

    validate: async () => true,

    handler: async (_runtime, _message, _state, _options, callback) => {
        if (callback) await callback({ text: PERSISTENCE_REPLY, actions: ["SETUP_PERSISTENCE"] });
        return { success: true, text: PERSISTENCE_REPLY };
    },
};

const HELP_REPLY =
    "I can build small apps for you — try \"build me a calendar\" or \"build me a notes app\" — " +
    "and re-open them later with \"open my calendar\". " +
    "I can also get you online (\"connect to wifi\"), tell you if we're connected (\"am i online\"), " +
    "or show you which local models fit your RAM (\"list models\"). " +
    "There's encrypted persistence for the stick (\"set up persistence\"), and once you have " +
    "Claude or Codex signed in, the apps I build get much better. " +
    "Or just talk — I'm here.";

export const HELP_ACTION: Action = {
    name: "HELP",
    similes: [
        "help",
        "what can you do",
        "what can i do",
        "what should i do",
        "what can i say",
        "what can i try",
        "how do i start",
        "how do i use this",
    ],
    description: "Show the user the catalog of phrases I respond to.",

    validate: async () => true,

    handler: async (_runtime, _message, _state, _options, callback) => {
        if (callback) await callback({ text: HELP_REPLY, actions: ["HELP"] });
        return { success: true, text: HELP_REPLY };
    },
};
