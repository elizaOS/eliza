import { IAgentRuntime, Service, ServiceType, logger } from '@elizaos/core';

// Define email-specific types locally since they're not in core
export interface EmailAddress {
  name?: string;
  address: string;
}

export interface EmailAttachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

export interface EmailMessage {
  id: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  body: string;
  html?: string;
  attachments?: EmailAttachment[];
  date: Date;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
}

export interface EmailSendOptions {
  priority?: 'high' | 'normal' | 'low';
  readReceipt?: boolean;
  deliveryReceipt?: boolean;
}

export interface EmailSearchOptions {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  since?: Date;
  before?: Date;
  hasAttachments?: boolean;
  folder?: string;
  limit?: number;
}

export interface EmailFolder {
  name: string;
  path: string;
  messageCount: number;
  unreadCount: number;
}

export interface EmailAccount {
  address: string;
  name?: string;
  provider: string;
}

/**
 * Dummy email service for testing purposes
 * Provides mock implementations of email operations
 */
export class DummyEmailService extends Service {
  static readonly serviceType = ServiceType.EMAIL;

  capabilityDescription = 'Dummy email service for testing';

  private emails: EmailMessage[] = [];
  private folders: EmailFolder[] = [
    { name: 'Inbox', path: 'INBOX', messageCount: 0, unreadCount: 0 },
    { name: 'Sent', path: 'SENT', messageCount: 0, unreadCount: 0 },
  ];

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<DummyEmailService> {
    const service = new DummyEmailService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    logger.info('DummyEmailService initialized');
  }

  async stop(): Promise<void> {
    logger.info('DummyEmailService stopped');
  }

  async sendEmail(
    to: EmailAddress[],
    subject: string,
    body: string,
    options?: {
      cc?: EmailAddress[];
      bcc?: EmailAddress[];
      html?: string;
      attachments?: EmailAttachment[];
      sendOptions?: EmailSendOptions;
    }
  ): Promise<string> {
    logger.debug('Sending email', JSON.stringify({ to, subject }));
    logger.debug('Email options:', JSON.stringify(options));

    const messageId = `dummy-${Date.now()}@example.com`;

    logger.info(`Email sent successfully. Message ID: ${messageId}`);

    // Create and store the sent email
    const sentEmail: EmailMessage = {
      id: messageId,
      from: { address: 'dummy@example.com', name: 'Dummy Sender' },
      to,
      cc: options?.cc,
      bcc: options?.bcc,
      subject,
      body,
      html: options?.html,
      attachments: options?.attachments,
      date: new Date(),
      messageId,
    };

    this.emails.push(sentEmail);
    return messageId;
  }

  async searchEmails(options?: EmailSearchOptions): Promise<EmailMessage[]> {
    logger.debug('Searching emails', JSON.stringify(options));

    // Return filtered dummy emails based on search options
    let results = this.emails;

    if (options) {
      if (options.from) {
        results = results.filter((e) => e.from.address.includes(options.from!));
      }
      if (options.subject) {
        results = results.filter((e) =>
          e.subject.toLowerCase().includes(options.subject!.toLowerCase())
        );
      }
      if (options.limit) {
        results = results.slice(0, options.limit);
      }
    }

    logger.debug(`Found ${results.length} emails`);

    return results;
  }

  async getEmail(messageId: string): Promise<EmailMessage | null> {
    logger.debug(`Getting email: ${messageId}`);

    const email = this.emails.find((e) => e.id === messageId);
    return email || null;
  }

  async deleteEmail(messageId: string): Promise<boolean> {
    logger.debug(`Deleting email: ${messageId}`);

    const index = this.emails.findIndex((e) => e.id === messageId);
    if (index !== -1) {
      this.emails.splice(index, 1);
      return true;
    }
    return false;
  }

  async markAsRead(messageId: string): Promise<boolean> {
    logger.debug(`Marking email as read: ${messageId}`);
    // Dummy implementation always returns true
    return true;
  }

  async markAsUnread(messageId: string): Promise<boolean> {
    logger.debug(`Marking email as unread: ${messageId}`);
    // Dummy implementation always returns true
    return true;
  }

  async moveToFolder(messageId: string, folderPath: string): Promise<boolean> {
    logger.debug(`Moving email ${messageId} to folder: ${folderPath}`);
    // Dummy implementation always returns true
    return true;
  }

  async getFolders(): Promise<EmailFolder[]> {
    logger.debug('Getting email folders');
    return this.folders;
  }

  async createFolder(name: string, parentPath?: string): Promise<EmailFolder> {
    logger.debug(`Creating folder: ${name}`, JSON.stringify({ parentPath }));

    const path = parentPath ? `${parentPath}/${name}` : name;
    const folder: EmailFolder = {
      name,
      path,
      messageCount: 0,
      unreadCount: 0,
    };

    this.folders.push(folder);
    return folder;
  }

  async deleteFolder(folderPath: string): Promise<boolean> {
    logger.debug(`Deleting folder: ${folderPath}`);

    const index = this.folders.findIndex((f) => f.path === folderPath);
    if (index !== -1) {
      this.folders.splice(index, 1);
      return true;
    }
    return false;
  }

  async replyToEmail(
    messageId: string,
    body: string,
    options?: {
      html?: string;
      attachments?: EmailAttachment[];
      replyAll?: boolean;
    }
  ): Promise<string> {
    logger.debug(`Replying to email: ${messageId}`, JSON.stringify(options));

    const replyMessageId = `dummy-reply-${Date.now()}@example.com`;

    logger.info(`Reply sent successfully. Message ID: ${replyMessageId}`);

    return replyMessageId;
  }

  async forwardEmail(
    messageId: string,
    to: EmailAddress[],
    options?: {
      body?: string;
      html?: string;
      attachments?: EmailAttachment[];
    }
  ): Promise<string> {
    logger.debug(`Forwarding email: ${messageId}`, JSON.stringify({ to, options }));

    const forwardMessageId = `dummy-forward-${Date.now()}@example.com`;

    logger.info(`Email forwarded successfully. Message ID: ${forwardMessageId}`);

    return forwardMessageId;
  }

  getDexName(): string {
    return 'dummy-email';
  }
}
