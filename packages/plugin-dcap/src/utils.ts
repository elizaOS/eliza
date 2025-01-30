import { IAgentRuntime } from "@elizaos/core";
import { TEEMode } from "@elizaos/plugin-tee";
import { DCAPMode } from "./types";

export const is0xString = (s: string) =>
    typeof s === "string" && s.startsWith("0x");

export function hasPrivateKey(runtime: IAgentRuntime) {
    try {
        return is0xString(runtime.getSetting("EVM_PRIVATE_KEY"));
    } catch {
        return false;
    }
}

export function getDCAPMode(runtime: IAgentRuntime) {
    try {
        const mode = runtime.getSetting("DCAP_MODE");
        if (!mode) return;
        switch (mode.toUpperCase()) {
            case DCAPMode.PLUGIN_SGX:
                return DCAPMode.PLUGIN_SGX;
            case DCAPMode.PLUGIN_TEE:
                return DCAPMode.PLUGIN_TEE;
            case DCAPMode.MOCK:
                return DCAPMode.MOCK;
        }
    } catch {}
}

export const getTEEMode = (runtime: IAgentRuntime) =>
    runtime.getSetting("TEE_MODE") as TEEMode;

export function hasTEEMode(runtime: IAgentRuntime) {
    try {
        const mode = getTEEMode(runtime);
        return mode && mode !== TEEMode.OFF;
    } catch {
        return false;
    }
}
