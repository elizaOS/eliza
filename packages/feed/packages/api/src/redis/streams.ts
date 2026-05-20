/**
 * Redis Streams Support
 *
 * @description Provides Redis Streams operations for pub/sub messaging.
 * Works with any Redis server via the standard Redis protocol.
 */

import { logger } from '@feed/shared';
import type { JsonValue } from '../types';
import { getRedisClient, type RedisInstance } from './client';

/**
 * Convert a payload object into Redis stream field/value pairs (stringified).
 * Keeps a single `payload` field to avoid field explosion.
 */
const encodeStreamPayload = (payload: Record<string, JsonValue>) => {
  return {
    payload: JSON.stringify(payload),
  };
};

/**
 * Add an entry to a Redis stream with optional trimming.
 *
 * @param {string} stream - Stream name
 * @param {Record<string, JsonValue>} payload - Payload to add
 * @param {{ maxlen?: number }} opts - Options (maxlen for trimming)
 * @returns {Promise<string | null>} Stream entry ID or null
 */
export async function streamAdd(
  stream: string,
  payload: Record<string, JsonValue>,
  opts?: { maxlen?: number }
): Promise<string | null> {
  const client = getRedisClient();
  if (!client) {
    logger.warn(
      'streamAdd skipped - Redis client not available',
      { stream },
      'Redis'
    );
    return null;
  }

  // Check if client is connected
  const status = client.status;
  if (status !== 'ready') {
    logger.warn(
      'streamAdd called with non-ready client',
      { status, stream },
      'Redis'
    );
    // Still attempt - ioredis will queue the command
  }

  const entry = encodeStreamPayload(payload);

  // Build args in correct Redis XADD order:
  // XADD key [MAXLEN [= | ~] threshold] <* | id> field value [field value ...]
  const args: (string | number)[] = [stream];

  // MAXLEN must come after the stream key and before the entry ID
  if (opts?.maxlen !== undefined) {
    args.push('MAXLEN', '~', opts.maxlen);
  }

  args.push('*');
  Object.entries(entry).forEach(([key, value]) => {
    args.push(key, String(value));
  });

  const result = await client.xadd(...(args as [string, string]));

  // Log successful stream writes for debugging
  if (result) {
    logger.debug('streamAdd succeeded', { stream, messageId: result }, 'Redis');
  } else {
    logger.warn('streamAdd returned null', { stream }, 'Redis');
  }

  return result;
}

export interface StreamMessage<T = Record<string, unknown>> {
  stream: string;
  id: string;
  payload: T;
}

/**
 * Extract payload from Redis stream fields
 */
const extractPayload = (fields: unknown[]): Record<string, unknown> | null => {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (typeof key === 'string') {
      obj[key] = value;
    }
  }

  if (typeof obj.payload === 'string') {
    const parsed: unknown = JSON.parse(obj.payload);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return { payload: obj.payload };
  }

  return obj;
};

/**
 * Read entries from Redis streams starting from the provided IDs.
 *
 * @param {string[]} streams - Stream names to read from
 * @param {string[]} ids - Starting IDs for each stream
 * @param {{ count?: number; block?: number; client?: RedisInstance }} opts - Options (count for limiting results, block for blocking read in ms, client for explicit Redis client)
 * @returns {Promise<StreamMessage[]>} Array of stream messages
 */
export async function streamRead(
  streams: string[],
  ids: string[],
  opts?: { count?: number; block?: number; client?: RedisInstance }
): Promise<StreamMessage[]> {
  // Use provided client or fall back to getRedisClient()
  const client = opts?.client ?? getRedisClient();
  if (!client || streams.length === 0 || ids.length === 0) {
    if (!client) {
      logger.warn(
        'streamRead skipped - Redis client not available',
        { streams, idsCount: ids.length },
        'Redis'
      );
    }
    return [];
  }

  // Check if client is connected
  const status = client.status;
  if (status !== 'ready') {
    logger.warn(
      'streamRead called with non-ready client',
      { status, streams },
      'Redis'
    );
    // Still attempt the read - ioredis will queue the command
  }

  const streamArgs = [...streams, ...ids] as string[];

  // Build XREAD command with optional BLOCK and COUNT
  // XREAD [COUNT count] [BLOCK milliseconds] STREAMS key [key ...] id [id ...]
  // Log before XREAD for debugging SSE issues
  logger.debug(
    'XREAD starting',
    {
      streams,
      ids,
      block: opts?.block,
      count: opts?.count,
      clientStatus: client.status,
    },
    'Redis'
  );

  let res: unknown;
  if (opts?.block !== undefined && opts?.count !== undefined) {
    res = await client.xread(
      'COUNT',
      opts.count,
      'BLOCK',
      opts.block,
      'STREAMS',
      ...streamArgs
    );
  } else if (opts?.block !== undefined) {
    res = await client.xread('BLOCK', opts.block, 'STREAMS', ...streamArgs);
  } else if (opts?.count !== undefined) {
    res = await client.xread('COUNT', opts.count, 'STREAMS', ...streamArgs);
  } else {
    res = await client.xread('STREAMS', ...streamArgs);
  }

  // Log XREAD completion
  logger.debug(
    'XREAD completed',
    {
      streams,
      hasResult: res !== null && res !== undefined,
      resultType: typeof res,
    },
    'Redis'
  );

  // Log XREAD result for debugging
  if (res !== null && res !== undefined) {
    logger.debug(
      'XREAD returned data',
      {
        streams,
        hasResult: Array.isArray(res),
        resultLength: Array.isArray(res) ? res.length : 0,
      },
      'Redis'
    );
  }

  const parsed: StreamMessage[] = [];
  if (Array.isArray(res)) {
    for (const streamEntry of res) {
      if (!Array.isArray(streamEntry) || streamEntry.length < 2) continue;
      const [streamName, records] = streamEntry as [string, unknown];
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        if (!Array.isArray(record) || record.length < 2) continue;
        const [id, fields] = record as [string, unknown];
        if (!Array.isArray(fields)) continue;
        const payload = extractPayload(fields);
        if (payload) {
          parsed.push({ stream: streamName, id, payload });
        }
      }
    }
  }

  // Log when messages are found for debugging
  if (parsed.length > 0) {
    logger.debug(
      'streamRead found messages',
      { count: parsed.length, streams },
      'Redis'
    );
  }

  return parsed;
}
