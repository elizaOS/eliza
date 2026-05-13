// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

import { describe, expect, test } from "bun:test";

import { agentStatusResponse } from "../src/status.ts";

describe("agentStatusResponse", () => {
    test("emits schema_version=1 on every variant", () => {
        for (const state of ["booting", "ready", "crashed"] as const) {
            const response = agentStatusResponse(state);
            expect(response.schema_version).toBe(1);
            expect(response.state).toBe(state);
        }
    });

    test("response shape stays JSON-stable", () => {
        const json = JSON.stringify(agentStatusResponse("ready"));
        expect(json).toBe('{"schema_version":1,"state":"ready"}');
    });
});
