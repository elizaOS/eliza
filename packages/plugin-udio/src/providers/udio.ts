import { IAgentRuntime, Memory, State, type Provider } from "@elizaos/core";
import type { UdioGenerateResponse, UdioSamplerOptions, UdioSong } from "../types";

const API_BASE_URL = "https://www.udio.com/api";

export interface UdioConfig {
    authToken: string;
    baseUrl?: string;
}

export class UdioProvider implements Provider {
    private authToken: string;
    private baseUrl: string;

    static async get(runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<UdioProvider> {
        const authToken = runtime.getSetting("UDIO_AUTH_TOKEN");
        if (!authToken) {
            throw new Error("UDIO_AUTH_TOKEN is required");
        }
        return new UdioProvider({ authToken });
    }

    constructor(config: UdioConfig) {
        this.authToken = config.authToken;
        this.baseUrl = config.baseUrl || API_BASE_URL;
    }

    async get(_runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<UdioProvider> {
        return this;
    }

    async makeRequest(url: string, method: string, data?: Record<string, unknown>) {
        const headers = {
            "Accept": method === 'GET' ? "application/json, text/plain, */*" : "application/json",
            "Content-Type": "application/json",
            "Cookie": `sb-api-auth-token=${this.authToken}`,
            "Origin": "https://www.udio.com",
            "Referer": "https://www.udio.com/my-creations",
        };

        const options: RequestInit = {
            method,
            headers,
            body: data ? JSON.stringify(data) : undefined,
        };

        const response = await fetch(url, options);
        if (!response.ok) {
            throw new Error(`UDIO_API_ERROR: ${response.status}`);
        }
        return response.json();
    }

    async generateSong(prompt: string, samplerOptions: UdioSamplerOptions, customLyrics?: string): Promise<UdioGenerateResponse> {
        const url = `${this.baseUrl}/generate-proxy`;
        const data = {
            prompt,
            samplerOptions,
            ...(customLyrics && { lyricInput: customLyrics }),
        };
        return this.makeRequest(url, 'POST', data);
    }

    async checkSongStatus(songIds: string[]): Promise<{songs: UdioSong[]}> {
        const url = `${this.baseUrl}/songs?songIds=${songIds.join(',')}`;
        return this.makeRequest(url, 'GET');
    }
}