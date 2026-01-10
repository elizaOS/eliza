import { describe, expect, it, mock } from 'bun:test';
import {
  StagehandError,
  BrowserNavigationError,
  BrowserSessionError,
  BrowserActionError,
  BrowserSecurityError,
  BrowserServiceNotAvailableError,
  handleBrowserError,
} from '../errors';

describe('Error Classes', () => {
  describe('StagehandError', () => {
    it('should create error with all properties', () => {
      const error = new StagehandError('Test error', 'TEST_ERROR', 'User friendly message', true, {
        extra: 'data',
      });

      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_ERROR');
      expect(error.userMessage).toBe('User friendly message');
      expect(error.recoverable).toBe(true);
      expect(error.details).toEqual({ extra: 'data' });
      expect(error.name).toBe('StagehandError');
    });

    it('should default recoverable to true', () => {
      const error = new StagehandError('Test error', 'TEST_ERROR', 'User friendly message');

      expect(error.recoverable).toBe(true);
    });
  });

  describe('BrowserNavigationError', () => {
    it('should create navigation error with URL', () => {
      const error = new BrowserNavigationError('https://example.com');

      expect(error.code).toBe('NAVIGATION_ERROR');
      expect(error.message).toContain('Failed to navigate to https://example.com');
      expect(error.userMessage).toContain("couldn't navigate to the requested page");
      expect(error.recoverable).toBe(true);
      expect(error.details?.url).toBe('https://example.com');
    });

    it('should include original error message', () => {
      const originalError = new Error('Network timeout');
      const error = new BrowserNavigationError('https://example.com', originalError);

      expect(error.message).toContain('Network timeout');
      expect(error.details?.originalError).toBe('Network timeout');
    });
  });

  describe('BrowserSessionError', () => {
    it('should create session error', () => {
      const error = new BrowserSessionError('Session expired', { sessionId: '123' });

      expect(error.code).toBe('BROWSER_SESSION_ERROR');
      expect(error.message).toBe('Session expired');
      expect(error.userMessage).toContain('There was an error with the browser session');
      expect(error.details?.sessionId).toBe('123');
    });
  });

  describe('BrowserActionError', () => {
    it('should create action error', () => {
      const error = new BrowserActionError('click', 'submit button');

      expect(error.code).toBe('ACTION_ERROR');
      expect(error.message).toContain('Failed to click on submit button');
      expect(error.userMessage).toContain("I couldn't click on the requested element");
      expect(error.details?.action).toBe('click');
      expect(error.details?.target).toBe('submit button');
    });

    it('should include original error', () => {
      const originalError = new Error('Element not found');
      const error = new BrowserActionError('type', 'input field', originalError);

      expect(error.message).toContain('Element not found');
      expect(error.details?.originalError).toBe('Element not found');
    });
  });

  // TODO: Implement BrowserTimeoutError
  // describe('BrowserTimeoutError', () => {
  //   it('should create timeout error', () => {
  //     const error = new BrowserTimeoutError('navigation', 30000);

  //     expect(error.code).toBe('BROWSER_TIMEOUT_ERROR');
  //     expect(error.message).toContain('timed out after 30000ms');
  //     expect(error.userMessage).toContain('took too long and timed out');
  //     expect(error.details?.action).toBe('navigation');
  //     expect(error.details?.timeoutMs).toBe(30000);
  //   });
  // });

  // TODO: Implement BrowserExtractionError
  // describe('BrowserExtractionError', () => {
  //   it('should create extraction error', () => {
  //     const error = new BrowserExtractionError('Extract user name');

  //     expect(error.code).toBe('BROWSER_EXTRACTION_ERROR');
  //     expect(error.message).toContain('Failed to extract data');
  //     expect(error.userMessage).toContain("couldn't extract the requested information");
  //     expect(error.details?.instruction).toBe('Extract user name');
  //   });

  //   it('should include original error', () => {
  //     const originalError = new Error('Invalid selector');
  //     const error = new BrowserExtractionError('Extract price', originalError);

  //     expect(error.message).toContain('Invalid selector');
  //     expect(error.details?.originalError).toBe('Invalid selector');
  //   });
  // });

  describe('BrowserSecurityError', () => {
    it('should create security error', () => {
      const error = new BrowserSecurityError('Blocked domain', { domain: 'malware.com' });

      expect(error.code).toBe('SECURITY_ERROR');
      expect(error.message).toBe('Blocked domain');
      expect(error.userMessage).toContain('blocked for security reasons');
      expect(error.recoverable).toBe(false);
      expect(error.details?.domain).toBe('malware.com');
    });
  });

  describe('BrowserServiceNotAvailableError', () => {
    it('should create service not available error', () => {
      const error = new BrowserServiceNotAvailableError();

      expect(error.code).toBe('SERVICE_NOT_AVAILABLE');
      expect(error.message).toBe('Browser service is not available');
      expect(error.userMessage).toContain('The browser automation service is not available');
      expect(error.recoverable).toBe(false);
    });
  });
});

describe('handleBrowserError', () => {
  it('should handle StagehandError', () => {
    const callback = mock();
    const error = new BrowserNavigationError('https://example.com');

    handleBrowserError(error, callback);

    expect(callback).toHaveBeenCalledWith({
      text: error.userMessage,
      error: true,
    });
  });

  it('should convert timeout errors', () => {
    const callback = mock();
    const error = new Error('Operation timeout after 5000ms');

    handleBrowserError(error, callback, 'load page');

    expect(callback).toHaveBeenCalledWith({
      text: 'I encountered an error while trying to load page. Please try again.',
      error: true,
    });
  });

  it('should convert navigation errors', () => {
    const callback = mock();
    const error = new Error('Failed to navigate to page');

    handleBrowserError(error, callback);

    expect(callback).toHaveBeenCalledWith({
      text: 'I encountered an unexpected error. Please try again.',
      error: true,
    });
  });

  it('should handle generic errors', () => {
    const callback = mock();
    const error = new Error('Something went wrong');

    handleBrowserError(error, callback, 'perform action');

    expect(callback).toHaveBeenCalledWith({
      text: 'I encountered an error while trying to perform action. Please try again.',
      error: true,
    });
  });

  it('should handle non-Error objects', () => {
    const callback = mock();
    const error = new Error('String error');

    handleBrowserError(error, callback, 'do something');

    expect(callback).toHaveBeenCalledWith({
      text: 'I encountered an error while trying to do something. Please try again.',
      error: true,
    });
  });

  it('should use default action when not provided', () => {
    const callback = mock();
    const error = new Error('Test error');

    handleBrowserError(error, callback);

    expect(callback).toHaveBeenCalledWith({
      text: 'I encountered an unexpected error. Please try again.',
      error: true,
    });
  });
});
