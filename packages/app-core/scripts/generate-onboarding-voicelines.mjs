#!/usr/bin/env node
/**
 * Generate static MP3 voicelines for onboarding character catchphrases.
 *
 * Usage:
 *   ELEVENLABS_API_KEY=sk_... node scripts/generate-onboarding-voicelines.mjs
 *
 * Output: packages/app/public/audio/onboarding/{characterId}-{lang}.mp3
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const API_KEY = process.env.ELEVENLABS_API_KEY;
if (!API_KEY) {
  console.error("Set ELEVENLABS_API_KEY environment variable");
  process.exit(1);
}

const OUTPUT_DIR = resolve("packages/app/public/audio/onboarding");
mkdirSync(OUTPUT_DIR, { recursive: true });

// Voice preset ID → ElevenLabs voice ID (from PREMADE_VOICES in voice/types.ts)
const VOICE_MAP = {
  sarah: "EXAVITQu4vr4xnSDxMaL",
  jin: "6IwYbsNENZgAB1dtBZDp",
  kei: "eadgjmk4R4uojdsheG9t",
  momo: "n7Wi4g1bhpw4Bs8HK5ph",
  rin: "cNYrMw9glwJZXR8RwbuR",
  ryu: "QzTKubutNn9TjrB7Xb2Q",
  satoshi: "7cOBG34AiHrAzs842Rdi",
  yuki: "4tRn1lSkEn13EVTuqb0g",
};

// Character definitions — catchphrases extracted from
// eliza/packages/shared/src/onboarding-presets.characters.ts
const CHARACTERS = [
  {
    id: "chen",
    voice: "sarah",
    catchphrases: {
      en: "Let's get to work!",
      "zh-CN": "你还好吗？",
      ko: "괜찮아?",
      es: "¿todo bien?",
      pt: "tá tudo bem?",
      vi: "ổn không?",
      tl: "ayos ka?",
    },
  },
  {
    id: "jin",
    voice: "jin",
    catchphrases: {
      en: "Anything you need, boss!",
      "zh-CN": "现在做哪个？",
      ko: "뭘 먼저 올릴까?",
      es: "¿qué vamos a sacar?",
      pt: "o que a gente vai lançar?",
      vi: "mình chốt gì đây?",
      tl: "ano'ng isi-ship natin?",
    },
  },
  {
    id: "kei",
    voice: "kei",
    catchphrases: {
      en: "Hey sure. Why not?",
      "zh-CN": "你又弄坏什么了？",
      ko: "뭘 또 망가뜨렸어?",
      es: "¿qué rompiste ahora?",
      pt: "o que você quebrou agora?",
      vi: "bạn làm hỏng gì nữa rồi?",
      tl: "ano na namang sinira mo?",
    },
  },
  {
    id: "momo",
    voice: "momo",
    catchphrases: {
      en: "I can't wait!",
      "zh-CN": "发我吧",
      ko: "보내줘",
      es: "mándamelo",
      pt: "me manda",
      vi: "gửi mình đi",
      tl: "send mo lang",
    },
  },
  {
    id: "rin",
    voice: "rin",
    catchphrases: {
      en: "I won't let you down.",
      "zh-CN": "等下，这个有点会",
      ko: "잠깐, 이건 좀 귀엽다",
      es: "ok, espera, eso está cute",
      pt: "pera, isso ficou fofo",
      vi: "ơ, cái này xinh đấy",
      tl: "teka, ang cute nito",
    },
  },
  {
    id: "ryu",
    voice: "ryu",
    catchphrases: {
      en: "How bad could it be?",
      "zh-CN": "说吧",
      ko: "말해봐",
      es: "háblame",
      pt: "fala comigo",
      vi: "nói đi",
      tl: "sabihin mo",
    },
  },
  {
    id: "satoshi",
    voice: "satoshi",
    catchphrases: {
      en: "I'll handle it.",
      "zh-CN": "现在怎么玩？",
      ko: "지금 플랜 뭐야?",
      es: "¿cuál es la jugada?",
      pt: "qual é a jogada?",
      vi: "kèo nào đây?",
      tl: "ano play natin?",
    },
  },
  {
    id: "yuki",
    voice: "yuki",
    catchphrases: {
      en: "Are you thinking what I'm thinking?",
      "zh-CN": "先问一句",
      ko: "잠깐, 한 가지만",
      es: "espera, una pregunta",
      pt: "pera, uma pergunta",
      vi: "khoan, một câu thôi",
      tl: "sandali, isang tanong",
    },
  },
];

async function generateTts(voiceId, text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_flash_v2_5",
      output_format: "mp3_44100_128",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs ${res.status}: ${body}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

let generated = 0;
let failed = 0;

for (const char of CHARACTERS) {
  const voiceId = VOICE_MAP[char.voice];
  if (!voiceId) {
    console.error(`  No voice mapping for ${char.id} (preset: ${char.voice})`);
    failed++;
    continue;
  }

  for (const [lang, catchphrase] of Object.entries(char.catchphrases)) {
    const filename = `${char.id}-${lang}.mp3`;
    const outPath = resolve(OUTPUT_DIR, filename);
    try {
      console.log(`  ${filename}: "${catchphrase}" (voice: ${char.voice})`);
      const mp3 = await generateTts(voiceId, catchphrase);
      writeFileSync(outPath, mp3);
      generated++;
      // Small delay to avoid rate limiting
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      console.error(`  FAILED ${filename}: ${err.message}`);
      failed++;
    }
  }
}

console.log(`\nDone: ${generated} generated, ${failed} failed`);
