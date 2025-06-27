// Mock Tauri API for testing
import { vi } from 'vitest';

export const invoke = vi.fn().mockResolvedValue(undefined);
export const listen = vi.fn().mockResolvedValue(() => {});
export const emit = vi.fn();

export default {
  invoke,
  listen,
  emit,
}; 