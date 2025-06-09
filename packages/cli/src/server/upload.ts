import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { validateUuid } from '@elizaos/core';

// --- Agent-Specific Upload Storage ---
export const agentStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const agentId = req.params?.agentId;
    if (!agentId) {
      return cb(new Error('Agent ID is required for agent file uploads'), '');
    }
    if (!validateUuid(agentId)) {
      return cb(new Error('Invalid agent ID format'), '');
    }
    const uploadDir = path.join(process.cwd(), 'data', 'uploads', 'agents', agentId);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}-${file.originalname.replace(/\s+/g, '_')}`);
  },
});

export const agentUpload = multer({ 
  storage: agentStorage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size
    files: 1 // Only allow 1 file per request
  },
  fileFilter: (req, file, cb) => {
    // Only allow specific file types for security
    const allowedMimeTypes = [
      'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/webm',
      'audio/mp4', 'audio/aac', 'audio/flac', 'audio/x-wav', 'audio/wave'
    ];
    
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Only audio files are allowed. Received: ${file.mimetype}`));
    }
  }
});

// --- Channel-Specific Upload Storage ---
export const channelStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const channelId = req.params?.channelId; // Expect channelId in route params
    if (!channelId) {
      return cb(new Error('Channel ID is required for channel file uploads'), '');
    }
    if (!validateUuid(channelId)) {
      return cb(new Error('Invalid channel ID format'), '');
    }
    // Save to data/uploads/channels/:channelId
    const uploadDir = path.join(process.cwd(), 'data', 'uploads', 'channels', channelId);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}-${file.originalname.replace(/\s+/g, '_')}`);
  },
});

export const channelUpload = multer({ 
  storage: channelStorage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size
    files: 1 // Only allow 1 file per request
  },
  fileFilter: (req, file, cb) => {
    // Only allow specific file types for security
    const allowedMimeTypes = [
      'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/webm',
      'audio/mp4', 'audio/aac', 'audio/flac', 'audio/x-wav', 'audio/wave',
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/pdf', 'text/plain'
    ];
    
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Received: ${file.mimetype}`));
    }
  }
});

// --- Generic Upload Storage (if ever needed, less specific) ---
export const genericStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const uploadDir = path.join(process.cwd(), 'data', 'uploads', 'generic');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}-${file.originalname.replace(/\s+/g, '_')}`);
  },
});

export const genericUpload = multer({ storage: genericStorage });

// Original generic upload (kept for compatibility if used elsewhere, but prefer specific ones)
export const upload = multer({ storage: genericStorage }); // Defaulting to generic if 'upload' is directly used
