// Re-export upload configurations from the main upload module
// This allows us to import upload configs from the shared directory
export {
  agentAudioUpload,
  agentMediaUpload,
  channelUpload,
  validateAudioFile,
  validateMediaFile,
  processUploadedFile,
  generateSecureFilename,
  ensureUploadDir,
} from '../../../upload';
