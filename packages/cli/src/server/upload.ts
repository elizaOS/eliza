import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { validateUuid } from '@elizaos/core';

/**
 * Configuration for multer disk storage with agent-specific directories.
 *
 * @type {multer.diskStorage}
 * @property {Function} destination - Callback function to determine the destination directory for file uploads
 * @property {Function} filename - Callback function to generate a unique filename for uploaded files
 */
export const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    // Extract agentId from request params
    const agentId = req.params?.agentId;

    if (!agentId) {
      return cb(new Error('Agent ID is required for file uploads'), '');
    }

    // Validate agent ID format (UUID)
    if (!validateUuid(agentId)) {
      return cb(new Error('Invalid agent ID format'), '');
    }

    // Create agent-specific upload directory
    const uploadDir = path.join(process.cwd(), 'data', 'uploads', agentId);

    // Create the directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  },
});

// Configure multer with the storage
export const upload = multer({ storage });
