#!/usr/bin/env bun

import 'dotenv/config';
import { logger } from "@elizaos/core";
import fs from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import archiver from 'archiver';

// Paths
const PROJECT_ROOT = path.join(process.cwd(), '..');
const RAW_DATA_DIR = path.join(PROJECT_ROOT, 'src/tests/benchmarks/data/price-talk-trenches');
const PROCESSED_DATA_DIR = path.join(PROJECT_ROOT, 'src/tests/benchmarks/data_processed');
const DATASET_DIR = process.cwd();
const DATA_DIR = path.join(DATASET_DIR, 'data');
const PRICE_HISTORY_DIR = path.join(DATA_DIR, 'price_history');

// Interfaces
interface DiscordMessage {
  id: string;
  uid: string;
  content: string;
  ts: string;
  type?: string;
}

interface DiscordUser {
  name: string;
  nickname?: string;
  global_name?: string;
}

interface EnrichedCall {
  callId: string;
  originalMessageId: string;
  userId: string;
  username: string;
  timestamp: number;
  content: string;
  tokenMentioned?: string;
  nameMentioned?: string;
  caMentioned?: string;
  chain: string;
  sentiment: string;
  conviction: string;
  llmReasoning: string;
  certainty: string;
  fileSource: string;
  enrichmentStatus: string;
  enrichmentError?: string;
  resolvedToken?: {
    address: string;
    symbol: string;
    name: string;
    chain: string;
  };
  priceData?: {
    calledPrice: number;
    calledPriceTimestamp: number;
    bestPrice: number;
    bestPriceTimestamp: number;
    worstPrice: number;
    worstPriceTimestamp: number;
    idealProfitLoss: number;
    idealProfitLossPercent: number;
    windowDays: number;
  };
  enrichedAt?: number;
}

interface MessageRecord {
  message_id: string;
  user_id: string;
  username: string;
  timestamp: number;
  content: string;
  date: string;
  is_call: boolean;
  call_id?: string;
}

interface CallRecord {
  call_id: string;
  message_id: string;
  user_id: string;
  username: string;
  timestamp: number;
  content: string;
  token_mentioned?: string;
  token_address?: string;
  chain: string;
  sentiment: string;
  conviction: string;
  llm_reasoning: string;
  certainty: string;
  price_at_call?: number;
  price_data?: any;
  enrichment_status: string;
  enrichment_error?: string;
}

interface TokenRecord {
  address: string;
  symbol: string;
  name: string;
  chain: string;
  date_created?: string;
  total_supply?: number;
  decimals?: number;
  liquidity_usd?: number;
  volume_24h?: number;
  market_cap?: number;
  ath?: number;
  ath_date?: string;
  atl?: number;
  atl_date?: string;
  call_count: number;
  first_mentioned: number;
  last_mentioned: number;
}

interface UserRecord {
  user_id: string;
  username: string;
  total_messages: number;
  total_calls: number;
  successful_calls: number;
  failed_calls: number;
  neutral_calls: number;
  avg_profit_loss: number;
  total_profit_loss: number;
  best_call: number;
  worst_call: number;
  success_rate: number;
  first_message: number;
  last_message: number;
  tokens_called: string[];
}

async function loadAllMessages(): Promise<Map<string, MessageRecord>> {
  logger.info("📖 Loading all chat messages...");
  
  const messages = new Map<string, MessageRecord>();
  const files = await fs.readdir(RAW_DATA_DIR);
  const chatFiles = files.filter(f => f.startsWith('chat_') && f.endsWith('.json')).sort();
  
  // Only process files from 10/26 onwards
  const startDate = new Date('2024-10-26');
  const validFiles = chatFiles.filter(file => {
    const match = file.match(/chat_(\d{4}-\d{2}-\d{2})\.json/);
    if (match) {
      const fileDate = new Date(match[1]);
      return fileDate >= startDate;
    }
    return false;
  });
  
  logger.info(`Found ${validFiles.length} chat files from 10/26 onwards`);
  
  for (const file of validFiles) {
    const filePath = path.join(RAW_DATA_DIR, file);
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    
    const users: Record<string, DiscordUser> = data.users || {};
    const rawMessages: DiscordMessage[] = data.messages || [];
    
    for (const msg of rawMessages) {
      if (!msg.content || !msg.uid) continue;
      
      const username = users[msg.uid]?.global_name || 
                      users[msg.uid]?.nickname || 
                      users[msg.uid]?.name || 
                      'Unknown';
      
      messages.set(msg.id, {
        message_id: msg.id,
        user_id: msg.uid,
        username,
        timestamp: new Date(msg.ts).getTime(),
        content: msg.content,
        date: new Date(msg.ts).toISOString(),
        is_call: false // Will be updated later
      });
    }
  }
  
  logger.info(`Loaded ${messages.size} messages`);
  return messages;
}

async function loadEnrichedCalls(): Promise<EnrichedCall[]> {
  logger.info("📊 Loading enriched calls...");
  
  const enrichedFile = path.join(PROCESSED_DATA_DIR, 'enriched/enriched_calls_complete.json');
  const content = await fs.readFile(enrichedFile, 'utf-8');
  const calls = JSON.parse(content) as EnrichedCall[];
  
  logger.info(`Loaded ${calls.length} enriched calls`);
  return calls;
}

async function loadTrustScores(): Promise<any[]> {
  logger.info("🏆 Loading trust scores...");
  
  const trustFile = path.join(PROCESSED_DATA_DIR, 'enriched/trust_scores.json');
  const content = await fs.readFile(trustFile, 'utf-8');
  const scores = JSON.parse(content);
  
  logger.info(`Loaded trust scores for ${scores.length} users`);
  return scores;
}

async function buildMessagesDataset(messages: Map<string, MessageRecord>, calls: EnrichedCall[]): Promise<MessageRecord[]> {
  logger.info("🔨 Building messages dataset...");
  
  // Mark messages that are calls
  const callMessageIds = new Set(calls.map(c => c.originalMessageId));
  const callIdByMessageId = new Map(calls.map(c => [c.originalMessageId, c.callId]));
  
  for (const [msgId, msg] of messages) {
    if (callMessageIds.has(msgId)) {
      msg.is_call = true;
      msg.call_id = callIdByMessageId.get(msgId);
    }
  }
  
  // Convert to array and sort by timestamp
  const messageArray = Array.from(messages.values()).sort((a, b) => a.timestamp - b.timestamp);
  
  logger.info(`Built messages dataset with ${messageArray.length} messages (${callMessageIds.size} are calls)`);
  return messageArray;
}

async function buildCallsDataset(calls: EnrichedCall[]): Promise<CallRecord[]> {
  logger.info("📞 Building calls dataset...");
  
  // Filter out AI16Z calls
  const NATIVE_TOKEN = 'AI16Z';
  let filteredCalls = calls.filter(call => 
    call.tokenMentioned?.toUpperCase() !== NATIVE_TOKEN &&
    call.resolvedToken?.symbol?.toUpperCase() !== NATIVE_TOKEN
  );
  
  const ai16zFiltered = calls.length - filteredCalls.length;
  logger.info(`Filtered ${ai16zFiltered} ${NATIVE_TOKEN} calls`);
  
  // Sort by timestamp for deduplication
  filteredCalls.sort((a, b) => a.timestamp - b.timestamp);
  
  // Apply deduplication (same user, token, sentiment within 1 hour)
  logger.info("Applying deduplication (same token/sentiment within 1 hour)...");
  const beforeDedup = filteredCalls.length;
  
  // Group by user + token + sentiment
  const callGroups = new Map<string, EnrichedCall[]>();
  
  for (const call of filteredCalls) {
    const key = `${call.userId}_${call.tokenMentioned || 'unknown'}_${call.sentiment}`;
    if (!callGroups.has(key)) {
      callGroups.set(key, []);
    }
    callGroups.get(key)!.push(call);
  }
  
  // Filter calls within 1 hour of each other
  const dedupedCalls: EnrichedCall[] = [];
  
  for (const [key, group] of callGroups) {
    if (group.length === 1) {
      dedupedCalls.push(group[0]);
    } else {
      // Keep first call, then only calls >1 hour after previous kept
      let lastKeptTime = group[0].timestamp;
      dedupedCalls.push(group[0]);
      
      for (let i = 1; i < group.length; i++) {
        if (group[i].timestamp - lastKeptTime > 3600000) { // 1 hour in ms
          dedupedCalls.push(group[i]);
          lastKeptTime = group[i].timestamp;
        }
      }
    }
  }
  
  // Sort back by timestamp
  dedupedCalls.sort((a, b) => a.timestamp - b.timestamp);
  
  const dedupFiltered = beforeDedup - dedupedCalls.length;
  logger.info(`Removed ${dedupFiltered} duplicate calls`);
  
  const callRecords: CallRecord[] = dedupedCalls.map(call => ({
    call_id: call.callId,
    message_id: call.originalMessageId,
    user_id: call.userId,
    username: call.username,
    timestamp: call.timestamp,
    content: call.content,
    token_mentioned: call.tokenMentioned,
    token_address: call.resolvedToken?.address || call.caMentioned,
    chain: call.chain,
    sentiment: call.sentiment,
    conviction: call.conviction,
    llm_reasoning: call.llmReasoning,
    certainty: call.certainty,
    price_at_call: call.priceData?.calledPrice,
    price_data: call.priceData,
    enrichment_status: call.enrichmentStatus,
    enrichment_error: call.enrichmentError
  }));
  
  logger.info(`Built calls dataset with ${callRecords.length} calls (filtered ${ai16zFiltered} AI16Z, ${dedupFiltered} duplicates)`);
  return callRecords;
}

async function buildTokenManifest(calls: CallRecord[]): Promise<TokenRecord[]> {
  logger.info("🪙 Building token manifest...");
  
  const tokenMap = new Map<string, TokenRecord>();
  
  // Use CallRecord format now instead of EnrichedCall
  for (const call of calls) {
    if (!call.token_address || !call.token_mentioned) continue;
    
    // Skip AI16Z just in case
    if (call.token_mentioned.toUpperCase() === 'AI16Z') continue;
    
    const address = call.token_address;
    if (!tokenMap.has(address)) {
      tokenMap.set(address, {
        address,
        symbol: call.token_mentioned,
        name: call.token_mentioned, // Use symbol as name if not available
        chain: call.chain,
        call_count: 0,
        first_mentioned: call.timestamp,
        last_mentioned: call.timestamp
      });
    }
    
    const token = tokenMap.get(address)!;
    token.call_count++;
    token.first_mentioned = Math.min(token.first_mentioned, call.timestamp);
    token.last_mentioned = Math.max(token.last_mentioned, call.timestamp);
  }
  
  const tokens = Array.from(tokenMap.values()).sort((a, b) => b.call_count - a.call_count);
  
  logger.info(`Built token manifest with ${tokens.length} unique tokens`);
  return tokens;
}

async function buildUserManifest(messages: MessageRecord[], calls: CallRecord[], trustScores: any[]): Promise<UserRecord[]> {
  logger.info("👥 Building user manifest...");
  
  const userMap = new Map<string, UserRecord>();
  const trustScoreMap = new Map(trustScores.map(s => [s.userId, s]));
  
  // Process all messages
  for (const msg of messages) {
    if (!userMap.has(msg.user_id)) {
      userMap.set(msg.user_id, {
        user_id: msg.user_id,
        username: msg.username,
        total_messages: 0,
        total_calls: 0,
        successful_calls: 0,
        failed_calls: 0,
        neutral_calls: 0,
        avg_profit_loss: 0,
        total_profit_loss: 0,
        best_call: 0,
        worst_call: 0,
        success_rate: 0,
        first_message: msg.timestamp,
        last_message: msg.timestamp,
        tokens_called: []
      });
    }
    
    const user = userMap.get(msg.user_id)!;
    user.total_messages++;
    user.first_message = Math.min(user.first_message, msg.timestamp);
    user.last_message = Math.max(user.last_message, msg.timestamp);
  }
  
  // Process deduplicated calls
  for (const call of calls) {
    const user = userMap.get(call.user_id);
    if (!user) continue;
    
    user.total_calls++;
    
    if (call.token_mentioned) {
      if (!user.tokens_called.includes(call.token_mentioned)) {
        user.tokens_called.push(call.token_mentioned);
      }
    }
    
    // Get trust score data if available
    const trustData = trustScoreMap.get(call.user_id);
    if (trustData) {
      user.successful_calls = trustData.successfulCalls || 0;
      user.failed_calls = trustData.unsuccessfulCalls || 0;
      user.neutral_calls = trustData.neutralCalls || 0;
      user.avg_profit_loss = trustData.averageProfitLossPercent || 0;
      user.total_profit_loss = trustData.totalProfitLossPercent || 0;
      user.best_call = trustData.bestCallProfitPercent || 0;
      user.worst_call = trustData.worstCallLossPercent || 0;
      user.success_rate = trustData.successRate || 0;
    }
  }
  
  const users = Array.from(userMap.values())
    .filter(u => u.total_calls > 0) // Only include users who made calls
    .sort((a, b) => b.total_calls - a.total_calls);
  
  logger.info(`Built user manifest with ${users.length} users who made calls`);
  return users;
}

async function exportToJSON(data: any, filename: string): Promise<void> {
  const filepath = path.join(DATA_DIR, filename);
  await fs.writeFile(filepath, JSON.stringify(data, null, 2));
  logger.info(`✅ Exported ${filename}`);
}

async function exportToParquet(data: any, filename: string): Promise<void> {
  // For now, we'll create a placeholder - in production you'd use parquet-wasm or similar
  const filepath = path.join(DATA_DIR, filename);
  await fs.writeFile(filepath, `Parquet export placeholder for ${filename}`);
  logger.info(`✅ Created placeholder for ${filename}`);
}

async function createCompressedArchives(): Promise<void> {
  logger.info("📦 Creating compressed archives...");
  
  const zipPath = path.join(DATASET_DIR, 'compressed/trenches-dataset.zip');
  const tarPath = path.join(DATASET_DIR, 'compressed/trenches-dataset.tar.gz');
  
  // Create ZIP archive
  const zipOutput = createWriteStream(zipPath);
  const zipArchive = archiver('zip', { zlib: { level: 9 } });
  
  zipArchive.pipe(zipOutput);
  zipArchive.directory(DATA_DIR, 'data');
  await zipArchive.finalize();
  
  logger.info(`✅ Created ZIP archive: ${zipPath}`);
  
  // Create TAR.GZ archive
  const tarOutput = createWriteStream(tarPath);
  const tarArchive = archiver('tar', { gzip: true });
  
  tarArchive.pipe(tarOutput);
  tarArchive.directory(DATA_DIR, 'data');
  await tarArchive.finalize();
  
  logger.info(`✅ Created TAR.GZ archive: ${tarPath}`);
}

async function main() {
  logger.info("🚀 Starting Trenches Chat Dataset Builder");
  logger.info("=" .repeat(60));
  
  try {
    // Step 1: Load all data
    const messages = await loadAllMessages();
    const calls = await loadEnrichedCalls();
    const trustScores = await loadTrustScores();
    
    // Step 2: Build datasets
    const messagesDataset = await buildMessagesDataset(messages, calls);
    const callsDataset = await buildCallsDataset(calls);
    const tokenManifest = await buildTokenManifest(callsDataset);
    const userManifest = await buildUserManifest(Array.from(messages.values()), callsDataset, trustScores);
    
    // Step 3: Export datasets
    logger.info("\n📤 Exporting datasets...");
    
    await exportToJSON(messagesDataset, 'messages.json');
    await exportToParquet(messagesDataset, 'messages.parquet');
    
    await exportToJSON(callsDataset, 'calls.json');
    await exportToParquet(callsDataset, 'calls.parquet');
    
    await exportToJSON(tokenManifest, 'tokens.json');
    await exportToParquet(tokenManifest, 'tokens.parquet');
    
    await exportToJSON(userManifest, 'users.json');
    await exportToParquet(userManifest, 'users.parquet');
    
    // Step 4: Create compressed archives
    await createCompressedArchives();
    
    // Step 5: Generate summary statistics
    logger.info("\n📊 Dataset Summary:");
    logger.info(`- Total messages: ${messagesDataset.length}`);
    logger.info(`- Total calls: ${callsDataset.length}`);
    logger.info(`- Unique tokens: ${tokenManifest.length}`);
    logger.info(`- Active users: ${userManifest.length}`);
    logger.info(`- Date range: ${new Date(messagesDataset[0].timestamp).toISOString()} to ${new Date(messagesDataset[messagesDataset.length - 1].timestamp).toISOString()}`);
    
    logger.info("\n✅ Dataset building complete!");
    logger.info(`📁 Output directory: ${DATASET_DIR}`);
    
  } catch (error) {
    logger.error("❌ Error building dataset:", error);
    process.exit(1);
  }
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
} 