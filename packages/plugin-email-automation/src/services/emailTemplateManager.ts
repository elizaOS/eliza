import { EmailTemplate, EmailBlock, GeneratedEmailContent } from '../types';
import Handlebars from 'handlebars';
import { emailFormatTemplate } from '../templates/emailFormat';

export class EmailTemplateManager {
    private templates: Map<string, EmailTemplate> = new Map();

    constructor() {
        this.registerDefaultTemplates();
        this.registerHelpers();
        // Register Handlebars helpers if needed
        Handlebars.registerHelper('formatBlock', (block) => {
            return new Handlebars.SafeString(this.formatBlock(block));
        });
    }

    private registerDefaultTemplates() {
        this.templates.set('default', {
            id: 'default',
            name: 'Default Template',
            html: this.getDefaultTemplate(),
            variables: ['subject', 'blocks', 'signature'],
            defaultStyle: {
                container: this.getDefaultStyles(),
                notification: ''
            }
        });

        this.templates.set('notification', {
            id: 'notification',
            name: 'Notification Template',
            html: this.getNotificationTemplate(),
            variables: ['subject', 'blocks', 'signature', 'priority'],
            defaultStyle: {
                container: this.getDefaultStyles(),
                notification: this.getNotificationStyles()
            }
        });

        // Register email format template
        this.templates.set('format', {
            id: 'format',
            name: 'Email Format Template',
            html: this.getEmailFormatTemplate(),
            variables: ['memory', 'previousMessages'],
            defaultStyle: {
                container: this.getDefaultStyles(),
                notification: ''
            }
        });
    }

    private registerHelpers() {
        // Add the eq helper
        Handlebars.registerHelper('eq', function(arg1: any, arg2: any) {
            return arg1 === arg2;
        });

        // Existing helpers
        Handlebars.registerHelper('formatBlock', (block: EmailBlock) => {
            switch (block.type) {
                case 'paragraph':
                    return new Handlebars.SafeString(
                        `<p class="email-paragraph ${block.metadata?.className || ''}"
                            style="${block.metadata?.style || ''}">${block.content}</p>`
                    );
                case 'bulletList':
                    return new Handlebars.SafeString(
                        `<ul class="email-list ${block.metadata?.className || ''}"
                            style="${block.metadata?.style || ''}">
                            ${Array.isArray(block.content)
                                ? block.content.map(item =>
                                    `<li class="email-list-item">${item}</li>`).join('')
                                : `<li class="email-list-item">${block.content}</li>`}
                        </ul>`
                    );
                case 'heading':
                    return new Handlebars.SafeString(
                        `<h2 class="email-heading ${block.metadata?.className || ''}"
                            style="${block.metadata?.style || ''}">${block.content}</h2>`
                    );
                case 'signature':
                    return new Handlebars.SafeString(
                        `<div class="email-signature">${block.content}</div>`
                    );
                case 'callout':
                    return new Handlebars.SafeString(
                        `<div class="email-callout ${block.metadata?.className || ''}"
                            style="${block.metadata?.style || ''}">${block.content}</div>`
                    );
                default:
                    return block.content;
            }
        });

        // Existing priority badge helper
        Handlebars.registerHelper('priorityBadge', (priority: string) => {
            const colors = {
                high: '#dc3545',
                medium: '#ffc107',
                low: '#28a745'
            };
            return new Handlebars.SafeString(
                `<div class="priority-badge"
                    style="background-color: ${colors[priority as keyof typeof colors]}">
                    ${priority.toUpperCase()}
                </div>`
            );
        });

        // Add currentYear helper
        Handlebars.registerHelper('currentYear', function() {
            return new Date().getFullYear();
        });
    }

    getTemplate(templateId: string): EmailTemplate {
        const template = this.templates.get(templateId);
        if (!template) {
            return this.templates.get('default')!;
        }
        return template;
    }

    registerTemplate(template: EmailTemplate): void {
        this.validateTemplate(template);
        this.templates.set(template.id, template);
    }

    private getDefaultTemplate(): string {
        return `
            <!DOCTYPE html>
            <html>
                <head>
                    <meta charset="utf-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>{{subject}}</title>
                    <style>
                        {{{defaultStyle}}}
                    </style>
                </head>
                <body>
                    <div class="email-container">
                        <div class="banner" style="
                            background-color: #f8f9fa;
                            padding: 12px;
                            text-align: center;
                            border-bottom: 1px solid #e9ecef;
                        ">
                            <div style="
                                display: inline-flex;
                                align-items: center;
                                gap: 8px;
                                color: #6c757d;
                                font-size: 13px;
                            ">
                                <img
                                    src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAA7AAAAOwBeShxvQAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAMGSURBVFiF7ZdNiFZVGMd/z7lvM42WYR8GZkIxFhFR0SaIIYKoFrWQClpUq4jIjRAtWkWLNkEtoke3LiIiEmoVFBW0KKgQIgxCsKgPqEbMJnScyY9m3vt/WtxzZ+68H3PvO4vEH1zOc59zzvM/z3Oe8zznXuv1eqaqqmeBy4ClwGXApcB8YB4wC+gBCmAM+Bv4DTgGHAEOA4eAn4HjwIRz7lSz2SyMMTNZa7uAjcBDwB3A7LbhE8BPwEHgG2Af8BVwyvf9KedcL4Ax5gygH7gXWA/cBMw5g4EW8D3wMfAR8I1zbqIoCq8sy24gAh4G1gGzz9LwdOSBz4G3gY+dc+PGmPnAvcDjwMozjP0H+ALYB+wGDgHHgFNAE6iBi4ErgGuAQWAlsKhj/jjwLvC6c+5PY0wPMAQ8CawBvG7GgO+AncBOY8xeYMJaW5dlmTfGzAZuBe4H7gYub5s7CmwD3nLOjRpj5gKPAE8By9rm/QXsALYbY/YAjTzPTdd13XVd13med4Ux5lHgAWBh29yvgNeAHc65MQBjzELgceBp4MK2ed8C24wxO40xR+u6bvi+71dVVRRFUQRBEBhjFhtjHgQeBZYBPnAS2A1sNcZ86ZzLjTEXAE8AzwAXt637KLAd2GaM+b0oCr+u6zzP86ooikZZlkEQBHPSNN0ErAUuAQLgb+BzYKsx5rM0TcuttQ8BzwOL29b7AdgKvJ+m6bEkSYKqqvI8z6uyLJtlWQZ1XTfSNL0OeBFYDVyQJv8L/Ai8A7yXJMnBOI5XAy8AK9rW+RN4B3grSZL9URTNqaoqz/O8KsuylabpnLquG1VVNcqybBRFERRF4fu+PwDcDNwOrAKWkO6AY8CPwF5gD/CVtfZEkiRrgOeBwbb1jwPvA28mSfJ1FEWzgQZAXddlURRBXdeNoigC3/d9z/M8Y0xXmqaLgaVpmi5N03RxmqYL0jSdl6bprDRNZ6ZpGqRp6qdp6qVpijFm0hhzMk3TkTRNj6Vp+keapofTND2QpumPxpijxpimMcY45wqALMv+A2qXz6gxuUEjAAAAAElFTkSuQmCC"
                                    alt="ElizaOS"
                                    style="width: 14px; height: 14px;"
                                >
                                Powered by ElizaOS
                            </div>
                        </div>
                        <div class="content">
                            <h1>{{subject}}</h1>
                            {{#each blocks}}
                                {{{formatBlock this}}}
                            {{/each}}
                        </div>
                    </div>
                </body>
            </html>
        `.trim();
    }

    private getNotificationTemplate(): string {
        return `
            <!DOCTYPE html>
            <html>
                <head>
                    <meta charset="utf-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <style>{{{defaultStyle}}}</style>
                </head>
                <body>
                    <div class="email-container notification">
                        <div class="notification-header">
                            <h1 class="email-subject">{{subject}}</h1>
                            {{#if metadata.showPriority}}
                                {{#if metadata.priority}}
                                    {{priorityBadge metadata.priority}}
                                {{/if}}
                            {{/if}}
                        </div>
                        {{#each blocks}}
                            {{formatBlock this}}
                        {{/each}}
                        {{#if signature}}
                            <div class="email-signature">{{{signature}}}</div>
                        {{/if}}
                        <div class="footer">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="#6c757d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                <path d="M2 17L12 22L22 17" stroke="#6c757d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                <path d="M2 12L12 17L22 12" stroke="#6c757d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            Powered by ElizaOS
                        </div>
                    </div>
                </body>
            </html>
        `;
    }

    public getDefaultStyles(): string {
        return `
            /* Reset styles */
            body, html {
                margin: 0;
                padding: 0;
                width: 100%;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                line-height: 1.6;
                color: #333333;
                background-color: #f6f9fc;
            }

            /* Container */
            .email-container {
                max-width: 600px;
                margin: 20px auto;
                background-color: #ffffff;
                border-radius: 8px;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
                overflow: hidden;
            }

            /* Header */
            .header {
                text-align: center;
                padding: 24px;
                background-color: #f8f9fa;
            }

            .logo {
                height: 12px;
                width: 12px;
                margin: 12px;
                object-fit: contain;
            }

            /* Content */
            .content {
                padding: 32px 24px;
                background-color: #ffffff;
            }

            /* Typography */
            h1 {
                color: #2c3e50;
                font-size: 24px;
                font-weight: 600;
                margin: 0 0 24px;
                padding-bottom: 16px;
                border-bottom: 1px solid #eaeaea;
            }

            .email-paragraph {
                margin: 0 0 20px;
                color: #2c3e50;
            }

            .email-list {
                margin: 20px 0;
                padding-left: 20px;
            }

            .email-list-item {
                margin: 8px 0;
            }

            .signature {
                margin-top: 30px;
                padding-top: 20px;
                border-top: 1px solid #eaeaea;
                font-style: italic;
                color: #666;
            }

            /* Footer */
            .footer-divider {
                height: 1px;
                background-color: #eaeaea;
                margin: 0;
            }

            .footer {
                padding: 16px;
                text-align: center;
                background-color: #f8f9fa;
                color: #6b7280;
            }

            .footer-text {
                font-size: 14px;
                display: block;
                margin-bottom: 8px;
            }

            .copyright {
                font-size: 12px;
                color: #9ca3af;
            }

            .powered-by {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                margin: 12px 0;
            }

            .eliza-icon {
                opacity: 0.8;
            }

            .footer-links {
                margin-top: 12px;
            }

            .footer-links a {
                color: #666666;
                text-decoration: none;
                transition: color 0.15s ease;
            }

            .footer-links a:hover {
                color: #333333;
            }

            /* Responsive */
            @media only screen and (max-width: 640px) {
                .email-container {
                    margin: 0;
                    border-radius: 0;
                }

                .content {
                    padding: 24px 20px;
                }
            }

            .powered-link {
                color: #6b7280;
                text-decoration: none;
                transition: color 0.15s ease;
            }

            .powered-link:hover {
                color: #374151;
            }

            .default-logo {
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 16px 0;
                background: #f8f9fa;
            }

            .default-logo svg {
                height: 48px;
                width: 48px;
                color: #2c3e50;
            }

            /* Dark mode support */
            @media (prefers-color-scheme: dark) {
                .default-logo svg {
                    color: #f8f9fa;
                }
            }

            .copyright {
                text-align: center;
                padding: 16px;
                color: #6b7280;
                font-size: 12px;
                border-top: 1px solid #eaeaea;
            }

            .footer {
                text-align: center;
                padding: 12px;
                background-color: #f8f9fa;
                color: #6b7280;
                font-size: 13px;
                border-top: 1px solid #eaeaea;
            }

            .paragraph {
                color: #374151;
                margin: 16px 0;
                line-height: 1.6;
            }

            .bullet-list {
                margin: 16px 0;
                padding-left: 24px;
            }

            .bullet-list li {
                color: #374151;
                margin: 8px 0;
                line-height: 1.5;
            }

            .heading {
                color: #111827;
                font-size: 20px;
                font-weight: 600;
                margin: 24px 0 16px 0;
            }

            .signature {
                margin: 32px 0 24px;
                color: #4B5563;
                font-style: italic;
            }
        `.trim();
    }

    private getNotificationStyles(): string {
        return `
            ${this.getDefaultStyles()}
            .notification {
                border: 1px solid #e1e4e8;
                border-radius: 6px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            }
            .notification-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 24px;
            }
            .priority-badge {
                display: inline-block;
                padding: 4px 8px;
                border-radius: 12px;
                color: white;
                font-size: 12px;
                font-weight: 500;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .notification .email-paragraph {
                background: #f8f9fa;
                padding: 16px;
                border-radius: 4px;
                margin: 12px 0;
            }
            .notification .email-list {
                background: #f8f9fa;
                padding: 16px 16px 16px 36px;
                border-radius: 4px;
                margin: 12px 0;
            }
        `;
    }

    async renderEmail(content: GeneratedEmailContent): Promise<string> {
        try {
            const template = this.getTemplate(content.metadata.priority === 'high' ? 'notification' : 'default');
            const compiledTemplate = Handlebars.compile(template.html);

            const rendered = compiledTemplate({
                subject: content.subject,
                blocks: content.blocks,
                metadata: content.metadata,
                defaultStyle: this.getDefaultStyles()
            });

            return rendered;
        } catch (error) {
            console.error('Template rendering error:', error);
            throw error;
        }
    }

    renderBlock(block: EmailBlock): string {
        switch (block.type) {
            case 'paragraph':
                return `<p class="email-paragraph">${block.content}</p>`;
            case 'bulletList':
                const items = Array.isArray(block.content)
                    ? block.content
                    : [block.content];
                return `
                    <ul class="email-list">
                        ${items.map(item => `<li>${item}</li>`).join('\n')}
                    </ul>
                `;
            case 'heading':
                return `<h2 class="email-heading">${block.content}</h2>`;
            default:
                return String(block.content);
        }
    }

    private formatBlock(block: EmailBlock): string {
        switch (block.type) {
            case 'paragraph':
                return `<p class="paragraph">${block.content}</p>`;
            case 'bulletList':
                if (!block.content) return ''; // Ensure content is available
                const items = Array.isArray(block.content) ? block.content : [block.content];
                return `<ul class="bullet-list">
                    ${items.map((item: string) => `<li>${item}</li>`).join('\n')}
                </ul>`;
            case 'heading':
                return `<h2 class="heading">${block.content}</h2>`;
            default:
                return String(block.content || ''); // Ensure a string is always returned
        }
    }

    private getEmailFormatTemplate(): string {
        return emailFormatTemplate;
    }

    private validateTemplate(template: EmailTemplate): void {
        if (!template.id || !template.html || !template.variables) {
            throw new Error(
                'Invalid template: missing required fields (id, html, variables)'
            );
        }

        // Validate HTML structure
        if (!template.html.includes('{{content}}') &&
            !template.html.includes('{{blocks}}')) {
            throw new Error(
                'Invalid template: missing required content placeholder'
            );
        }
    }
}