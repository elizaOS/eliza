import { Service, ServiceType } from './service';

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface EmailAttachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
  contentDisposition?: 'attachment' | 'inline';
  cid?: string;
}

export interface EmailMessage {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: EmailAttachment[];
  replyTo?: EmailAddress;
  date?: Date;
  messageId?: string;
  references?: string[];
  inReplyTo?: string;
  priority?: 'high' | 'normal' | 'low';
}

export interface EmailSendOptions {
  retry?: number;
  timeout?: number;
  trackOpens?: boolean;
  trackClicks?: boolean;
  tags?: string[];
}

export interface EmailSearchOptions {
  query?: string;
  from?: string;
  to?: string;
  subject?: string;
  folder?: string;
  since?: Date;
  before?: Date;
  limit?: number;
  offset?: number;
  unread?: boolean;
  flagged?: boolean;
  hasAttachments?: boolean;
}

export interface EmailFolder {
  name: string;
  path: string;
  type: 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'custom';
  messageCount?: number;
  unreadCount?: number;
  children?: EmailFolder[];
}

export interface EmailAccount {
  email: string;
  name?: string;
  provider?: string;
  folders?: EmailFolder[];
  quotaUsed?: number;
  quotaLimit?: number;
}

/**
 * Interface for email services
 */
export abstract class IEmailService extends Service {
  static override readonly serviceType = ServiceType.EMAIL;

  public readonly capabilityDescription = 'Email sending, receiving, and management capabilities';

  /**
   * Send an email
   * @param message - Email message to send
   * @param options - Send options
   * @returns Promise resolving to message ID
   */
  abstract sendEmail(message: EmailMessage, options?: EmailSendOptions): Promise<string>;

  /**
   * Get emails from a folder
   * @param options - Search options
   * @returns Promise resolving to array of emails
   */
  abstract getEmails(options?: EmailSearchOptions): Promise<EmailMessage[]>;

  /**
   * Get a specific email by ID
   * @param messageId - Message ID
   * @returns Promise resolving to email message
   */
  abstract getEmail(messageId: string): Promise<EmailMessage>;

  /**
   * Delete an email
   * @param messageId - Message ID
   * @returns Promise resolving when deletion completes
   */
  abstract deleteEmail(messageId: string): Promise<void>;

  /**
   * Mark an email as read/unread
   * @param messageId - Message ID
   * @param read - True to mark as read, false for unread
   * @returns Promise resolving when operation completes
   */
  abstract markEmailAsRead(messageId: string, read: boolean): Promise<void>;

  /**
   * Flag/unflag an email
   * @param messageId - Message ID
   * @param flagged - True to flag, false to unflag
   * @returns Promise resolving when operation completes
   */
  abstract flagEmail(messageId: string, flagged: boolean): Promise<void>;

  /**
   * Move email to a different folder
   * @param messageId - Message ID
   * @param folderPath - Destination folder path
   * @returns Promise resolving when move completes
   */
  abstract moveEmail(messageId: string, folderPath: string): Promise<void>;

  /**
   * Get available folders
   * @returns Promise resolving to array of folders
   */
  abstract getFolders(): Promise<EmailFolder[]>;

  /**
   * Create a new folder
   * @param folderName - Name of the folder
   * @param parentPath - Optional parent folder path
   * @returns Promise resolving when folder is created
   */
  abstract createFolder(folderName: string, parentPath?: string): Promise<void>;

  /**
   * Get account information
   * @returns Promise resolving to account details
   */
  abstract getAccountInfo(): Promise<EmailAccount>;

  /**
   * Search emails
   * @param query - Search query
   * @param options - Search options
   * @returns Promise resolving to search results
   */
  abstract searchEmails(query: string, options?: EmailSearchOptions): Promise<EmailMessage[]>;
}
