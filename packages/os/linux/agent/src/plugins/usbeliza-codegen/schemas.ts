// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * JSON Schema for the structured output we ask `claude --print
 * --json-schema=...` to produce when generating an app.
 *
 * The schema is intentionally restrictive (no additionalProperties,
 * required-field lists) so a half-formed reply from the LLM is rejected
 * client-side rather than reaching the manifest validator.
 *
 * The shape mirrors `eliza_types::Manifest` plus a `files` map keyed by
 * relative paths under `<slug>/`. Keeping these aligned is load-bearing —
 * the Rust validator and the TS generator must both accept the same JSON.
 */

export const CODEGEN_OUTPUT_SCHEMA = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "UsbelizaCodegenOutput",
    type: "object",
    additionalProperties: false,
    required: ["manifest", "files"],
    properties: {
        manifest: {
            type: "object",
            additionalProperties: false,
            required: [
                "schema_version",
                "slug",
                "title",
                "intent",
                "runtime",
                "entry",
                "capabilities",
                "version",
                "last_built_by",
                "last_built_at",
            ],
            properties: {
                schema_version: { type: "integer", const: 1 },
                slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
                title: { type: "string", minLength: 1 },
                intent: { type: "string", minLength: 1 },
                runtime: {
                    enum: [
                        "webview",
                        "gtk4",
                        "terminal",
                        "wallpaper",
                        "panel-top",
                        "panel-bottom",
                        "panel-left",
                        "panel-right",
                        "dock",
                        "widget",
                    ],
                },
                entry: { type: "string", minLength: 1 },
                capabilities: {
                    type: "array",
                    items: {
                        type: "object",
                        required: ["kind"],
                        properties: {
                            kind: {
                                enum: [
                                    "time:read",
                                    "storage:scoped",
                                    "notifications:write",
                                    "network:fetch",
                                    "clipboard:read",
                                    "clipboard:write",
                                    "files:open-dialog",
                                    "agent:ask",
                                    "media:play",
                                    "print:emit",
                                ],
                            },
                            allowlist: {
                                type: "array",
                                items: { type: "string" },
                            },
                        },
                    },
                },
                version: { type: "integer", minimum: 1 },
                last_built_by: { type: "string", minLength: 1 },
                last_built_at: { type: "string", minLength: 1 },
            },
        },
        files: {
            type: "object",
            additionalProperties: { type: "string" },
            minProperties: 1,
        },
    },
} as const;

/** TypeScript echo of the schema so the generator and writer stay in sync. */
export interface CodegenOutput {
    manifest: {
        schema_version: 1;
        slug: string;
        title: string;
        intent: string;
        runtime:
            | "webview"
            | "gtk4"
            | "terminal"
            | "wallpaper"
            | "panel-top"
            | "panel-bottom"
            | "panel-left"
            | "panel-right"
            | "dock"
            | "widget";
        entry: string;
        capabilities: Array<{ kind: string; allowlist?: string[] }>;
        version: number;
        last_built_by: string;
        last_built_at: string;
    };
    files: Record<string, string>;
}
