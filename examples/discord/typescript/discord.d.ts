/**
 * Minimal type declarations for discord.js when used as type-only imports.
 * Full types come from @elizaos/plugin-discord or add discord.js as dependency.
 */
declare module 'discord.js' {
  export interface Message {
    id: string;
    content: string;
    channelId: string;
    [key: string]: unknown;
  }
  export interface Interaction {
    id: string;
    isChatInputCommand(): boolean;
    reply(options: { content?: string; ephemeral?: boolean }): Promise<unknown>;
    [key: string]: unknown;
  }
  export interface GuildMember {
    id: string;
    user: { id: string; username: string; [key: string]: unknown };
    [key: string]: unknown;
  }
}
