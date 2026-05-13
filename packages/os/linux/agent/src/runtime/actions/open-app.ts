// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

import { existsSync } from "node:fs";
import type { Action, IAgentRuntime, Memory } from "@elizaos/core";

import { extractSlot, slugify } from "../match.ts";
import { appsRoot } from "../paths.ts";

const VERBS = ["open", "launch", "show", "run"] as const;

export const OPEN_APP_ACTION: Action = {
    name: "OPEN_APP",
    similes: [
        "open my calendar",
        "launch my notes",
        "open my app",
        "show my notes",
        "run my calendar",
        "open notes",
        "launch calendar",
    ],
    description:
        "Re-open a previously built app from the user's sandbox. Used when the user " +
        "says 'open my <thing>', 'launch my <thing>', 'show my <thing>'.",

    validate: async (_runtime: IAgentRuntime, message: Memory) => {
        const text = typeof message.content?.text === "string" ? message.content.text : "";
        return extractSlot(text, VERBS) !== null;
    },

    handler: async (_runtime, message, _state, _options, callback) => {
        const text = typeof message.content?.text === "string" ? message.content.text : "";
        const target = extractSlot(text, VERBS);
        if (target === null) {
            return { success: false, text: "I couldn't tell what to open." };
        }
        const slug = slugify(target);
        const manifestPath = `${appsRoot()}/${slug}/manifest.json`;

        if (!existsSync(manifestPath)) {
            const reply = `I haven't built a "${target}" yet. Try "build me a ${target}" first.`;
            if (callback) await callback({ text: reply, actions: ["OPEN_APP"] });
            return { success: false, text: reply };
        }
        const reply = `Opening your ${target}.`;
        if (callback) {
            await callback({
                text: reply,
                actions: ["OPEN_APP"],
                data: { launch: { slug, manifestPath, backend: "cache" } },
            });
        }
        return {
            success: true,
            text: reply,
            data: {
                actionName: "OPEN_APP",
                launch: { slug, manifestPath, backend: "cache" },
            },
        };
    },

    examples: [
        [
            { name: "{{user}}", content: { text: "open my calendar" } },
            { name: "Eliza", content: { text: "Opening your calendar." } },
        ],
    ],
};
