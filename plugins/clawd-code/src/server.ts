#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createAnthropicClient } from './anthropic.js';
import { createDeepSeekClient } from './deepseek.js';
import { loadClawdEnv } from './env.js';
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  getModel,
  listModelsByProvider,
  normalizeModelId,
  type ClawdProvider,
} from './grok-models.js';
import {
  OPENROUTER_BASE_URL,
  OpenRouterClient,
  getOpenRouterNemoModels,
  isOpenRouterAutoModel,
  selectOpenRouterModel,
} from './openrouter.js';
import { createXaiClient } from './xai.js';
import { createZaiClient, getZaiEnvConfig } from './zai.js';

const CLAWD_MINT = '8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump';
const ATTESTATION_SERVICE = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG';

type ApiMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type ChatBody = {
  messages: ApiMessage[];
  provider: ClawdProvider;
  model: string;
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  apiKey?: string;
};

type TextChunk = {
  text: string;
  done: boolean;
  usage?: unknown;
  model?: string;
};

type ServerConfig = {
  host: string;
  port: number;
};

function normalizeProvider(value: unknown): ClawdProvider {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'z' || normalized === 'z.ai' || normalized === 'glm') return 'zai';
  if (normalized === 'claude' || normalized === 'ant') return 'anthropic';
  if (normalized === 'or') return 'openrouter';
  if (normalized === 'ds') return 'deepseek';
  if (['zai', 'xai', 'anthropic', 'openrouter', 'deepseek'].includes(normalized)) {
    return normalized as ClawdProvider;
  }
  return DEFAULT_PROVIDER;
}

function envKeyForProvider(provider: ClawdProvider): string {
  switch (provider) {
    case 'zai': return 'ZAI_API_KEY';
    case 'xai': return 'XAI_API_KEY';
    case 'anthropic': return 'ANTHROPIC_API_KEY';
    case 'openrouter': return 'OPENROUTER_API_KEY';
    case 'deepseek': return 'DEEPSEEK_API_KEY';
  }
}

function defaultModelForProvider(provider: ClawdProvider): string {
  return listModelsByProvider(provider)[0]?.id ?? DEFAULT_MODEL;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);

  const chunks: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      chunks.push(block.text);
    } else if (block.type === 'tool_result' && typeof block.content === 'string') {
      chunks.push(block.content);
    }
  }
  return chunks.join('\n').trim();
}

function parseMessages(input: unknown): ApiMessage[] {
  if (!Array.isArray(input)) return [];

  const messages: ApiMessage[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const role = raw.role === 'system' || raw.role === 'assistant' ? raw.role : 'user';
    const content = contentToText(raw.content);
    if (content.trim()) messages.push({ role, content });
  }
  return messages;
}

function lastUserPrompt(messages: ApiMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return messages.map((m) => m.content).join('\n');
}

function resolveModel(provider: ClawdProvider, requested: string | undefined, env: Record<string, string>, prompt: string): string {
  if (provider === 'openrouter') {
    const selection = selectOpenRouterModel({
      prompt,
      requestedModel: requested || env.CLAWD_MODEL || 'auto',
      env,
    });
    return selection.model;
  }

  const fallback = env.CLAWD_PROVIDER === provider && env.CLAWD_MODEL
    ? normalizeModelId(env.CLAWD_MODEL)
    : defaultModelForProvider(provider);
  const candidate = normalizeModelId(requested || fallback);
  const known = getModel(candidate);

  if (!known) return candidate || fallback;
  return known.provider === provider ? candidate : fallback;
}

function parseBearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, token] = header.split(/\s+/, 2);
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildChatBody(raw: unknown, req: IncomingMessage, env: Record<string, string>): ChatBody {
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const provider = normalizeProvider(req.headers['x-clawd-provider'] ?? body.provider ?? env.CLAWD_PROVIDER);
  const messages = parseMessages(body.messages);
  if (messages.length === 0 && typeof body.prompt === 'string' && body.prompt.trim()) {
    messages.push({ role: 'user', content: body.prompt.trim() });
  }
  const prompt = lastUserPrompt(messages);
  const model = resolveModel(provider, typeof body.model === 'string' ? body.model : undefined, env, prompt);
  const apiKey = parseBearer(req) || (typeof body.apiKey === 'string' ? body.apiKey : undefined);

  return {
    messages,
    provider,
    model,
    apiKey,
    stream: body.stream !== false,
    maxTokens: numberFrom(body.max_tokens) ?? numberFrom(body.maxTokens),
    temperature: numberFrom(body.temperature),
  };
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const configured = process.env.CLAWD_WEB_ORIGIN?.trim();
  const origin = configured || req.headers.origin || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Clawd-Provider',
    'Access-Control-Max-Age': '86400',
    Vary: configured ? 'Origin' : 'Origin',
  };
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    ...corsHeaders(req),
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload));
}

function sendSse(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    ...corsHeaders(req),
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
}

function writeSse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeDone(res: ServerResponse): void {
  res.write('data: [DONE]\n\n');
}

function getSystemPrompt(messages: ApiMessage[]): string | undefined {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content.trim()).filter(Boolean);
  return system.length ? system.join('\n\n') : undefined;
}

function getAnthropicMessages(messages: ApiMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages
    .filter((m): m is { role: 'user' | 'assistant'; content: string } => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));
}

async function* runProvider(body: ChatBody, env: Record<string, string>): AsyncGenerator<TextChunk> {
  const key = body.apiKey || env[envKeyForProvider(body.provider)] || '';
  if (!key) {
    throw new Error(`${envKeyForProvider(body.provider)} is required for provider ${body.provider}`);
  }

  switch (body.provider) {
    case 'zai': {
      const zai = getZaiEnvConfig(env);
      const client = createZaiClient(key, zai.baseUrl);
      if (!client) throw new Error('Unable to create Z.AI client');
      for await (const chunk of client.streamChat({
        model: body.model,
        messages: body.messages,
        maxTokens: body.maxTokens,
        temperature: body.temperature,
        thinking: zai.thinkingType,
        reasoningEffort: zai.reasoningEffort,
      })) {
        yield { text: chunk.text, done: chunk.done, usage: chunk.usage, model: chunk.model };
      }
      return;
    }
    case 'xai': {
      const client = createXaiClient(key);
      if (!client) throw new Error('Unable to create xAI client');
      for await (const chunk of client.streamChat({
        model: body.model,
        messages: body.messages,
        maxTokens: body.maxTokens,
        temperature: body.temperature,
      })) {
        yield { text: chunk.text, done: chunk.done, usage: chunk.usage, model: chunk.model };
      }
      return;
    }
    case 'anthropic': {
      const client = createAnthropicClient(key);
      if (!client) throw new Error('Unable to create Anthropic client');
      for await (const chunk of client.stream({
        model: body.model,
        system: getSystemPrompt(body.messages),
        messages: getAnthropicMessages(body.messages),
        maxTokens: body.maxTokens,
        temperature: body.temperature,
      })) {
        yield { text: chunk.text, done: chunk.done, usage: chunk.usage, model: body.model };
      }
      return;
    }
    case 'openrouter': {
      const models = getOpenRouterNemoModels(env);
      const client = new OpenRouterClient(
        key,
        env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL,
        models.balanced,
      );
      const requested = isOpenRouterAutoModel(body.model) ? undefined : body.model;
      const selected = selectOpenRouterModel({
        prompt: lastUserPrompt(body.messages),
        requestedModel: requested,
        env,
      });
      for await (const chunk of client.stream({
        model: selected.model,
        messages: body.messages,
        max_tokens: body.maxTokens,
        temperature: body.temperature,
        reasoning: selected.reasoning,
      })) {
        yield { text: chunk.content, done: chunk.done, usage: chunk.usage, model: selected.model };
      }
      return;
    }
    case 'deepseek': {
      const client = createDeepSeekClient(key, env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com');
      if (!client) throw new Error('Unable to create DeepSeek client');
      const response = await client.chat({
        model: body.model,
        messages: body.messages,
        maxTokens: body.maxTokens,
        temperature: body.temperature,
      });
      yield { text: response.content, done: false, usage: response.usage, model: response.model };
      yield { text: '', done: true, usage: response.usage, model: response.model };
      return;
    }
  }
}

async function handleChat(req: IncomingMessage, res: ServerResponse, env: Record<string, string>): Promise<void> {
  let body: ChatBody;
  try {
    body = buildChatBody(await readJson(req), req, env);
  } catch (error) {
    sendJson(req, res, 400, { error: error instanceof Error ? error.message : 'Invalid JSON body' });
    return;
  }

  if (body.messages.length === 0) {
    sendJson(req, res, 400, { error: 'messages or prompt is required' });
    return;
  }

  if (!body.apiKey && !env[envKeyForProvider(body.provider)]) {
    sendJson(req, res, 401, {
      error: `${envKeyForProvider(body.provider)} is not configured`,
      provider: body.provider,
    });
    return;
  }

  if (!body.stream) {
    try {
      let text = '';
      let model = body.model;
      let usage: unknown;
      for await (const chunk of runProvider(body, env)) {
        text += chunk.text;
        model = chunk.model || model;
        usage = chunk.usage || usage;
      }
      sendJson(req, res, 200, { content: text, model, usage });
    } catch (error) {
      sendJson(req, res, 502, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  sendSse(req, res);
  writeSse(res, { type: 'start', id: randomUUID(), provider: body.provider, model: body.model });
  try {
    for await (const chunk of runProvider(body, env)) {
      if (req.destroyed || res.destroyed) return;
      if (chunk.text) writeSse(res, { type: 'text', content: chunk.text });
      if (chunk.done) {
        writeSse(res, { type: 'done', model: chunk.model || body.model, usage: chunk.usage });
        writeDone(res);
        res.end();
        return;
      }
    }
    writeSse(res, { type: 'done', model: body.model });
    writeDone(res);
  } catch (error) {
    writeSse(res, {
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
    writeDone(res);
  } finally {
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

function discoveryDocument(req: IncomingMessage, config: ServerConfig): Record<string, unknown> {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || `${config.host}:${config.port}`;
  const issuer = process.env.CLAWD_AUTH_ISSUER || `${proto}://${host}`;
  return {
    issuer,
    protocol: 'CAAP/1.0',
    modes: ['delegated', 'autonomous'],
    keyAlgorithms: ['Ed25519'],
    solana: {
      network: process.env.SOLANA_CLUSTER || 'mainnet-beta',
      clawdMint: CLAWD_MINT,
      attestationService: ATTESTATION_SERVICE,
    },
    capabilities: [
      { name: 'agent_chat', description: 'Send messages through the Clawd Code web/API box' },
      { name: 'list_agents', description: 'Browse the Clawd agent catalog' },
      { name: 'get_peer_card', description: 'Fetch verified agent peer card and tier' },
      { name: 'attest_agent', description: 'Attest a Solana agent identity on-chain' },
    ],
  };
}

function healthPayload(env: Record<string, string>): Record<string, unknown> {
  const provider = normalizeProvider(env.CLAWD_PROVIDER);
  const model = resolveModel(provider, env.CLAWD_MODEL, env, '');
  return {
    ok: true,
    service: 'clawd-code-api',
    provider,
    model,
    web: process.env.CLAWD_WEB_ORIGIN || 'http://localhost:3000',
  };
}

export function createClawdServer(config: ServerConfig = readServerConfig()) {
  const env = loadClawdEnv();
  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${config.host}:${config.port}`}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
      sendJson(req, res, 200, healthPayload(env));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/.well-known/agent-auth.json') {
      sendJson(req, res, 200, discoveryDocument(req, config));
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/api/chat' || url.pathname === '/api/stream')) {
      await handleChat(req, res, env);
      return;
    }

    sendJson(req, res, 404, { error: 'Not found' });
  });
}

export function readServerConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  return {
    host: env.CLAWD_API_HOST || '127.0.0.1',
    port: Number(env.CLAWD_API_PORT || env.PORT || 3001),
  };
}

export async function startServer(config: ServerConfig = readServerConfig()): Promise<void> {
  const server = createClawdServer(config);
  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, resolve);
  });
  console.log(`[clawd-api] listening on http://${config.host}:${config.port}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error) => {
    console.error('[clawd-api] failed:', error);
    process.exit(1);
  });
}
