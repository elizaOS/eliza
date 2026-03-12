declare module "discord.js" {
  export interface GuildMember {
    user: { id: string; username: string };
  }
  export interface Interaction {
    isChatInputCommand(): boolean;
    commandName?: string;
    reply(options: { content: string; ephemeral?: boolean }): Promise<unknown>;
  }
  export interface Message {
    id?: string;
  }
}
