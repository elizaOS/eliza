import { IAgentRuntime } from "@elizaos/core";
import { retryWithBackoff } from "../utils";

export class SmartThingsApi {
  private baseUrl = 'https://api.smartthings.com/v1';
  private token: string;

  constructor(runtime: IAgentRuntime) {
    this.token = runtime.getSetting("SMARTTHINGS_TOKEN");
    if (!this.token) {
      throw new Error("SmartThings token is required");
    }
  }

  private async request(endpoint: string, options: RequestInit = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`SmartThings API error: ${response.statusText}`);
    }

    return response.json();
  }

  devices = {
    list: () => this.request('/devices'),
    get: (deviceId: string) => this.request(`/devices/${deviceId}`),
    getStatus: (deviceId: string) => this.request(`/devices/${deviceId}/status`),
    executeCommand: (deviceId: string, command: any) =>
      this.request(`/devices/${deviceId}/commands`, {
        method: 'POST',
        body: JSON.stringify({
          commands: [command]
        })
      }),
    executeCommands: (deviceId: string, commands: any[]) =>
      this.request(`/devices/${deviceId}/commands`, {
        method: 'POST',
        body: JSON.stringify({ commands })
      }),
    getComponents: (deviceId: string) =>
      this.request(`/devices/${deviceId}/components`),
    getCapabilities: (deviceId: string) =>
      this.request(`/devices/${deviceId}/capabilities`)
  };

  scenes = {
    list: () => this.request('/scenes'),
    execute: (sceneId: string) =>
      this.request(`/scenes/${sceneId}/execute`, {
        method: 'POST'
      })
  };

  rooms = {
    list: () => this.request('/rooms'),
    get: (roomId: string) => this.request(`/rooms/${roomId}`)
  };
}

export const smartThingsApi = new SmartThingsApi(null as any); // Will be initialized later