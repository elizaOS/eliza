/**
 * Multimodal problem statement tests converted from test_problem_statement_multimodal.py
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { SWEBenchMultimodalProblemStatement } from '../src/agent/problem-statement';
import * as child_process from 'child_process';

// Mock child_process.execSync
jest.mock('child_process');
const mockedChildProcess = child_process as jest.Mocked<typeof child_process>;

describe('SWEBenchMultimodalProblemStatement', () => {
  const exampleImageUrl =
    'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4c/Candide1759.jpg/330px-Candide1759.jpg';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should initialize with basic properties', () => {
      const problemStatement = new SWEBenchMultimodalProblemStatement({
        text: 'Test problem statement',
        issueImages: [exampleImageUrl],
        id: 'test_id',
      });

      expect(problemStatement.text).toBe('Test problem statement');
      expect(problemStatement.issueImages).toEqual([exampleImageUrl]);
      expect(problemStatement.id).toBe('test_id');
      expect(problemStatement.type).toBe('swe_bench_multimodal');
    });

    it('should work with empty images array', () => {
      const problemStatement = new SWEBenchMultimodalProblemStatement({
        text: 'Test problem statement',
        issueImages: [],
      });

      expect(problemStatement.issueImages).toEqual([]);
    });
  });

  describe('Getting problem statement', () => {
    it('should return text when no images present', () => {
      const problemStatement = new SWEBenchMultimodalProblemStatement({
        text: 'Test problem statement',
        issueImages: [],
      });

      const result = problemStatement.getProblemStatement();
      expect(result).toBe('Test problem statement');
    });

    it('should handle valid image with successful download', () => {
      // Mock successful curl HEAD request for headers
      mockedChildProcess.execSync.mockImplementationOnce(((command: any, _options?: any) => {
        if (typeof command === 'string' && command.includes('-I')) {
          // HEAD request for headers
          return 'HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 1234\r\n\r\n';
        }
        return '';
      }) as any);

      // Mock successful curl download and base64 encoding
      mockedChildProcess.execSync.mockImplementationOnce(((command: any, _options?: any) => {
        if (typeof command === 'string' && command.includes('base64')) {
          // Download and base64 encode
          return 'ZmFrZV9pbWFnZV9kYXRh'; // base64 of 'fake_image_data'
        }
        return '';
      }) as any);

      const problemStatement = new SWEBenchMultimodalProblemStatement({
        text: 'Test problem statement',
        issueImages: [exampleImageUrl],
      });

      const result = problemStatement.getProblemStatement();

      expect(result).toContain('Test problem statement');
      expect(result).toContain(`![${exampleImageUrl}](data:image/png;base64,`);
      expect(mockedChildProcess.execSync).toHaveBeenCalledTimes(2);
    });

    it('should handle network errors gracefully', () => {
      // Mock network error
      mockedChildProcess.execSync.mockImplementationOnce((() => {
        throw new Error('Network error');
      }) as any);

      const problemStatement = new SWEBenchMultimodalProblemStatement({
        text: 'Test problem statement',
        issueImages: [exampleImageUrl],
      });

      const result = problemStatement.getProblemStatement();

      // Should return just the text, without throwing
      expect(result).toBe('Test problem statement');
      expect(mockedChildProcess.execSync).toHaveBeenCalled();
    });

    it('should reject invalid MIME types', () => {
      // Mock response with invalid MIME type
      mockedChildProcess.execSync.mockImplementationOnce(((command: any, _options?: any) => {
        if (typeof command === 'string' && command.includes('-I')) {
          // HEAD request with HTML content type
          return 'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 1234\r\n\r\n';
        }
        return '';
      }) as any);

      const problemStatement = new SWEBenchMultimodalProblemStatement({
        text: 'Test problem statement',
        issueImages: ['http://example.com/document.html'],
      });

      const result = problemStatement.getProblemStatement();

      // Should return just the text
      expect(result).toBe('Test problem statement');
    });

    it('should cache results and not re-download images', () => {
      // Mock successful curl HEAD request for headers
      mockedChildProcess.execSync.mockImplementationOnce(((command: any, _options?: any) => {
        if (typeof command === 'string' && command.includes('-I')) {
          // HEAD request for headers
          return 'HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 1234\r\n\r\n';
        }
        return '';
      }) as any);

      // Mock successful curl download and base64 encoding
      mockedChildProcess.execSync.mockImplementationOnce(((command: any, _options?: any) => {
        if (typeof command === 'string' && command.includes('base64')) {
          // Download and base64 encode
          return 'ZmFrZV9pbWFnZV9kYXRh'; // base64 of 'fake_image_data'
        }
        return '';
      }) as any);

      const problemStatement = new SWEBenchMultimodalProblemStatement({
        text: 'Test problem statement',
        issueImages: [exampleImageUrl],
      });

      // Call getProblemStatement twice
      const result1 = problemStatement.getProblemStatement();
      const result2 = problemStatement.getProblemStatement();

      // Should only call execSync twice (once for HEAD, once for download) due to caching
      expect(mockedChildProcess.execSync).toHaveBeenCalledTimes(2);
      expect(result1).toBe(result2);
      expect(result1).toContain('Test problem statement');
      expect(result1).toContain(`![${exampleImageUrl}](data:image/png;base64,`);
    });

    it('should handle invalid URLs gracefully', () => {
      const problemStatement = new SWEBenchMultimodalProblemStatement({
        text: 'Test problem statement',
        issueImages: ['not_a_url', 'ftp://invalid_scheme.com/image.png'],
      });

      const result = problemStatement.getProblemStatement();

      // Should return just the text
      expect(result).toBe('Test problem statement');
      expect(mockedChildProcess.execSync).not.toHaveBeenCalled();
    });

    it('should reject large images', () => {
      // Mock response with large content-length header
      mockedChildProcess.execSync
        .mockImplementationOnce(((command: any, _options?: any) => {
          if (typeof command === 'string' && command.includes('-I')) {
            // HEAD request with large content-length
            return 'HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 20971520\r\n\r\n'; // 20MB
          }
          return '';
        }) as any)
        .mockImplementationOnce(((command: any, _options?: any) => {
          if (typeof command === 'string' && command.includes('base64')) {
            // Simulate curl failing due to max-filesize limit
            throw new Error('curl: (63) Maximum file size exceeded');
          }
          return '';
        }) as any);

      const problemStatement = new SWEBenchMultimodalProblemStatement({
        text: 'Test problem statement',
        issueImages: ['http://example.com/huge_image.png'],
      });

      const result = problemStatement.getProblemStatement();

      // Should return just the text, rejecting the large image
      expect(result).toBe('Test problem statement');
      expect(mockedChildProcess.execSync).toHaveBeenCalledTimes(2);
    });

    it('should handle multiple images', () => {
      // Mock responses for first image
      mockedChildProcess.execSync
        .mockImplementationOnce(((command: any, _options?: any) => {
          if (typeof command === 'string' && command.includes('-I') && command.includes('image1.png')) {
            return 'HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 1234\r\n\r\n';
          }
          return '';
        }) as any)
        .mockImplementationOnce(((command: any, _options?: any) => {
          if (typeof command === 'string' && command.includes('base64') && command.includes('image1.png')) {
            return 'aW1hZ2UxX2RhdGE='; // base64 of 'image1_data'
          }
          return '';
        }) as any)
        // Mock responses for second image
        .mockImplementationOnce(((command: any, _options?: any) => {
          if (typeof command === 'string' && command.includes('-I') && command.includes('image2.jpg')) {
            return 'HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: 1234\r\n\r\n';
          }
          return '';
        }) as any)
        .mockImplementationOnce(((command: any, _options?: any) => {
          if (typeof command === 'string' && command.includes('base64') && command.includes('image2.jpg')) {
            return 'aW1hZ2UyX2RhdGE='; // base64 of 'image2_data'
          }
          return '';
        }) as any);

      const problemStatement = new SWEBenchMultimodalProblemStatement({
        text: 'Test problem statement',
        issueImages: ['http://example.com/image1.png', 'http://example.com/image2.jpg'],
      });

      const result = problemStatement.getProblemStatement();

      expect(result).toContain('Test problem statement');
      expect(result).toContain('![http://example.com/image1.png](data:image/png;base64,');
      expect(result).toContain('![http://example.com/image2.jpg](data:image/jpeg;base64,');
      expect(mockedChildProcess.execSync).toHaveBeenCalledTimes(4); // 2 HEAD + 2 download requests
    });

    it('should handle mixed valid and invalid images', () => {
      // Mock successful response for first image
      mockedChildProcess.execSync
        .mockImplementationOnce(((command: any, _options?: any) => {
          if (typeof command === 'string' && command.includes('-I') && command.includes('valid.png')) {
            return 'HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 1234\r\n\r\n';
          }
          return '';
        }) as any)
        .mockImplementationOnce(((command: any, _options?: any) => {
          if (typeof command === 'string' && command.includes('base64') && command.includes('valid.png')) {
            return 'dmFsaWRfaW1hZ2U='; // base64 of 'valid_image'
          }
          return '';
        }) as any)
        // Mock failed response for second image
        .mockImplementationOnce(((_command: any, _options?: any) => {
          throw new Error('Failed to load');
        }) as any);

      const problemStatement = new SWEBenchMultimodalProblemStatement({
        text: 'Test problem statement',
        issueImages: ['http://example.com/valid.png', 'http://example.com/invalid.png'],
      });

      const result = problemStatement.getProblemStatement();

      expect(result).toContain('Test problem statement');
      expect(result).toContain('![http://example.com/valid.png](data:image/png;base64,');
      // Invalid image should be silently skipped
      expect(result).not.toContain('http://example.com/invalid.png');
      expect(mockedChildProcess.execSync).toHaveBeenCalledTimes(3); // 2 for valid image, 1 failed for invalid
    });

    it('should handle HTTP error status codes', () => {
      // Mock 404 response
      mockedChildProcess.execSync.mockImplementationOnce(((command: any, _options?: any) => {
        if (typeof command === 'string' && command.includes('-I')) {
          // Simulate 404 error
          throw new Error('curl: (22) The requested URL returned error: 404 Not Found');
        }
        return '';
      }) as any);

      const problemStatement = new SWEBenchMultimodalProblemStatement({
        text: 'Test problem statement',
        issueImages: ['http://example.com/missing.png'],
      });

      const result = problemStatement.getProblemStatement();

      // Should handle gracefully and return just the text
      expect(result).toBe('Test problem statement');
    });

    it('should validate image URLs before attempting download', () => {
      const problemStatement = new SWEBenchMultimodalProblemStatement({
        text: 'Test problem statement',
        issueImages: [
          '', // Empty string
          'javascript:alert(1)', // JavaScript URL
          'data:image/png;base64,abc', // Data URL (should be skipped)
          'file:///etc/passwd', // File URL
        ],
      });

      const result = problemStatement.getProblemStatement();

      // None of these should trigger HTTP requests
      expect(mockedChildProcess.execSync).not.toHaveBeenCalled();
      expect(result).toBe('Test problem statement');
    });
  });
});
