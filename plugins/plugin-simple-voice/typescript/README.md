# Eliza Plugin Simple Voice (TypeScript)

TypeScript implementation of the SAM Text-to-Speech plugin.

## Installation

```bash
bun install
bun run build
```

## Usage

```typescript
import { simpleVoicePlugin, SamTTSService } from "@elizaos/plugin-simple-voice";

const service = new SamTTSService(runtime);
const audio = service.generateAudio("Hello", {
  speed: 72,
  pitch: 64,
  throat: 128,
  mouth: 128,
});
const wav = service.createWAVBuffer(audio);
```

## Testing

```bash
npx vitest
```
