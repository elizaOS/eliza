declare module "@elizaos/signal-native" {
  export interface SignalProfile {
    uuid: string;
    phoneNumber?: string;
    name?: string;
  }

  export interface SignalMessage {
    senderUuid?: string;
    text?: string;
    timestamp?: number;
    isQueueEmpty?: boolean;
  }

  export function getProfile(authDir: string): Promise<SignalProfile>;
  export function receiveMessages(
    authDir: string,
    callback: (msg: SignalMessage) => void,
  ): Promise<void>;
  export function stopReceiving(authDir: string): Promise<void>;
  export function sendMessage(
    authDir: string,
    recipientId: string,
    messageText: string,
  ): Promise<void>;
}
