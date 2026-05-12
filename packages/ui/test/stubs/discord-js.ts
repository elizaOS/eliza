export const GatewayIntentBits = {
  Guilds: 1,
  GuildMembers: 2,
  GuildMessages: 512,
  DirectMessages: 4096,
  MessageContent: 32768,
} as const;

export class Client {
  login(): Promise<string> {
    return Promise.resolve("stub-token");
  }

  destroy(): void {}

  once(): this {
    return this;
  }

  on(): this {
    return this;
  }
}
