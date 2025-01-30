import { describe, it, expect, beforeEach } from 'vitest';
import { EmailTemplateManager } from '../emailTemplateManager';
import { EmailTemplate, EmailBlock } from '../../types';

describe('EmailTemplateManager', () => {
    let manager: EmailTemplateManager;

    beforeEach(() => {
        manager = new EmailTemplateManager();
    });

    describe('Template Management', () => {
        it('should provide default template', () => {
            const template = manager.getTemplate('default');
            expect(template).toBeDefined();
            expect(template.id).toBe('default');
            expect(template.html).toContain('email-container');
        });

        it('should provide notification template', () => {
            const template = manager.getTemplate('notification');
            expect(template).toBeDefined();
            expect(template.id).toBe('notification');
            expect(template.html).toContain('notification-header');
        });

        it('should fall back to default template for unknown templates', () => {
            const template = manager.getTemplate('nonexistent');
            expect(template.id).toBe('default');
        });

        it('should register custom template', () => {
            const customTemplate: EmailTemplate = {
                id: 'custom',
                name: 'Custom Template',
                html: '<div>{{content}}</div>',
                variables: ['content'],
                defaultStyle: { default: '' }
            };

            manager.registerTemplate(customTemplate);
            const retrieved = manager.getTemplate('custom');
            expect(retrieved).toEqual(customTemplate);
        });

        it('should reject invalid template registration', () => {
            expect(() => manager.registerTemplate({
                id: '',
                name: 'Invalid',
                html: '',
                variables: [],
                defaultStyle: { default: '' }
            })).toThrow('Invalid template: missing required fields (id, html, variables)');
        });
    });

    describe('Template Rendering', () => {
        it('should format blocks correctly', () => {
            const rendered = manager.renderBlock({
                type: 'paragraph',
                content: 'Test content'
            });

            expect(rendered).toContain('<p class="email-paragraph">');
            expect(rendered).toContain('Test content</p>');
        });

        it('should format bullet lists correctly', () => {
            const rendered = manager.renderBlock({
                type: 'bulletList',
                content: ['Item 1', 'Item 2']
            });

            expect(rendered).toContain('<ul class="email-list">');
            expect(rendered).toContain('<li>Item 1</li>');
            expect(rendered).toContain('<li>Item 2</li>');
        });
    });

    describe('Styles', () => {
        it('should include default styles', () => {
            const styles = manager.getDefaultStyles();
            expect(styles).toContain('.email-container');
            expect(styles).toContain('.heading');
        });
    });
});