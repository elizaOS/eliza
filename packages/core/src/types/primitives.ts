/**
 * Defines a custom type UUID representing a universally unique identifier
 */
export type UUID = `${string}-${string}-${string}-${string}-${string}`;

/**
 * Helper function to safely cast a string to strongly typed UUID
 * @param id The string UUID to validate and cast
 * @returns The same UUID with branded type information
 */
export function asUUID(id: string): UUID {
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`Invalid UUID format: ${id}`);
  }
  return id as UUID;
}

/**
 * Represents the content of a memory, message, or other information
 */
export interface Content {
  /** The agent's internal thought process */
  thought?: string;

  /** The main text content visible to users */
  text?: string;

  /** Optional actions to be performed */
  actions?: string[];

  /** Optional providers to use for context generation */
  providers?: string[];

  /** Optional source/origin of the content */
  source?: string;

  /** Optional target/destination for responses */
  target?: string;

  /** URL of the original message/post (e.g. tweet URL, Discord message link) */
  url?: string;

  /** UUID of parent message if this is a reply/thread */
  inReplyTo?: UUID;

  /** Array of media attachments */
  attachments?: Media[];

  /** room type */
  channelType?: string;

  /**
   * Additional dynamic properties
   * Use specific properties above instead of this when possible
   */
  [key: string]: unknown;
}

/**
 * Represents a media attachment
 */
export type Media = {
  /** Unique identifier */
  id: string;

  /** Media URL */
  url: string;

  /** Media title */
  title?: string;

  /** Media source */
  source?: string;

  /** Media description */
  description?: string;

  /** Text content */
  text?: string;

  /** Content type */
  contentType?: ContentType;
};

export enum ContentType {
  IMAGE = 'image',
  VIDEO = 'video',
  AUDIO = 'audio',
  DOCUMENT = 'document',
  LINK = 'link',
}

/**
 * A generic type for metadata objects, allowing for arbitrary key-value pairs.
 * This encourages consumers to perform type checking or casting.
 */
export type Metadata = Record<string, unknown>;
