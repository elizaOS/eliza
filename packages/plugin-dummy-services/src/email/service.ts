import { IAgentRuntime } from '@elizaos/core';
import {
  IEmailService,
  EmailAddress,
  EmailAttachment,
  EmailMessage,
  EmailSendOptions,
  EmailSearchOptions,
  EmailFolder,
  EmailAccount,
} from '@elizaos/core';

/**
 * Dummy email service for testing purposes
 * Provides mock implementations of email operations
 */
export class DummyEmailService extends IEmailService {
  static override readonly serviceType = IEmailService.serviceType;

  private mockEmails: EmailMessage[] = [];
  private mockFolders: EmailFolder[] = [
    {
      name: 'Inbox',
      path: 'INBOX',
      type: 'inbox',
      messageCount: 15,
      unreadCount: 3,
    },
    {
      name: 'Sent',
      path: 'SENT',
      type: 'sent',
      messageCount: 8,
      unreadCount: 0,
    },
    {
      name: 'Drafts',
      path: 'DRAFTS',
      type: 'drafts',
      messageCount: 2,
      unreadCount: 0,
    },
    {
      name: 'Trash',
      path: 'TRASH',
      type: 'trash',
      messageCount: 5,
      unreadCount: 0,
    },
  ];

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.initializeMockEmails();
  }

  static async start(runtime: IAgentRuntime): Promise<DummyEmailService> {
    const service = new DummyEmailService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    this.runtime.logger.info('DummyEmailService initialized');
  }

  async stop(): Promise<void> {
    this.runtime.logger.info('DummyEmailService stopped');
  }

  private initializeMockEmails(): void {
    this.mockEmails = [
      {
        from: { email: 'alice@example.com', name: 'Alice Smith' },
        to: [{ email: 'user@example.com', name: 'User' }],
        subject: 'Project Update',
        text: "Hi! Just wanted to update you on the project progress. We've completed the first phase and are moving to the next milestone.",
        date: new Date('2024-01-15T10:30:00Z'),
        messageId: 'msg-001',
      },
      {
        from: { email: 'bob@company.com', name: 'Bob Johnson' },
        to: [{ email: 'user@example.com', name: 'User' }],
        cc: [{ email: 'team@company.com', name: 'Team' }],
        subject: 'Meeting Tomorrow',
        text: "Don't forget about our meeting tomorrow at 2 PM. We'll be discussing the quarterly results.",
        date: new Date('2024-01-14T14:15:00Z'),
        messageId: 'msg-002',
      },
      {
        from: { email: 'newsletter@tech.com', name: 'Tech Newsletter' },
        to: [{ email: 'user@example.com', name: 'User' }],
        subject: 'Weekly Tech Update',
        html: '<h1>This Week in Tech</h1><p>Latest technology news and updates.</p>',
        text: 'This Week in Tech\n\nLatest technology news and updates.',
        date: new Date('2024-01-13T09:00:00Z'),
        messageId: 'msg-003',
      },
    ];
  }

  async sendEmail(message: EmailMessage, options?: EmailSendOptions): Promise<string> {
    this.runtime.logger.debug(`Sending email to ${message.to.map((t) => t.email).join(', ')}`);
    this.runtime.logger.debug(`Subject: ${message.subject}`);

    if (options) {
      this.runtime.logger.debug('Send options:', options);
    }

    // Generate a mock message ID
    const messageId = `mock-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Add to mock emails
    this.mockEmails.push({
      ...message,
      messageId,
      date: new Date(),
    });

    // Simulate sending delay
    await new Promise((resolve) => setTimeout(resolve, 100));

    return messageId;
  }

  async getEmails(options?: EmailSearchOptions): Promise<EmailMessage[]> {
    this.runtime.logger.debug('Getting emails');

    if (options) {
      this.runtime.logger.debug('Search options:', options);
    }

    let filteredEmails = [...this.mockEmails];

    // Apply filters
    if (options?.from) {
      filteredEmails = filteredEmails.filter(
        (email) =>
          email.from.email.includes(options.from!) || email.from.name?.includes(options.from!)
      );
    }

    if (options?.subject) {
      filteredEmails = filteredEmails.filter((email) =>
        email.subject.toLowerCase().includes(options.subject!.toLowerCase())
      );
    }

    if (options?.since) {
      filteredEmails = filteredEmails.filter((email) => email.date && email.date >= options.since!);
    }

    if (options?.before) {
      filteredEmails = filteredEmails.filter(
        (email) => email.date && email.date <= options.before!
      );
    }

    // Apply pagination
    const offset = options?.offset || 0;
    const limit = options?.limit || 50;

    return filteredEmails.slice(offset, offset + limit);
  }

  async getEmail(messageId: string): Promise<EmailMessage> {
    this.runtime.logger.debug(`Getting email with ID: ${messageId}`);

    const email = this.mockEmails.find((e) => e.messageId === messageId);
    if (!email) {
      throw new Error(`Email with ID ${messageId} not found`);
    }

    return email;
  }

  async deleteEmail(messageId: string): Promise<void> {
    this.runtime.logger.debug(`Deleting email with ID: ${messageId}`);

    const index = this.mockEmails.findIndex((e) => e.messageId === messageId);
    if (index === -1) {
      throw new Error(`Email with ID ${messageId} not found`);
    }

    this.mockEmails.splice(index, 1);
  }

  async markEmailAsRead(messageId: string, read: boolean): Promise<void> {
    this.runtime.logger.debug(`Marking email ${messageId} as ${read ? 'read' : 'unread'}`);

    const email = this.mockEmails.find((e) => e.messageId === messageId);
    if (!email) {
      throw new Error(`Email with ID ${messageId} not found`);
    }

    // In a real implementation, this would update email flags
    // For mock purposes, we just log the action
  }

  async flagEmail(messageId: string, flagged: boolean): Promise<void> {
    this.runtime.logger.debug(`${flagged ? 'Flagging' : 'Unflagging'} email ${messageId}`);

    const email = this.mockEmails.find((e) => e.messageId === messageId);
    if (!email) {
      throw new Error(`Email with ID ${messageId} not found`);
    }

    // In a real implementation, this would update email flags
    // For mock purposes, we just log the action
  }

  async moveEmail(messageId: string, folderPath: string): Promise<void> {
    this.runtime.logger.debug(`Moving email ${messageId} to folder ${folderPath}`);

    const email = this.mockEmails.find((e) => e.messageId === messageId);
    if (!email) {
      throw new Error(`Email with ID ${messageId} not found`);
    }

    const folder = this.mockFolders.find((f) => f.path === folderPath);
    if (!folder) {
      throw new Error(`Folder ${folderPath} not found`);
    }

    // In a real implementation, this would move the email
    // For mock purposes, we just log the action
  }

  async getFolders(): Promise<EmailFolder[]> {
    this.runtime.logger.debug('Getting email folders');
    return [...this.mockFolders];
  }

  async createFolder(folderName: string, parentPath?: string): Promise<void> {
    this.runtime.logger.debug(
      `Creating folder ${folderName}${parentPath ? ` under ${parentPath}` : ''}`
    );

    const newFolder: EmailFolder = {
      name: folderName,
      path: parentPath ? `${parentPath}/${folderName}` : folderName,
      type: 'custom',
      messageCount: 0,
      unreadCount: 0,
    };

    this.mockFolders.push(newFolder);
  }

  async getAccountInfo(): Promise<EmailAccount> {
    this.runtime.logger.debug('Getting account info');

    return {
      email: 'user@example.com',
      name: 'Mock User',
      provider: 'MockProvider',
      folders: [...this.mockFolders],
      quotaUsed: 512000000, // 512 MB
      quotaLimit: 1073741824, // 1 GB
    };
  }

  async searchEmails(query: string, options?: EmailSearchOptions): Promise<EmailMessage[]> {
    this.runtime.logger.debug(`Searching emails with query: "${query}"`);

    if (options) {
      this.runtime.logger.debug('Search options:', options);
    }

    const filteredEmails = this.mockEmails.filter((email) => {
      const searchText = `${email.subject} ${email.text || ''} ${email.html || ''} ${email.from.name || ''} ${email.from.email}`;
      return searchText.toLowerCase().includes(query.toLowerCase());
    });

    // Apply additional filters from options
    let results = filteredEmails;

    if (options?.from) {
      results = results.filter(
        (email) =>
          email.from.email.includes(options.from!) || email.from.name?.includes(options.from!)
      );
    }

    if (options?.since) {
      results = results.filter((email) => email.date && email.date >= options.since!);
    }

    if (options?.before) {
      results = results.filter((email) => email.date && email.date <= options.before!);
    }

    // Apply pagination
    const offset = options?.offset || 0;
    const limit = options?.limit || 50;

    return results.slice(offset, offset + limit);
  }
}
