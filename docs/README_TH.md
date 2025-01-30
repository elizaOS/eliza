# Eliza - เฟรมเวิร์กจำลองเอเจนต์หลายตัวเเทน

# https://github.com/elizaos/eliza

# เข้าไปดู https://eliza.builders สำหรับขอความช่วยเหลือประการใด

# dev branch

<img src="./docs/static/img/eliza_banner.jpg" alt="Eliza Banner" width="100%" />

_ดังที่เห็นขับเคลื่อนเเละถูกใช้บน [@DegenSpartanAI](https://x.com/degenspartanai) and [@MarcAIndreessen](https://x.com/pmairca)_

- เฟรมเวิร์กจำลองเอเจนต์หลายตัวแทน
- เพิ่มตัวละครที่มีเอกลักษณ์ได้มากเท่าที่ต้องการด้วยไฟล์ตัวละคร - [characterfile](https://github.com/lalalune/characterfile/)
- ตัวเชื่อมต่อ Discord และ Twitter แบบครบถ้วน พร้อมการสนับสนุนผ่านช่อง Discord
- สนับสนุนการจำลองการสนทนาทั้งหมดและหน่วยความจำ RAG
- สามารถอ่านลิงค์และไฟล์ PDF, เเปลเสียงและวิดีโอ, สรุปการสนทนา, และอื่นๆ
- ขยายความสามารถของ Eliza ได้สูง - สร้างการกระทำและไคลเอนต์ของคุณเองเพื่อขยายความสามารถของ Eliza
- รองรับโมเดลทั้งเเบบ Open-source และเเบบ Local (กำหนดค่าเริ่มต้นด้วย Nous Hermes Llama 3.1B)
- รองรับ OpenAI สำหรับการอนุมานในคลาวด์บนอุปกรณ์ที่มีน้ำหนักเบา
- โหมด "Ask Claude" สำหรับการเรียก Claude ในคำถามที่ซับซ้อนมากขึ้น
- 100% เขียนโดย TypeScript

# เริ่มต้นใช้งาน

**ข้อกำหนดเบื้องต้น (ต้องมี):**

- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [pnpm](https://pnpm.io/installation)

### แก้ไขไฟล์ .env

- คัดลอก .env.example เป็น .env และกรอกค่าที่เหมาะสม
- แก้ไขตัวแปรสภาพแวดล้อม TWITTER เพื่อเพิ่มชื่อผู้ใช้และรหัสผ่านของบอท

### แก้ไขไฟล์ตัวละคร

- ลองเข้าไปตรวจสอบไฟล์ `packages/core/src/defaultCharacter.ts` - คุณสามารถแก้ไขได้
- คุณยังสามารถโหลดตัวละครด้วย `pnpm start --characters="path/to/your/character.json"` และเรียกใช้บอทหลายตัวพร้อมกันได้

หลังจากตั้งค่าไฟล์ .env และไฟล์ตัวละครแล้ว คุณสามารถเริ่มบอทด้วยคำสั่งต่อไปนี้:

```
pnpm i
pnpm start
```

# การปรับแต่ง Eliza

### การเพิ่มการกระทำของตัวละครเอเจนท์แบบกำหนดเอง

เพื่อหลีกเลี่ยงความขัดแย้งของ git ในไดเรกทอรีหลัก เราแนะนำให้เพิ่มการกระทำแบบกำหนดเองในโฟลเดอร์ `custom_actions` แล้วเพิ่มลงในไฟล์ `elizaConfig.yaml` ดูตัวอย่างในไฟลได้ที่ `elizaConfig.example.yaml`

## การเรียกใช้กับโมเดลต่างๆ

### การเรียกใช้กับโมเดล Llama

คุณสามารถเรียกใช้โมเดล Llama 70B หรือ 405B ได้โดยตั้งค่าตัวแปรสภาพแวดล้อม `XAI_MODEL` เป็น `meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo` หรือ `meta-llama/Meta-Llama-3.1-405B-Instruct`

### การเรียกใช้กับโมเดล Grok

คุณสามารถเรียกใช้โมเดล Grok ได้โดยตั้งค่าตัวแปรสภาพแวดล้อม `XAI_MODEL` เป็น `grok-beta`

### การเรียกใช้กับโมเดล OpenAI

คุณสามารถเรียกใช้โมเดล OpenAI ได้โดยตั้งค่าตัวแปรสภาพแวดล้อม `XAI_MODEL` เป็น `gpt-4o-mini` หรือ `gpt-4o`

## ข้อกำหนดเพิ่มเติม

คุณอาจต้องติดตั้ง Sharp หากพบข้อผิดพลาดเมื่อเริ่มต้น ให้ลองติดตั้งด้วยคำสั่งต่อไปนี้:

```
pnpm install --include=optional sharp
```

# การตั้งค่าสภาพแวดล้อม

คุณจะต้องเพิ่มตัวแปรสภาพแวดล้อมลงในไฟล์ .env เพื่อเชื่อมต่อกับแพลตฟอร์มต่างๆ:

```
# ตัวแปรที่จำเป็น
DISCORD_APPLICATION_ID=
DISCORD_API_TOKEN= # โทเค็นของบอท
OPENAI_API_KEY=sk-* # API key ของ OpenAI เริ่มต้นด้วย sk-
ELEVENLABS_XI_API_KEY= # API key จาก elevenlabs

# การตั้งค่า ELEVENLABS
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
ELEVENLABS_VOICE_STABILITY=0.5
ELEVENLABS_VOICE_SIMILARITY_BOOST=0.9
ELEVENLABS_VOICE_STYLE=0.66
ELEVENLABS_VOICE_USE_SPEAKER_BOOST=false
ELEVENLABS_OPTIMIZE_STREAMING_LATENCY=4
ELEVENLABS_OUTPUT_FORMAT=pcm_16000

TWITTER_DRY_RUN=false
TWITTER_USERNAME= # ชื่อผู้ใช้บัญชี
TWITTER_PASSWORD= # รหัสผ่าน
TWITTER_EMAIL= # อีเมล

X_SERVER_URL=
XAI_API_KEY=
XAI_MODEL=


# สำหรับการสอบถาม Claude
ANTHROPIC_API_KEY=

WALLET_SECRET_KEY=EXAMPLE_WALLET_SECRET_KEY
WALLET_PUBLIC_KEY=EXAMPLE_WALLET_PUBLIC_KEY

BIRDEYE_API_KEY=

SOL_ADDRESS=So11111111111111111111111111111111111111112
SLIPPAGE=1
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
HELIUS_API_KEY=


## Telegram
TELEGRAM_BOT_TOKEN=

TOGETHER_API_KEY=
```

# การตั้งค่าการประมวลผลในเครื่อง

### การตั้งค่า CUDA

หากคุณมี NVIDIA GPU คุณสามารถติดตั้ง CUDA เพื่อเพิ่มความเร็วการประมวลผลในเครื่องได้อย่างมาก:

```
pnpm install
npx --no node-llama-cpp source download --gpu cuda
```

ตรวจสอบให้แน่ใจว่าคุณได้ติดตั้ง CUDA Toolkit รวมถึง cuDNN และ cuBLAS

### การเรียกใช้งานในเครื่อง

เพิ่ม XAI_MODEL และตั้งค่าเป็นตัวเลือกหนึ่งจาก [Run with
Llama](#run-with-llama) - คุณสามารถปล่อย X_SERVER_URL และ XAI_API_KEY ให้เป็นค่าว่าง มันจะดาวน์โหลดโมเดลจาก
Hugging Face และส่งคิวรี่ในเครื่อง

# ไคลเอนต์

## บอท Discord

สำหรับความช่วยเหลือในการตั้งค่าบอท Discord ของคุณ ดูได้ที่นี่: https://discordjs.guide/preparations/setting-up-a-bot-application.html

# การพัฒนา

## การทดสอบ

เพื่อรันชุดทดสอบ:

```bash
pnpm test           # รันการทดสอบหนึ่งครั้ง
pnpm test:watch    # รันการทดสอบในโหมดติดตาม
```

สำหรับการทดสอบฐานข้อมูลเฉพาะ:

```bash
pnpm test:sqlite   # รันการทดสอบด้วย SQLite
pnpm test:sqljs    # รันการทดสอบด้วย SQL.js
```

การทดสอบถูกเขียนโดยใช้ Jest และสามารถพบได้ในไฟล์ `src/**/*.test.ts` การกำหนดค่าสภาพแวดล้อมถูกตั้งค่าเพื่อ:

- โหลดตัวแปรสภาพแวดล้อมจาก `.env.test`
- ใช้เวลาไทม์เอาต์ 2 นาทีสำหรับการทดสอบที่ใช้เวลานาน
- รองรับโมดูล ESM
- รันการทดสอบตามลำดับ (--runInBand)

เพื่อสร้างการทดสอบใหม่ ให้เพิ่มไฟล์ `.test.ts` ใกล้กับโค้ดที่คุณกำลังทดสอบ
