export const GatewayIntentBits = {
  Guilds: 1,
  GuildMembers: 2,
  GuildMessages: 512,
  DirectMessages: 4096,
  MessageContent: 32768,
} as const;

export const ApplicationCommandOptionType = {
  String: 3,
  Integer: 4,
  Boolean: 5,
  User: 6,
  Channel: 7,
  Role: 8,
  Mentionable: 9,
  Number: 10,
  Attachment: 11,
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
