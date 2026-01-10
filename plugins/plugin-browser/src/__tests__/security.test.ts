import { describe, expect, it, beforeEach, mock, spyOn } from 'bun:test';
import {
  UrlValidator,
  InputSanitizer,
  validateSecureAction,
  defaultUrlValidator,
  RateLimiter,
  SecurityConfig,
} from '../security';
import { BrowserSecurityError } from '../errors';

describe('UrlValidator', () => {
  let validator: UrlValidator;

  beforeEach(() => {
    validator = new UrlValidator();
  });

  describe('URL validation', () => {
    it('should validate valid HTTPS URL', () => {
      const result = validator.validateUrl('https://example.com');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('https://example.com/');
    });

    it('should validate valid HTTP URL', () => {
      const result = validator.validateUrl('http://example.com');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('http://example.com/');
    });

    it('should add https:// to URLs without protocol', () => {
      const result = validator.validateUrl('example.com');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('https://example.com/');
    });

    it('should reject invalid URLs', () => {
      const result = validator.validateUrl('not a url');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid URL format');
    });

    it('should reject URLs that are too long', () => {
      const longUrl = `https://example.com/${'a'.repeat(7777)}`;
      const result = validator.validateUrl(longUrl);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('URL is too long');
    });

    it('should reject file protocol by default', () => {
      const result = validator.validateUrl('file:///etc/passwd');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File protocol is not allowed');
    });

    it('should allow file protocol when configured', () => {
      validator = new UrlValidator({ allowFileProtocol: true });
      const result = validator.validateUrl('file:///home/user/file.txt');
      expect(result.valid).toBe(true);
    });

    it('should reject non-HTTP protocols', () => {
      const result = validator.validateUrl('ftp://example.com');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Only HTTP(S) protocols are allowed');
    });

    it('should handle localhost URLs', () => {
      const result1 = validator.validateUrl('http://localhost:7777');
      expect(result1.valid).toBe(true);

      const result2 = validator.validateUrl('http://127.0.0.1:8080');
      expect(result2.valid).toBe(true);
    });

    it('should reject localhost when disabled', () => {
      validator = new UrlValidator({ allowLocalhost: false });
      const result = validator.validateUrl('http://localhost:7777');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Localhost URLs are not allowed');
    });

    it('should check blocked domains', () => {
      const result = validator.validateUrl('https://malware.com');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Domain malware.com is blocked');
    });

    it('should enforce allowed domains when configured', () => {
      validator = new UrlValidator({
        allowedDomains: ['github.com', 'example.com'],
      });

      const result1 = validator.validateUrl('https://github.com/user/repo');
      expect(result1.valid).toBe(true);

      const result2 = validator.validateUrl('https://google.com');
      expect(result2.valid).toBe(false);
      expect(result2.error).toBe('Domain is not in the allowed list');
    });

    it('should allow subdomains of allowed domains', () => {
      validator = new UrlValidator({
        allowedDomains: ['example.com'],
      });

      const result = validator.validateUrl('https://api.example.com');
      expect(result.valid).toBe(true);
    });
  });

  describe('config updates', () => {
    it('should update configuration', () => {
      validator.updateConfig({ maxUrlLength: 100 });

      const longUrl = `https://example.com/${'a'.repeat(100)}`;
      const result = validator.validateUrl(longUrl);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('URL is too long');
    });
  });
});

describe('InputSanitizer', () => {
  describe('sanitizeText', () => {
    it('should remove HTML tags', () => {
      const result = InputSanitizer.sanitizeText('<script>alert("xss")</script>');
      expect(result).toBe('scriptalert("xss")/script');
    });

    it('should remove javascript: protocol', () => {
      const result = InputSanitizer.sanitizeText('javascript:alert("xss")');
      expect(result).toBe('alert("xss")');
    });

    it('should remove event handlers', () => {
      const result = InputSanitizer.sanitizeText('onclick=alert("xss")');
      expect(result).toBe('alert("xss")');
    });

    it('should trim whitespace', () => {
      const result = InputSanitizer.sanitizeText('  hello world  ');
      expect(result).toBe('hello world');
    });

    it('should handle case insensitive patterns', () => {
      const result = InputSanitizer.sanitizeText('JAVASCRIPT:alert("xss") OnClick=test');
      expect(result).toBe('alert("xss") test');
    });
  });

  describe('sanitizeSelector', () => {
    it('should remove quotes', () => {
      const result = InputSanitizer.sanitizeSelector('button[name="submit"]');
      expect(result).toBe('button[name=submit]');
    });

    it('should remove HTML tags', () => {
      const result = InputSanitizer.sanitizeSelector('button<script>alert()</script>');
      expect(result).toBe('buttonscriptalert()/script');
    });

    it('should trim whitespace', () => {
      const result = InputSanitizer.sanitizeSelector('  .submit-button  ');
      expect(result).toBe('.submit-button');
    });
  });

  describe('sanitizeFilePath', () => {
    it('should remove path traversal attempts', () => {
      const result = InputSanitizer.sanitizeFilePath('../../../etc/passwd');
      expect(result).toBe('///etc/passwd');
    });

    it('should remove invalid filename characters', () => {
      const result = InputSanitizer.sanitizeFilePath('file<>:"|?*name.txt');
      expect(result).toBe('filename.txt');
    });

    it('should trim whitespace', () => {
      const result = InputSanitizer.sanitizeFilePath('  document.pdf  ');
      expect(result).toBe('document.pdf');
    });
  });
});

describe('validateSecureAction', () => {
  let validator: UrlValidator;

  beforeEach(() => {
    validator = new UrlValidator();
  });

  it('should pass for valid URLs', () => {
    expect(() => validateSecureAction('https://example.com', validator)).not.toThrow();
  });

  it('should pass for null URLs', () => {
    expect(() => validateSecureAction(null, validator)).not.toThrow();
  });

  it('should throw BrowserSecurityError for invalid URLs', () => {
    expect(() => validateSecureAction('https://malware.com', validator)).toThrow(
      BrowserSecurityError
    );
  });

  it('should include error details', () => {
    try {
      validateSecureAction('invalid url', validator);
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserSecurityError);
      expect((error as BrowserSecurityError).details?.url).toBe('invalid url');
      expect((error as BrowserSecurityError).details?.error).toBe('Invalid URL format');
    }
  });
});

describe('defaultUrlValidator', () => {
  it('should be an instance of UrlValidator', () => {
    expect(defaultUrlValidator).toBeInstanceOf(UrlValidator);
  });

  it('should use default configuration', () => {
    const result = defaultUrlValidator.validateUrl('https://example.com');
    expect(result.valid).toBe(true);
  });
});

describe('RateLimiter', () => {
  let rateLimiter: RateLimiter;
  let now: number;

  beforeEach(() => {
    rateLimiter = new RateLimiter({
      maxActionsPerMinute: 2,
      maxSessionsPerHour: 3,
    });
    now = Date.now();
    spyOn(Date, 'now').mockReturnValue(now);
  });

  describe('action limits', () => {
    it('should allow actions within limit', () => {
      expect(rateLimiter.checkActionLimit('user1')).toBe(true);
      expect(rateLimiter.checkActionLimit('user1')).toBe(true);
    });

    it('should reject actions over limit', () => {
      expect(rateLimiter.checkActionLimit('user1')).toBe(true);
      expect(rateLimiter.checkActionLimit('user1')).toBe(true);
      expect(rateLimiter.checkActionLimit('user1')).toBe(false);
    });

    it('should reset after time window', () => {
      expect(rateLimiter.checkActionLimit('user1')).toBe(true);
      expect(rateLimiter.checkActionLimit('user1')).toBe(true);
      expect(rateLimiter.checkActionLimit('user1')).toBe(false);

      // Advance time by 1 minute
      spyOn(Date, 'now').mockReturnValue(now + 60001);

      expect(rateLimiter.checkActionLimit('user1')).toBe(true);
    });

    it('should track different users separately', () => {
      expect(rateLimiter.checkActionLimit('user1')).toBe(true);
      expect(rateLimiter.checkActionLimit('user1')).toBe(true);
      expect(rateLimiter.checkActionLimit('user2')).toBe(true);
      expect(rateLimiter.checkActionLimit('user2')).toBe(true);
    });
  });

  describe('session limits', () => {
    it('should allow sessions within limit', () => {
      expect(rateLimiter.checkSessionLimit('user1')).toBe(true);
      expect(rateLimiter.checkSessionLimit('user1')).toBe(true);
      expect(rateLimiter.checkSessionLimit('user1')).toBe(true);
    });

    it('should reject sessions over limit', () => {
      expect(rateLimiter.checkSessionLimit('user1')).toBe(true);
      expect(rateLimiter.checkSessionLimit('user1')).toBe(true);
      expect(rateLimiter.checkSessionLimit('user1')).toBe(true);
      expect(rateLimiter.checkSessionLimit('user1')).toBe(false);
    });

    it('should reset after time window', () => {
      expect(rateLimiter.checkSessionLimit('user1')).toBe(true);
      expect(rateLimiter.checkSessionLimit('user1')).toBe(true);
      expect(rateLimiter.checkSessionLimit('user1')).toBe(true);
      expect(rateLimiter.checkSessionLimit('user1')).toBe(false);

      // Advance time by 1 hour
      spyOn(Date, 'now').mockReturnValue(now + 3600001);

      expect(rateLimiter.checkSessionLimit('user1')).toBe(true);
    });

    it('should track different users separately', () => {
      expect(rateLimiter.checkSessionLimit('user1')).toBe(true);
      expect(rateLimiter.checkSessionLimit('user1')).toBe(true);
      expect(rateLimiter.checkSessionLimit('user1')).toBe(true);
      expect(rateLimiter.checkSessionLimit('user2')).toBe(true);
    });
  });
});
