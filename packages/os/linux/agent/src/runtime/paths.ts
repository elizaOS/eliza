// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Path helpers shared by runtime actions. Mirrors what `chat.ts` previously
 * computed inline so we don't have two sources of truth.
 */

export function appsRoot(): string {
    const explicit = Bun.env.USBELIZA_APPS_ROOT;
    if (explicit !== undefined && explicit !== "") {
        return explicit;
    }
    const home = Bun.env.HOME ?? "/tmp";
    return `${home}/.eliza/apps`;
}
