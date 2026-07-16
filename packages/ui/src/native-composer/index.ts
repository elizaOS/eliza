/**
 * `eliza.native-composer/v1` — the one typed composer-bridge contract shared by
 * the iOS, Android, desktop, and web shells. Types + schema (`contract`), boundary
 * decoder (`decode`), attachment normalization into the existing media store
 * (`attachments`), the pure state machine (`reduce`), and the renderer-side
 * client that wires them together (`client`).
 */

export {
  type AttachmentAddOperation,
  type AttachmentRemoveOperation,
  type CancelOperation,
  COMPOSER_EVENT_TYPES,
  COMPOSER_OPERATION_TYPES,
  type ComposerAttachment,
  type ComposerAttachmentSource,
  type ComposerCancelScope,
  type ComposerDraft,
  type ComposerEvent,
  type ComposerEventType,
  type ComposerMention,
  type ComposerOperation,
  type ComposerOperationStream,
  type ComposerOperationType,
  type ComposerRejectReason,
  type ComposerReplyContext,
  type DispatchResult,
  type DraftChangedEvent,
  emptyComposerDraft,
  type FocusChangedEvent,
  type FocusSetOperation,
  type KeyboardVisibility,
  type MentionAddOperation,
  NATIVE_COMPOSER_SCHEMA,
  type NativeComposerSchema,
  type ReplyClearOperation,
  type ReplySetOperation,
  type SendOperation,
  type SendOutcome,
  type SendResultEvent,
  type TextInsertOperation,
  type TextSetOperation,
  type VoiceHandoffOperation,
  type VoiceHandoffPhase,
  type VoiceHandoffStateEvent,
} from "./contract";
export {
  type ComposerAttachmentDecodeResult,
  type ComposerDecodeError,
  type ComposerDecodeErrorCode,
  type ComposerOperationDecodeResult,
  type ComposerStreamDecodeResult,
  decodeComposerAttachmentSource,
  decodeComposerOperation,
  decodeComposerOperationStream,
} from "./decode";
export {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  type NormalizeAttachmentOptions,
  type NormalizeAttachmentResult,
  normalizeComposerAttachment,
} from "./attachments";
export {
  applyComposerOperation,
  type ComposerApplyContext,
  type ComposerBridgeState,
  type ComposerCapabilities,
  type ComposerLimits,
  DEFAULT_COMPOSER_CAPABILITIES,
  DEFAULT_COMPOSER_LIMITS,
  defaultApplyContext,
  flushDeferredOperations,
  initialComposerState,
  resolveSend,
} from "./reduce";
export {
  type ComposerBridgeClient,
  type ComposerBridgeClientOptions,
  type ComposerBridgeSnapshot,
  createComposerBridgeClient,
} from "./client";
