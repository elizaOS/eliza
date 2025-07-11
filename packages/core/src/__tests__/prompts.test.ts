import { describe, expect, it } from 'bun:test';
import {
  shouldRespondTemplate,
  messageHandlerTemplate,
  postCreationTemplate,
  booleanFooter,
  imageDescriptionTemplate,
} from '../prompts';

describe('Prompts', () => {
  describe('Template Structure', () => {
    it('shouldRespondTemplate should contain required placeholders and XML structure', () => {
      expect(shouldRespondTemplate).toContain('{{agentName}}');
      expect(shouldRespondTemplate).toContain('{{providers}}');
      expect(shouldRespondTemplate).toContain('<response>');
      expect(shouldRespondTemplate).toContain('</response>');
      expect(shouldRespondTemplate).toContain('<name>');
      expect(shouldRespondTemplate).toContain('<reasoning>');
      expect(shouldRespondTemplate).toContain('<action>');
      expect(shouldRespondTemplate).toMatch(/RESPOND \| IGNORE \| STOP/);
    });

    it('messageHandlerTemplate should contain required placeholders and structure', () => {
      expect(messageHandlerTemplate).toContain('{{agentName}}');
      expect(messageHandlerTemplate).toContain('{{providers}}');
      expect(messageHandlerTemplate).toContain('{{actionNames}}');
      expect(messageHandlerTemplate).toContain('<response>');
      expect(messageHandlerTemplate).toContain('</response>');
      expect(messageHandlerTemplate).toContain('<thought>');
      expect(messageHandlerTemplate).toContain('<actions>');
      expect(messageHandlerTemplate).toContain('<providers>');
      expect(messageHandlerTemplate).toContain('<text>');

      // Check for important action ordering rules
      expect(messageHandlerTemplate).toContain('IMPORTANT ACTION ORDERING RULES');
      expect(messageHandlerTemplate).toContain('Actions are executed in the ORDER you list them');

      // Ensure code block formatting rules are explicitly included
      expect(messageHandlerTemplate).toContain('IMPORTANT CODE BLOCK FORMATTING RULES');
      expect(messageHandlerTemplate).toContain('fenced code blocks');
      expect(messageHandlerTemplate).toContain('single backticks');

      // Check for provider selection rules
      expect(messageHandlerTemplate).toContain('IMPORTANT PROVIDER SELECTION RULES');
      expect(messageHandlerTemplate).toContain('ATTACHMENTS');
      expect(messageHandlerTemplate).toContain('ENTITIES');
    });

    it('postCreationTemplate should contain required placeholders and examples', () => {
      expect(postCreationTemplate).toContain('{{agentName}}');
      expect(postCreationTemplate).toContain('{{twitterUserName}}');
      expect(postCreationTemplate).toContain('{{providers}}');
      expect(postCreationTemplate).toContain('{{adjective}}');
      expect(postCreationTemplate).toContain('{{topic}}');
      expect(postCreationTemplate).toContain('<response>');
      expect(postCreationTemplate).toContain('</response>');
      expect(postCreationTemplate).toContain('<thought>');
      expect(postCreationTemplate).toContain('<post>');
      expect(postCreationTemplate).toContain('<imagePrompt>');

      // Check for example outputs
      expect(postCreationTemplate).toMatch(/Example task outputs:/);
      expect(postCreationTemplate).toContain('A post about');
    });

    it('booleanFooter should be a simple instruction', () => {
      expect(booleanFooter).toBe('Respond with only a YES or a NO.');
      expect(booleanFooter).toMatch(/^Respond with only a YES or a NO\.$/);
    });

    it('imageDescriptionTemplate should contain proper XML structure', () => {
      expect(imageDescriptionTemplate).toContain('<task>');
      expect(imageDescriptionTemplate).toContain('<instructions>');
      expect(imageDescriptionTemplate).toContain('<output>');
      expect(imageDescriptionTemplate).toContain('<response>');
      expect(imageDescriptionTemplate).toContain('</response>');
      expect(imageDescriptionTemplate).toContain('<title>');
      expect(imageDescriptionTemplate).toContain('<description>');
      expect(imageDescriptionTemplate).toContain('<text>');

      // Check for important instructions
      expect(imageDescriptionTemplate).toContain('Analyze the provided image');
      expect(imageDescriptionTemplate).toContain('Be objective and descriptive');
    });
  });

  describe('Template Consistency', () => {
    const templates = [
      shouldRespondTemplate,
      messageHandlerTemplate,
      postCreationTemplate,
      imageDescriptionTemplate,
    ];

    it('all templates should have consistent XML output format instructions', () => {
      templates.forEach((template) => {
        expect(template).toContain('Do NOT include any thinking, reasoning, or <think> sections');
        expect(template).toContain(
          'IMPORTANT: Your response must ONLY contain the <response></response> XML block'
        );
      });
    });

    it('all templates should use proper XML closing tags', () => {
      templates.forEach((template) => {
        // Extract only the XML response format sections (not instructions mentioning tags)
        const responseBlocks = template.match(/<response>[\s\S]*?<\/response>/g) || [];

        responseBlocks.forEach((block) => {
          // Get all open tags within response blocks
          const openTags = (block.match(/<[^/][^>]+>/g) || [])
            .filter((tag) => !tag.includes('/>'))
            .filter((tag) => !tag.includes('think')); // Exclude mentioned-but-not-present tags

          const closeTags = block.match(/<\/[^>]+>/g) || [];

          // For each unique open tag, there should be a corresponding close tag
          openTags.forEach((openTag) => {
            const tagName = openTag.match(/<([^\s>]+)/)?.[1];
            if (tagName && !['br', 'hr', 'img', 'input', 'meta', 'link'].includes(tagName)) {
              expect(closeTags.some((closeTag) => closeTag.includes(tagName))).toBe(true);
            }
          });
        });

        // Also check the main structural tags outside response blocks
        const mainTags = ['task', 'providers', 'instructions', 'output', 'keys', 'actionNames'];
        mainTags.forEach((tag) => {
          if (template.includes(`<${tag}>`)) {
            expect(template).toContain(`</${tag}>`);
          }
        });
      });
    });
  });

  describe('Template Placeholders', () => {
    it('should use consistent placeholder format', () => {
      const placeholderPattern = /\{\{[^}]+\}\}/g;

      const shouldRespondPlaceholders = shouldRespondTemplate.match(placeholderPattern) || [];
      const messageHandlerPlaceholders = messageHandlerTemplate.match(placeholderPattern) || [];
      const postCreationPlaceholders = postCreationTemplate.match(placeholderPattern) || [];

      // All placeholders should use double curly braces
      [
        ...shouldRespondPlaceholders,
        ...messageHandlerPlaceholders,
        ...postCreationPlaceholders,
      ].forEach((placeholder) => {
        expect(placeholder).toMatch(/^\{\{[^}]+\}\}$/);
      });

      // Common placeholders should be consistent across templates
      expect(shouldRespondPlaceholders).toContain('{{agentName}}');
      expect(messageHandlerPlaceholders).toContain('{{agentName}}');
      expect(postCreationPlaceholders).toContain('{{agentName}}');
    });
  });
});
