import { describe, it, expect, mock, jest } from 'bun:test';

// Simple test to verify mocking works
describe('Mock Test', () => {
  it('should pass without any imports', () => {
    expect(1 + 1).toBe(2);
  });
  
  it('should work with basic mock', () => {
    const mockFn = jest.fn();
    mockFn('test');
    expect(mockFn).toHaveBeenCalledWith('test');
  });
}); 