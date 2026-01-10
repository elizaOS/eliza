import { describe, it, expect, beforeEach } from 'vitest';
import {
  Profile,
  Cast,
  CastId,
  FidRequest,
  LastCast,
  FarcasterConfigSchema,
  FarcasterConfig,
  FarcasterEventTypes,
  FarcasterMessageType,
  FarcasterGenericCastPayload
} from '../../../common/types';
import { DEFAULT_MAX_CAST_LENGTH, DEFAULT_POLL_INTERVAL } from '../../../common/constants';

describe('Profile Type', () => {
  it('should accept valid profile with all properties', () => {
    const validProfile: Profile = {
      fid: 12345,
      name: 'John Doe',
      username: 'johndoe',
      pfp: 'https://example.com/avatar.jpg',
      bio: 'Software developer',
      url: 'https://johndoe.dev'
    };

    expect(validProfile.fid).toBe(12345);
    expect(validProfile.name).toBe('John Doe');
    expect(validProfile.username).toBe('johndoe');
  });

  it('should accept profile with only required properties', () => {
    const minimalProfile: Profile = {
      fid: 1,
      name: 'User',
      username: 'user'
    };

    expect(minimalProfile.fid).toBe(1);
    expect(minimalProfile.pfp).toBeUndefined();
    expect(minimalProfile.bio).toBeUndefined();
    expect(minimalProfile.url).toBeUndefined();
  });

  it('should handle edge case values', () => {
    const edgeProfile: Profile = {
      fid: 0,
      name: '',
      username: '',
      pfp: '',
      bio: '',
      url: ''
    };

    expect(edgeProfile.fid).toBe(0);
    expect(edgeProfile.name).toBe('');
  });
});

describe('Cast Type', () => {
  let sampleProfile: Profile;

  beforeEach(() => {
    sampleProfile = {
      fid: 12345,
      name: 'Test User',
      username: 'testuser'
    };
  });

  it('should accept valid cast with all properties', () => {
    const validCast: Cast = {
      hash: '0x1234567890abcdef',
      authorFid: 12345,
      text: 'This is a test cast',
      profile: sampleProfile,
      threadId: 'thread123',
      inReplyTo: {
        hash: '0xabcdef1234567890',
        fid: 67890
      },
      timestamp: new Date('2024-01-01T12:00:00Z'),
      stats: {
        recasts: 10,
        replies: 5,
        likes: 25
      }
    };

    expect(validCast.hash).toBe('0x1234567890abcdef');
    expect(validCast.authorFid).toBe(12345);
    expect(validCast.text).toBe('This is a test cast');
    expect(validCast.profile).toEqual(sampleProfile);
  });

  it('should accept minimal cast with only required properties', () => {
    const minimalCast: Cast = {
      hash: '0x123',
      authorFid: 1,
      text: 'Minimal cast',
      profile: sampleProfile,
      timestamp: new Date()
    };

    expect(minimalCast.threadId).toBeUndefined();
    expect(minimalCast.inReplyTo).toBeUndefined();
    expect(minimalCast.stats).toBeUndefined();
  });

  it('should handle empty text and zero stats', () => {
    const emptyCast: Cast = {
      hash: '0x000',
      authorFid: 0,
      text: '',
      profile: sampleProfile,
      timestamp: new Date(),
      stats: {
        recasts: 0,
        replies: 0,
        likes: 0
      }
    };

    expect(emptyCast.text).toBe('');
    expect(emptyCast.stats?.recasts).toBe(0);
  });
});

describe('CastId Type', () => {
  it('should accept valid cast id', () => {
    const castId: CastId = {
      hash: '0x1234567890abcdef',
      fid: 12345
    };

    expect(castId.hash).toBe('0x1234567890abcdef');
    expect(castId.fid).toBe(12345);
  });

  it('should handle empty hash and zero fid', () => {
    const edgeCastId: CastId = {
      hash: '',
      fid: 0
    };

    expect(edgeCastId.hash).toBe('');
    expect(edgeCastId.fid).toBe(0);
  });
});

describe('FidRequest Type', () => {
  it('should accept valid fid request', () => {
    const fidRequest: FidRequest = {
      fid: 12345,
      pageSize: 25
    };

    expect(fidRequest.fid).toBe(12345);
    expect(fidRequest.pageSize).toBe(25);
  });

  it('should handle boundary values', () => {
    const boundaryRequest: FidRequest = {
      fid: 1,
      pageSize: 1
    };

    expect(boundaryRequest.fid).toBe(1);
    expect(boundaryRequest.pageSize).toBe(1);
  });
});

describe('LastCast Interface', () => {
  it('should accept valid last cast', () => {
    const lastCast: LastCast = {
      hash: '0xabcdef1234567890',
      timestamp: 1640995200000
    };

    expect(lastCast.hash).toBe('0xabcdef1234567890');
    expect(lastCast.timestamp).toBe(1640995200000);
  });

  it('should handle zero timestamp', () => {
    const zeroTimestamp: LastCast = {
      hash: '0x000',
      timestamp: 0
    };

    expect(zeroTimestamp.timestamp).toBe(0);
  });
});

describe('FarcasterConfigSchema', () => {
  it('should validate complete valid configuration', () => {
    const validConfig: FarcasterConfig = {
      FARCASTER_DRY_RUN: true,
      FARCASTER_FID: 12345,
      MAX_CAST_LENGTH: 280,
      FARCASTER_POLL_INTERVAL: 60,
      ENABLE_CAST: true,
      CAST_INTERVAL_MIN: 30,
      CAST_INTERVAL_MAX: 300,
      ENABLE_ACTION_PROCESSING: false,
      ACTION_INTERVAL: 15000,
      CAST_IMMEDIATELY: false,
      MAX_ACTIONS_PROCESSING: 10,
      FARCASTER_SIGNER_UUID: 'uuid-1234-5678-9012',
      FARCASTER_NEYNAR_API_KEY: 'api-key-12345',
      FARCASTER_HUB_URL: 'https://hub.farcaster.example.com'
    };

    const result = FarcasterConfigSchema.parse(validConfig);
    expect(result.FARCASTER_FID).toBe(12345);
    expect(result.MAX_CAST_LENGTH).toBe(280);
    expect(result.FARCASTER_DRY_RUN).toBe(true);
  });

  it('should apply default values when optional fields are missing', () => {
    const minimalConfig = {
      FARCASTER_DRY_RUN: false,
      FARCASTER_FID: 1,
      ENABLE_CAST: true,
      CAST_INTERVAL_MIN: 10,
      CAST_INTERVAL_MAX: 100,
      ENABLE_ACTION_PROCESSING: true,
      ACTION_INTERVAL: 5000,
      CAST_IMMEDIATELY: false,
      MAX_ACTIONS_PROCESSING: 5,
      FARCASTER_SIGNER_UUID: 'minimal-uuid',
      FARCASTER_NEYNAR_API_KEY: 'minimal-api-key',
      FARCASTER_HUB_URL: 'https://minimal.hub.com'
    };

    const result = FarcasterConfigSchema.parse(minimalConfig);
    expect(result.MAX_CAST_LENGTH).toBe(DEFAULT_MAX_CAST_LENGTH);
    expect(result.FARCASTER_POLL_INTERVAL).toBe(DEFAULT_POLL_INTERVAL);
  });

  it('should transform string booleans to actual booleans', () => {
    const stringBooleanConfig = {
      FARCASTER_DRY_RUN: 'true',
      FARCASTER_FID: 12345,
      ENABLE_CAST: 'false',
      CAST_INTERVAL_MIN: 30,
      CAST_INTERVAL_MAX: 300,
      ENABLE_ACTION_PROCESSING: 'TRUE',
      ACTION_INTERVAL: 15000,
      CAST_IMMEDIATELY: 'False',
      MAX_ACTIONS_PROCESSING: 10,
      FARCASTER_SIGNER_UUID: 'string-bool-uuid',
      FARCASTER_NEYNAR_API_KEY: 'string-bool-api-key',
      FARCASTER_HUB_URL: 'https://string-bool.hub.com'
    };

    const result = FarcasterConfigSchema.parse(stringBooleanConfig);
    expect(result.FARCASTER_DRY_RUN).toBe(true);
    expect(result.ENABLE_CAST).toBe(false);
    expect(result.ENABLE_ACTION_PROCESSING).toBe(true);
    expect(result.CAST_IMMEDIATELY).toBe(false);
  });

  it('should throw error for invalid FARCASTER_FID', () => {
    const invalidConfig = {
      FARCASTER_FID: 0,
      ENABLE_CAST: true,
      CAST_INTERVAL_MIN: 30,
      CAST_INTERVAL_MAX: 300,
      ENABLE_ACTION_PROCESSING: true,
      ACTION_INTERVAL: 15000,
      CAST_IMMEDIATELY: false,
      MAX_ACTIONS_PROCESSING: 10,
      FARCASTER_SIGNER_UUID: 'test-uuid',
      FARCASTER_NEYNAR_API_KEY: 'test-api-key',
      FARCASTER_HUB_URL: 'https://test.hub.com'
    };

    expect(() => FarcasterConfigSchema.parse(invalidConfig)).toThrow();
  });

  it('should throw error for missing required fields', () => {
    const incompleteConfig = {
      FARCASTER_FID: 12345
    };

    expect(() => FarcasterConfigSchema.parse(incompleteConfig)).toThrow();
  });

  it('should throw error for empty required strings', () => {
    const emptyStringConfig = {
      FARCASTER_FID: 12345,
      ENABLE_CAST: true,
      CAST_INTERVAL_MIN: 30,
      CAST_INTERVAL_MAX: 300,
      ENABLE_ACTION_PROCESSING: true,
      ACTION_INTERVAL: 15000,
      CAST_IMMEDIATELY: false,
      MAX_ACTIONS_PROCESSING: 10,
      FARCASTER_SIGNER_UUID: '',
      FARCASTER_NEYNAR_API_KEY: 'valid-api-key',
      FARCASTER_HUB_URL: 'https://valid.hub.com'
    };

    expect(() => FarcasterConfigSchema.parse(emptyStringConfig)).toThrow();
  });
});

describe('FarcasterEventTypes Enum', () => {
  it('should contain all expected event types', () => {
    expect(FarcasterEventTypes.CAST_GENERATED).toBe('FARCASTER_CAST_GENERATED');
    expect(FarcasterEventTypes.MENTION_RECEIVED).toBe('FARCASTER_MENTION_RECEIVED');
    expect(FarcasterEventTypes.THREAD_CAST_CREATED).toBe('FARCASTER_THREAD_CAST_CREATED');
  });

  it('should have exactly 3 enum values', () => {
    const enumValues = Object.values(FarcasterEventTypes);
    expect(enumValues).toHaveLength(3);
  });

  it('should allow valid enum assignments', () => {
    let eventType: FarcasterEventTypes;

    eventType = FarcasterEventTypes.CAST_GENERATED;
    expect(eventType).toBe('FARCASTER_CAST_GENERATED');

    eventType = FarcasterEventTypes.MENTION_RECEIVED;
    expect(eventType).toBe('FARCASTER_MENTION_RECEIVED');

    eventType = FarcasterEventTypes.THREAD_CAST_CREATED;
    expect(eventType).toBe('FARCASTER_THREAD_CAST_CREATED');
  });
});

describe('FarcasterMessageType Enum', () => {
  it('should contain all expected message types', () => {
    expect(FarcasterMessageType.CAST).toBe('CAST');
    expect(FarcasterMessageType.REPLY).toBe('REPLY');
  });

  it('should have exactly 2 enum values', () => {
    const enumValues = Object.values(FarcasterMessageType);
    expect(enumValues).toHaveLength(2);
  });

  it('should allow valid enum assignments', () => {
    let messageType: FarcasterMessageType;

    messageType = FarcasterMessageType.CAST;
    expect(messageType).toBe('CAST');

    messageType = FarcasterMessageType.REPLY;
    expect(messageType).toBe('REPLY');
  });
});

describe('FarcasterGenericCastPayload Interface', () => {
  it('should accept valid payload structure', () => {
    const mockMemory = {} as any;
    const mockCast = {} as any;

    const validPayload: FarcasterGenericCastPayload = {
      memory: mockMemory,
      cast: mockCast,
      runtime: {} as any,
      source: 'farcaster'
    };

    expect(validPayload.memory).toBeDefined();
    expect(validPayload.cast).toBeDefined();
    expect(validPayload.source).toBe('farcaster');
  });

  it('should handle minimal payload structure', () => {
    const mockMemory = {} as any;
    const mockCast = {} as any;

    const minimalPayload: FarcasterGenericCastPayload = {
      memory: mockMemory,
      cast: mockCast,
      runtime: {} as any,
      source: 'farcaster'
    };

    expect(minimalPayload.memory).toBeDefined();
    expect(minimalPayload.cast).toBeDefined();
  });
});

describe('Type Integration Tests', () => {
  it('should create a complete workflow with all types', () => {
    const profile: Profile = {
      fid: 12345,
      name: 'Integration Test User',
      username: 'integrationtest',
      pfp: 'https://example.com/pfp.jpg',
      bio: 'Testing user for integration tests'
    };

    const cast: Cast = {
      hash: '0xintegrationtest123',
      authorFid: profile.fid,
      text: 'This is an integration test cast',
      profile: profile,
      timestamp: new Date(),
      stats: {
        recasts: 1,
        replies: 2,
        likes: 3
      }
    };

    const castId: CastId = {
      hash: cast.hash,
      fid: cast.authorFid
    };

    const fidRequest: FidRequest = {
      fid: profile.fid,
      pageSize: 10
    };

    const lastCast: LastCast = {
      hash: cast.hash,
      timestamp: cast.timestamp.getTime()
    };

    expect(cast.profile.fid).toBe(profile.fid);
    expect(castId.fid).toBe(cast.authorFid);
    expect(fidRequest.fid).toBe(profile.fid);
    expect(lastCast.hash).toBe(cast.hash);
  });

  it('should validate configuration with realistic values', () => {
    const realisticConfig = {
      FARCASTER_DRY_RUN: false,
      FARCASTER_FID: 123456,
      MAX_CAST_LENGTH: 320,
      FARCASTER_POLL_INTERVAL: 120,
      ENABLE_CAST: true,
      CAST_INTERVAL_MIN: 1800,
      CAST_INTERVAL_MAX: 7200,
      ENABLE_ACTION_PROCESSING: true,
      ACTION_INTERVAL: 30000,
      CAST_IMMEDIATELY: false,
      MAX_ACTIONS_PROCESSING: 5,
      FARCASTER_SIGNER_UUID: '12345678-1234-1234-1234-123456789012',
      FARCASTER_NEYNAR_API_KEY: 'NEYNAR_API_DOCS_12345678901234567890',
      FARCASTER_HUB_URL: 'https://hub.pinata.cloud'
    };

    const parsed = FarcasterConfigSchema.parse(realisticConfig);
    expect(parsed.FARCASTER_FID).toBe(123456);
    expect(parsed.MAX_CAST_LENGTH).toBe(320);
    expect(parsed.ENABLE_CAST).toBe(true);
  });

  it('should handle edge cases across all types', () => {
    const extremeProfile: Profile = {
      fid: 999999999,
      name: 'A'.repeat(100),
      username: 'a'.repeat(50)
    };

    const extremeCast: Cast = {
      hash: '0x' + 'f'.repeat(64),
      authorFid: extremeProfile.fid,
      text: 'X'.repeat(320),
      profile: extremeProfile,
      timestamp: new Date('2099-12-31T23:59:59Z'),
      stats: {
        recasts: 999999,
        replies: 999999,
        likes: 999999
      }
    };

    expect(extremeProfile.fid).toBe(999999999);
    expect(extremeCast.text).toHaveLength(320);
    expect(extremeCast.stats?.likes).toBe(999999);
  });
});