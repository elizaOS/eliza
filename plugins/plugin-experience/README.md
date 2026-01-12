# @elizaos/plugin-experience

Experience learning plugin for ElizaOS.

This plugin records transferable learnings (experiences) and retrieves relevant past experiences to improve future decisions.

## Install

```bash
npm install @elizaos/plugin-experience
```

## Usage

```ts
import { experiencePlugin } from "@elizaos/plugin-experience";

export const character = {
  plugins: [experiencePlugin],
};
```

## Configuration

- `MAX_EXPERIENCES` (number, default: 10000)
- `AUTO_RECORD_THRESHOLD` (number, default: 0.7)

