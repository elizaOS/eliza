/**
 * Clawd Code — VOICE MODE
 *
 * Two sub-modes:
 *   TTS mode (default)  — Local sherpa-onnx or sag CLI text-to-speech
 *   Agent mode (--agent) — xAI Voice Agent API (grok-voice-think-fast-1.0)
 *                          Real-time Solana tools: balance, price, trade, send
 *
 * Usage:
 *   clawd-code voice "Hello from Clawd"             # TTS
 *   clawd-code voice --agent                         # xAI Voice Agent REPL
 *   clawd-code voice --agent --voice ara             # choose voice
 *   clawd-code voice --agent --model grok-voice-think-fast-1.0
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_VOICE_MODEL } from '../grok-models.js';
import { VoiceAgentClient } from '../voice-agent.js';

interface VoiceConfig {
  xaiApiKey?: string;
  rpcUrl?: string;
  liveTrading?: boolean;
  model?: string;
}

/** Default voice model for xAI realtime voice agent. */
const DEFAULT_VOICE = DEFAULT_VOICE_MODEL;

export class VoiceMode {
  constructor(private config: VoiceConfig) {}

  async run(args: string[]): Promise<void> {
    // Check for --agent flag → xAI Voice Agent API
    if (args.includes('--agent') || args.includes('--live-voice')) {
      await this.runVoiceAgent(args);
      return;
    }

    // Default: TTS mode
    await this.runTTS(args);
  }

  // ── xAI Voice Agent (real-time conversation with Solana tools) ─────────────

  private async runVoiceAgent(args: string[]): Promise<void> {
    const apiKey = this.config.xaiApiKey ?? process.env.XAI_API_KEY ?? '';
    if (!apiKey) {
      console.error('[VOICE AGENT] XAI_API_KEY is required for voice agent mode.');
      console.error('Set it in ~/.clawd-code/.env or export XAI_API_KEY=<key>');
      process.exit(1);
    }

    let voice: 'eve' | 'ara' | 'rex' | 'sal' | 'leo' = 'eve';
    const voiceIdx = args.indexOf('--voice');
    if (voiceIdx !== -1 && args[voiceIdx + 1]) {
      const v = args[voiceIdx + 1] as typeof voice;
      if (['eve', 'ara', 'rex', 'sal', 'leo'].includes(v)) voice = v;
    }

    let model: string | undefined;
    const modelIdx = args.indexOf('--model');
    if (modelIdx !== -1 && args[modelIdx + 1]) model = args[modelIdx + 1];

    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║  🦞 CLAWD VOICE AGENT                                ║');
    console.log('║  xAI Voice Agent API — Solana-native real-time voice ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');
    console.log(`Model : ${model ?? DEFAULT_VOICE}`);
    console.log(`Voice : ${voice}`);
    console.log(`Mode  : ${this.config.liveTrading ? 'LIVE (confirm before trades)' : 'PAPER (no real funds)'}`);
    console.log('\nTools : check_sol_balance, get_token_price, get_funding_rate,');
    console.log('        check_positions, paper_trade, send_sol, get_market_overview\n');

    const client = new VoiceAgentClient({
      xaiApiKey: apiKey,
      rpcUrl: this.config.rpcUrl ?? process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
      model,
      voice,
      liveTrading: this.config.liveTrading ?? false,
    });

    await client.runText();
  }

  // ── TTS mode (sherpa-onnx or sag CLI) ────────────────────────────────────

  private async runTTS(args: string[]): Promise<void> {
    const text = args.filter((a) => !a.startsWith('--')).join(' ');
    let voice = 'Clawd';
    let outputFile = `/tmp/clawd-voice-${Date.now()}.mp3`;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--voice' && args[i + 1]) voice = args[i + 1];
      if (args[i] === '--output' && args[i + 1]) outputFile = args[i + 1];
    }

    console.log('\n[VOICE MODE] Initiating text-to-speech...\n');
    console.log(`[VOICE MODE] Text: ${text}`);
    console.log(`[VOICE MODE] Voice: ${voice}`);
    console.log(`[VOICE MODE] Output: ${outputFile}`);

    const sherpaExists = existsSync(
      `${process.env.HOME ?? ''}/.clawdbot/tools/sherpa-onnx-tts/runtime/bin/sherpa-onnx-tts`,
    );

    if (sherpaExists) {
      await this.generateLocalTTS(text, voice, outputFile);
    } else {
      await this.generateSagTTS(text, voice, outputFile);
    }
  }

  private generateLocalTTS(text: string, voice: string, outputFile: string): Promise<void> {
    console.log('\n[VOICE MODE] Generating via sherpa-onnx (local, zero API cost)...');
    const runtimeDir = `${process.env.HOME ?? ''}/.clawdbot/tools/sherpa-onnx-tts/runtime`;
    const modelDir =
      process.env.SHERPA_ONNX_MODEL_DIR ??
      `${process.env.HOME ?? ''}/.clawdbot/tools/sherpa-onnx-tts/models/vits-piper-en_US-lessac-high`;
    const ttsBinary = join(runtimeDir, 'bin', 'sherpa-onnx-tts');

    return new Promise((resolve) => {
      const proc = spawn(
        ttsBinary,
        ['--output', outputFile, '--model-file', join(modelDir, 'vits-piper-en_US-lessac-high.onnx'), '--tokens-file', join(modelDir, 'tokens.txt'), text],
        { stdio: 'pipe' },
      );
      proc.on('close', (code) => {
        if (code === 0) {
          console.log('\n[VOICE MODE] TTS generated successfully');
          console.log(`[VOICE MODE] Audio: ${outputFile}`);
        } else {
          console.log('[VOICE MODE] Local TTS failed, trying sag...');
          void this.generateSagTTS(text, voice, outputFile).then(resolve);
        }
        resolve();
      });
    });
  }

  private generateSagTTS(text: string, voice: string, outputFile: string): Promise<void> {
    console.log('\n[VOICE MODE] Generating via sag CLI...');
    return new Promise((resolve) => {
      try {
        const proc = spawn('sag', ['-v', voice, '-o', outputFile, text], { stdio: 'pipe' });
        proc.on('close', (code) => {
          if (code === 0) {
            console.log('\n[VOICE MODE] Voice generated successfully');
            console.log(`[VOICE MODE] Audio: ${outputFile}`);
          } else {
            console.log('\n[VOICE MODE] Voice unavailable. Install sherpa-onnx or set ELEVENLABS_API_KEY.');
            console.log('[VOICE AGENT TIP] Use --agent for xAI realtime voice (requires XAI_API_KEY).');
          }
          resolve();
        });
      } catch {
        console.log('\n[VOICE MODE] sag CLI not found. Try: clawd-code voice --agent');
        resolve();
      }
    });
  }
}
