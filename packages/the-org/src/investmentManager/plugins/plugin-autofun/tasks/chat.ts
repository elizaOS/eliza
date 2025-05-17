// todo: replace Client reference with client reference
// Set up cache adapter for loading cookies
// This action should be able to run on a schedule
// store tweets as memories in db, no reason really to get twitter here

import {
  ChannelType,
  type IAgentRuntime,
  ServiceType,
  type UUID,
  createUniqueUuid,
  logger,
  stringToUuid,
  Service,
} from '@elizaos/core';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';

interface ChatService extends Service {
  getClientKey(clientId: UUID, agentId: UUID): string;
  clients: Map<string, any>;
}

/**
 * Decodes a base58 string to Uint8Array
 */
function decodeBase58(str: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const ALPHABET_MAP = new Map(ALPHABET.split('').map((c, i) => [c, BigInt(i)]));

  let result = BigInt(0);
  for (const char of str) {
    const value = ALPHABET_MAP.get(char);
    if (value === undefined) {
      throw new Error('Invalid base58 character');
    }
    result = result * BigInt(58) + value;
  }

  const bytes = [];
  while (result > 0n) {
    bytes.unshift(Number(result & 0xffn));
    result = result >> 8n;
  }

  // Add leading zeros
  for (let i = 0; i < str.length && str[i] === '1'; i++) {
    bytes.unshift(0);
  }

  return new Uint8Array(bytes);
}

export default class Chat {
  runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    // Create a consistent room ID for the twitter feed
    //this.feedRoomId = createUniqueUuid(runtime, 'twitter-feed');
  }

  async processMessage() {
    // is this message new or old
    // have we seen it before
    /*
    const chatId = createUniqueUuid(this.runtime, CA + tier + item.id);

    // Check if we already have this tweet
    const existingChat = await this.runtime.getMemoryById(chatId);
    if (existingChat) {
      return;
    }
    */
    /*
    const entityId = createUniqueUuid(this.runtime, message.author.id);
    const channelId = message.channel.id; // CA + tier
    const roomId = createUniqueUuid(this.runtime, channelId);
    const userName = .address
    const name = .displayName

    await this.runtime.ensureConnection({
      entityId: entityId,
      roomId,
      userName,
      name: name,
      source: 'discord',
      channelId: message.channel.id,
      serverId,
      type,
    });

      const messageId = createUniqueUuid(this.runtime, message.id);

      const newMessage: Memory = {
        id: messageId,
        entityId: entityId,
        agentId: this.runtime.agentId,
        roomId: roomId,
        content: {
          // name: name,
          // userName: userName,
          text: processedContent || ' ',
          attachments: attachments,
          source: 'discord',
          url: message.url,
          inReplyTo: message.reference?.messageId
            ? createUniqueUuid(this.runtime, message.reference?.messageId)
            : undefined,
        },
        metadata: {
          entityName: name,
        },
        createdAt: message.createdTimestamp,
      };

    */

    const callback: HandlerCallback = async (content: Content, files: any[]) => {
      try {
        if (message.id && !content.inReplyTo) {
          content.inReplyTo = createUniqueUuid(this.runtime, message.id);
        }

        /*
        const messages = await sendMessageInChunks(
          message.channel as TextChannel,
          content.text,
          message.id,
          files
        );
        */
        console.log('channel', message.channel);
        console.log('text', content.text);
        console.log('id', message.id);
        console.log('files', files);
        // POST https://api.auto.fun/api/chat/HN8GGgzBFvuePPL3DGPg7uuq2dVgLApnNcW4pxY9a11o/1k
        // {message: "Hello world", media: null}

        const memories: Memory[] = [];
        for (const m of messages) {
          const actions = content.actions;

          const memory: Memory = {
            id: createUniqueUuid(this.runtime, m.id),
            entityId: this.runtime.agentId,
            agentId: this.runtime.agentId,
            content: {
              ...content,
              actions,
              inReplyTo: messageId,
              url: m.url,
              channelType: type,
            },
            roomId,
            createdAt: m.createdTimestamp,
          };
          memories.push(memory);
        }

        for (const m of memories) {
          await this.runtime.createMemory(m, 'messages');
        }
        return memories;
      } catch (error) {
        console.error('Error sending message:', error);
        return [];
      }
    };

    this.runtime.emitEvent([DiscordEventTypes.MESSAGE_RECEIVED, EventType.MESSAGE_RECEIVED], {
      runtime: this.runtime,
      message: newMessage,
      callback,
    });
  }

  async syncChats(): Promise<boolean> {
    // First refresh wallet data
    await this.runtime.emitEvent('INTEL_SYNC_WALLET', {});

    // Replace the cache lookup with direct wallet balance check
    const privateKeyString = this.runtime.getSetting('SOLANA_PRIVATE_KEY');
    const privateKeyBytes = decodeBase58(privateKeyString);
    const walletKeypair = Keypair.fromSecretKey(privateKeyBytes);
    const connection = new Connection(this.runtime.getSetting('SOLANA_RPC_URL'));
    const balance = await connection.getBalance(walletKeypair.publicKey);
    const solBalance = balance / 1e9;

    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletKeypair.publicKey, {
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    });
    // context/value
    /*
{
      pubkey: PublicKey {
        _bn: <BN: fb8ece5d70a75e918ec192f91c739da6b0798fc10a320f2c3ffa19df18e31a58>,
        equals: [Function: equals],
        toBase58: [Function: toBase58],
        toJSON: [Function: toJSON],
        toBytes: [Function: toBytes],
        toBuffer: [Function: toBuffer],
        toString: [Function: toString],
        encode: [Function: encode],
      },
      account: {
        lamports: 2039280,
        data: {
          program: "spl-token",
          parsed: {
            info: {
              isNative: false,
              mint: "EJZELt2vBYdEq1WcwE61y1ABXBNcEYtj5V4GcKuNveS8",
              owner: "3nMBmufBUBVnk28sTp3NsrSJsdVGTyLZYmsqpMFaUT9J",
              state: "initialized",
              tokenAmount: {
                amount: "0",
                decimals: 6,
                uiAmount: 0,
                uiAmountString: "0",
              },
            },
            type: "account",
          },
          space: 165,
        },
        owner: PublicKey {
          _bn: <BN: 6ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9>,
          equals: [Function: equals],
          toBase58: [Function: toBase58],
          toJSON: [Function: toJSON],
          toBytes: [Function: toBytes],
          toBuffer: [Function: toBuffer],
          toString: [Function: toString],
          encode: [Function: encode],
        },
        executable: false,
        rentEpoch: 18446744073709552000,
        space: 165,
      },
    }
    */
    //console.log('tokenAccounts', tokenAccounts.value)
    const over1kTokens = tokenAccounts.value
      .filter((t) => t.account.data.parsed.info.tokenAmount.uiAmount > 1000)
      .map((t) => t.account.data.parsed.info.mint);
    const over100kTokens = tokenAccounts.value
      .filter((t) => t.account.data.parsed.info.tokenAmount.uiAmount > 100_000)
      .map((t) => t.account.data.parsed.info.mint);
    console.log('over1kTokens', over1kTokens.length);
    console.log('over100kTokens', over100kTokens.length);
    const baseUrl = 'https://api.auto.fun/api/chat/{{token}}/1k?limit=50&offset=0';
    console.log('over1kTokens', over1kTokens, over100kTokens);

    const chat1kRes = await Promise.all(
      over1kTokens.map((CA) => fetch(baseUrl.replace('{{token}}', CA)))
    );
    const chat1kData = await Promise.all(chat1kRes.map((res) => res.json()));

    console.log('chat1kData', chat1kData);

    // success: true, messages: [{
    //   timestamp, displayName (null), profileImage (null), address
    // }]
  }
}
