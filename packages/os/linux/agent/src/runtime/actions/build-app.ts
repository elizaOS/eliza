// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * BUILD_APP — generate a small app from a natural-language request.
 *
 * Shape lifted from milady's `eliza/packages/agent/src/actions/terminal.ts`:
 * proper @elizaos/core Action with name + similes + description + validate
 * + handler. The handler shells out to the usbeliza-codegen plugin
 * (`claude --print` / `codex` under the hood) which in turn writes the
 * generated app to `~/.eliza/apps/<slug>/` and returns a manifest path.
 *
 * The dispatcher (see runtime/dispatch.ts) chooses BUILD_APP by ranking
 * Action.similes against the user message — no per-action regex.
 */

import type { Action, IAgentRuntime, Memory } from "@elizaos/core";

import {
    type GenerationOutput,
    generateApp,
    type CodegenError,
} from "../../plugins/usbeliza-codegen/actions/generate-app.ts";
import { extractSlot, slugify } from "../match.ts";
import { appsRoot } from "../paths.ts";

const VERBS = ["build", "make", "create", "generate", "write", "draw"] as const;

export const BUILD_APP_ACTION: Action = {
    name: "BUILD_APP",
    similes: [
        "build me an app",
        "make me an app",
        "create an app",
        "build a calendar",
        "make a notes app",
        "create a clock",
        "generate an app",
        "write me an app",
        "build an ide",
        "make me a calculator",
    ],
    description:
        "Generate a small single-window app from a natural-language request and " +
        "open it in a sandboxed window. Used when the user says 'build me a <thing>', " +
        "'make me a <thing>', 'create a <thing>'.",

    validate: async (_runtime: IAgentRuntime, message: Memory) => {
        const text = typeof message.content?.text === "string" ? message.content.text : "";
        return extractSlot(text, VERBS) !== null;
    },

    handler: async (_runtime, message, _state, _options, callback) => {
        const text = typeof message.content?.text === "string" ? message.content.text : "";
        const target = extractSlot(text, VERBS);
        if (target === null) {
            return { success: false, text: "I couldn't tell what to build." };
        }
        const slug = slugify(target);
        if (slug === "") {
            return { success: false, text: "That doesn't look like a buildable thing." };
        }

        try {
            const out: GenerationOutput = await generateApp({
                slug,
                intent: text.trim(),
                calibration: null,
                appsRoot: appsRoot(),
            });
            const reply = `Built your ${target}. Opening it now.`;
            if (callback) {
                await callback({
                    text: reply,
                    actions: ["BUILD_APP"],
                    data: { launch: { slug: out.slug, manifestPath: out.manifestPath, backend: out.backend } },
                });
            }
            return {
                success: true,
                text: reply,
                data: {
                    actionName: "BUILD_APP",
                    launch: {
                        slug: out.slug,
                        manifestPath: out.manifestPath,
                        backend: out.backend,
                    },
                },
            };
        } catch (err) {
            const stage = (err as CodegenError).stage ?? "unknown";
            const reply = `I couldn't build the ${target}: ${(err as Error).message} (stage: ${stage}).`;
            return { success: false, text: reply };
        }
    },

    examples: [
        [
            { name: "{{user}}", content: { text: "build me a calendar" } },
            { name: "Eliza", content: { text: "Building you a calendar. About a minute." } },
        ],
        [
            { name: "{{user}}", content: { text: "make me a notes app" } },
            { name: "Eliza", content: { text: "On it." } },
        ],
    ],
};
