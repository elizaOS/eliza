# @elizaos/plugin-3d-generation

## Purpose

A plugin for generating 3D models using the FAL.ai API within the ElizaOS ecosystem.

## Key Features

- AI-powered creation of 3D models from text descriptions
- Ability to save models locally
- Multiple file format support (glb, usdz, fbx, obj, stl)
- Different quality and material settings

## Installation

```bash
bun install @elizaos/plugin-3d-generation
```

## Configuration

Requires the following environment variable:

```typescript
FAL_API_KEY=<Your FAL.ai API key>
```

## Integration

The plugin responds to natural language commands like "Generate a 3D object of a cat playing piano" and offers multiple action aliases (GENERATE_3D, 3D_GENERATION, TEXT_TO_3D, etc.).

## Example Usage

```typescript
import { ThreeDGenerationPlugin } from '@elizaos/plugin-3d-generation';

// Example commands:
('Generate a 3D object of a cat playing piano');
('Create a 3D object of an anime character Goku');
('Make a 3D model of [your description]');
```

## Links

- [FAL.ai Documentation](https://fal.ai/docs)
- [Three.js Documentation](https://threejs.org/docs/)
- [glTF Specification](https://github.com/KhronosGroup/glTF)
- [USD Documentation](https://graphics.pixar.com/usd/docs/index.html)
