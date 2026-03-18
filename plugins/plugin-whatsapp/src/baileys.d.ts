declare module "@whiskeysockets/baileys" {
  export interface BaileysSocket {
    sendMessage(jid: string, content: { text: string }): Promise<any>;
    end(reason?: any): void;
    ev: {
      on(event: string, handler: (...args: any[]) => void): void;
    };
    user?: { id: string };
  }

  export interface AuthenticationState {
    creds: any;
    keys: any;
  }

  export interface WAMessage {
    key: {
      remoteJid?: string;
      fromMe?: boolean;
      id?: string;
    };
    message?: any;
    pushName?: string;
    messageTimestamp?: number;
  }

  export default function makeWASocket(config: any): BaileysSocket;
  export function useMultiFileAuthState(
    path: string,
  ): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }>;
  export const DisconnectReason: Record<string, number>;
  export function fetchLatestBaileysVersion(): Promise<{ version: number[] }>;
}
