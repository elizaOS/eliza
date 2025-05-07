# Plugin Image Generation

## Purpose

A plugin designed for generating and managing images, providing features like image manipulation, storage integration, and optimized handling for various use cases.

## Key Features

- Dynamic image generation
- Integration with storage solutions
- Optimized handling for high-resolution images

## Installation

```bash
bun install plugin-image-generation
```

## Configuration

### Environment Variables

- `IMAGE_STORAGE_BUCKET`: Name of the storage bucket
- `STORAGE_ACCESS_KEY`: Access key for storage integration
- `STORAGE_SECRET_KEY`: Secret key for storage integration

### TypeScript Configuration

Requires TypeScript environment with specific compiler options in tsconfig.json

## Example Usage

### Generate an Image

```typescript
import { generateImage } from 'plugin-image-generation';

const image = await generateImage({
  width: 800,
  height: 600,
  backgroundColor: '#ffffff',
  text: 'Hello World',
  font: 'Arial',
});

console.log('Generated Image:', image);
```

### Upload to Storage

```typescript
import { uploadImage } from 'plugin-image-generation';

const uploadResult = await uploadImage({
  imagePath: 'path/to/image.png',
  bucketName: 'my-storage-bucket',
});

console.log('Image uploaded successfully:', uploadResult);
```
