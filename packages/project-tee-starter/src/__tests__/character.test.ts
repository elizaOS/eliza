import { describe, expect, it } from 'bun:test';
import { mrTeeCharacter as character } from '../character';
import dotenv from 'dotenv';
import * as path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

describe('Mr. TEE Character Configuration', () => {
  it('should have all required fields for Mr. TEE', () => {
    expect(character).toBeDefined();
    expect(typeof character.name).toBe('string');
    expect(character.name.length).toBeGreaterThan(0);
    expect(character.plugins).toBeDefined();
    expect(character.settings).toBeDefined();
    expect(character.system).toBeDefined();
    expect(character.bio).toBeDefined();
    expect(character.messageExamples).toBeDefined();
    expect(character.postExamples).toBeDefined();
    expect(character.style).toBeDefined();
    expect(character.settings?.avatar).toContain('data:image/jpeg;base64');
    expect(character.settings).toHaveProperty('secrets');
  });

  it('should include TEE specific plugins', () => {
    expect(character.plugins).toContain('@elizaos/plugin-tee');
    expect(character.plugins).toContain('@elizaos/plugin-sql');
    expect(character.plugins).toContain('@elizaos/plugin-openai');
    expect(character.plugins).toContain('@elizaos/plugin-discord');
    expect(character.plugins).toContain('@elizaos/plugin-bootstrap');
  });

  it("should have a system prompt embodying Mr. TEE's persona", () => {
    expect(character.system).toContain('Mr. TEE');
    expect(character.system).toContain('drill sergeant');
    expect(character.system).toContain('Trusted Execution Environment');
    expect(character.system).toContain('I pity the fool');
  });

  it("should have bio entries reflecting Mr. TEE's background", () => {
    const bioText = Array.isArray(character.bio) ? character.bio.join(' ').toLowerCase() : '';
    expect(bioText).toContain('tee security enforcer');
    expect(bioText).toContain('attestation authority');
    expect(bioText).toContain('hardware security');
  });

  it('should have TEE-related message examples', () => {
    let foundTeeExample = false;
    if (character.messageExamples) {
      for (const ex of character.messageExamples) {
        const dialogue = ex.map((msg) => msg.content.text?.toLowerCase() || '').join(' ');
        if (
          dialogue.includes('attestation') ||
          dialogue.includes('enclave') ||
          dialogue.includes('tee')
        ) {
          foundTeeExample = true;
          const mrTeeResponse = ex.find((msg) => msg.name === 'Mr. TEE');
          expect(mrTeeResponse).toBeDefined();
          if (mrTeeResponse && mrTeeResponse.content.text) {
            expect(mrTeeResponse.content.text.length).toBeGreaterThan(10);
            if (mrTeeResponse.content.actions) {
              expect(Array.isArray(mrTeeResponse.content.actions)).toBe(true);
            }
          }
          break;
        }
      }
    }
    expect(foundTeeExample).toBe(true);
  });

  it('should have TEE-related post examples', () => {
    const postText = character.postExamples?.join(' ').toLowerCase() || '';
    expect(postText).toContain('#teesecurity');
    expect(postText).toContain('enclave');
    expect(postText).toContain('attestation');
  });

  it('should have specific style guidelines for Mr. TEE', () => {
    expect(character.style?.all).toContain('Direct and commanding');
    expect(character.style?.chat).toContain('Respond to all security questions with authority');
    expect(character.style?.post).toContain('TEE evangelism with attitude');
  });

  it('should have TEE related settings in secrets', () => {
    expect(character.settings?.secrets).toHaveProperty('TEE_MODE');
    expect(character.settings?.secrets).toHaveProperty('TEE_VENDOR');
  });
});
