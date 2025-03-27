import { v4 as uuidv4 } from 'uuid';
import type { AgentRuntime, Content, Memory, UUID } from '@elizaos/core';

/**
 * Helper function to create a test message
 */
export function createTestMessage(params: {
  text: string;
  entityId: UUID;
  roomId: UUID;
  userName?: string;
  attachments?: any[];
}): Memory {
  return {
    id: uuidv4() as UUID,
    entityId: params.entityId,
    roomId: params.roomId,
    content: {
      text: params.text,
      userName: params.userName,
      attachments: params.attachments || [],
    } as Content,
  };
}

/**
 * Helper function to wait for a condition to be met
 */
export async function waitFor(condition: () => boolean, timeout = 5000): Promise<boolean> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    if (condition()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return false;
}

/**
 * Helper function to check if an object is included in an array of objects
 * by comparing a specific property value
 */
export function includesObjectWithProperty<T>(
  array: T[],
  propertyName: keyof T,
  value: any
): boolean {
  return array.some(item => item[propertyName] === value);
}

/**
 * Helper function to extract text content from memory objects
 */
export function getMemoryText(memory: Memory): string | undefined {
  return memory.content.text;
}

/**
 * Helper function to check if response matches character style
 */
export function matchesCharacterStyle(text: string): boolean {
  // The community manager has a terse, direct style
  return (
    text.length < 150 && // Short responses
    !text.includes('I apologize') && // No apologies
    !text.includes('I understand') && // No empathy statements
    !text.match(/as an AI|as a language model/) // No self-references
  );
} 