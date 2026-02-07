import type { UUID, Role } from '@elizaos/core';
import type { TrustRequirements } from './trust';

/**
 * Context for permission evaluation
 */
export interface PermissionContext {
  worldId?: UUID;
  roomId?: UUID;
  platform?: string;
  serverId?: string;
  channelId?: string;
  timestamp?: number;
}

/**
 * A contextual role that applies in specific contexts
 */
export interface ContextualRole {
  id: UUID;
  role: Role;
  entityId: UUID;
  context: PermissionContext;

  /** When this role assignment expires */
  expiresAt?: number;

  /** Who assigned this role */
  assignedBy: UUID;

  /** When this role was assigned */
  assignedAt: number;

  /** Trust requirements for this role */
  trustRequirements?: TrustRequirements;

  /** Additional metadata */
  metadata?: Record<string, any>;
}

/**
 * Permission that can be granted
 */
export interface Permission {
  action: string;
  resource: string;
  context?: PermissionContext;
  constraints?: PermissionConstraint[];
}

/**
 * Constraint on a permission
 */
export interface PermissionConstraint {
  type: 'time_window' | 'usage_limit' | 'trust_required' | 'role_required' | 'custom';
  value: any;
  description?: string;
}

/**
 * Result of a permission check
 */
export interface PermissionDecision {
  allowed: boolean;

  /** How the decision was made */
  method: 'role-based' | 'trust-based' | 'delegated' | 'elevated' | 'denied';

  /** Which role or trust level granted access */
  grantedBy?: {
    type: 'role' | 'trust';
    value: Role | number;
    context?: PermissionContext;
  };

  /** Reason for the decision */
  reason: string;

  /** Suggestions if denied */
  suggestions?: string[];

  /** Conditions that must be met */
  conditions?: string[];

  /** Audit trail */
  auditInfo?: {
    decidedAt: number;
    evaluatorId: UUID;
    evidence?: any[];
  };
}

/**
 * Request for elevated permissions
 */
export interface ElevationRequest {
  entityId: UUID;
  requestedPermission: Permission;
  justification: string;
  duration?: number; // How long the elevation should last
  context: PermissionContext;
}

/**
 * Result of an elevation request
 */
export interface ElevationResult {
  granted: boolean;
  elevationId?: UUID;
  expiresAt?: number;
  conditions?: string[];
  reason?: string;
  trustDeficit?: number;
  suggestions?: string[];
}

/**
 * Represents a delegation of permissions
 */
export interface PermissionDelegation {
  id: UUID;
  delegatorId: UUID;
  delegateeId: UUID;
  permissions: Permission[];
  context: PermissionContext;
  expiresAt?: number;
  createdAt: number;
  conditions?: string[];
  revoked?: boolean;
  revokedAt?: number;
  revokedBy?: UUID;
}

/**
 * Access request for evaluation
 */
export interface AccessRequest {
  entityId: UUID;
  action: string;
  resource: string;
  context: PermissionContext;
  metadata?: Record<string, any>;
}

/**
 * Complete access decision with all details
 */
export interface AccessDecision extends PermissionDecision {
  request: AccessRequest;
  evaluatedAt: number;
  ttl?: number; // Time to live for caching
  securityChecks?: {
    promptInjection: boolean;
    socialEngineering: boolean;
    anomalyDetection: boolean;
  };
}

// Security Types

export interface SecurityContext extends PermissionContext {
  entityId?: UUID;
  requestedAction?: string;
  messageHistory?: string[];
}

export interface SecurityCheck {
  detected: boolean;
  confidence: number;
  type: 'prompt_injection' | 'social_engineering' | 'anomaly' | 'none';
  severity: 'low' | 'medium' | 'high' | 'critical';
  action: 'block' | 'require_verification' | 'allow' | 'log_only';
  details?: string;
}

export interface ThreatAssessment extends SecurityCheck {
  recommendation?: string;
}

export interface SecurityEvent {
  id?: UUID;
  type: SecurityEventType;
  entityId: UUID;
  severity: 'low' | 'medium' | 'high' | 'critical';
  context: PermissionContext;
  details: any;
  timestamp?: number;
  handled?: boolean;
}

export enum SecurityEventType {
  PROMPT_INJECTION_ATTEMPT = 'prompt_injection_attempt',
  SOCIAL_ENGINEERING_ATTEMPT = 'social_engineering_attempt',
  PRIVILEGE_ESCALATION_ATTEMPT = 'privilege_escalation_attempt',
  ANOMALOUS_REQUEST = 'anomalous_request',
  TRUST_MANIPULATION = 'trust_manipulation',
  IDENTITY_SPOOFING = 'identity_spoofing',
  MULTI_ACCOUNT_ABUSE = 'multi_account_abuse',
}

/**
 * Unix-style permission system for autonomous agents
 * Format: XYYY where:
 * X = Special permissions (setuid, setgid, sticky)
 * First Y = Owner (self) permissions
 * Second Y = Group (admin/trusted) permissions  
 * Third Y = Others (user/anon) permissions
 * 
 * Each digit is sum of: 4 (read), 2 (write), 1 (execute)
 * 
 * Examples:
 * 0700 = Only self can read/write/execute
 * 0755 = Self has full, others can read/execute
 * 0644 = Self read/write, others read only
 * 4755 = Setuid + self full, others read/execute
 */
export interface UnixPermission {
  mode: number; // e.g., 0o755
  owner: 'self' | 'system' | string; // UUID for other agents
  group: 'admin' | 'trusted' | 'user' | string; // Custom groups
  
  // Special bits
  setuid?: boolean; // Execute as owner
  setgid?: boolean; // Execute as group
  sticky?: boolean; // Only owner can delete
}

export interface ActionPermission {
  action: string;
  unix: UnixPermission;
  
  // Additional constraints
  trustRequired?: number; // Minimum trust score
  roleRequired?: string[]; // Required roles
  contextRequired?: string[]; // Required contexts
  
  // For autonomous operations
  selfCallable?: boolean; // Can agent call this on itself
  delegatable?: boolean; // Can delegate to other agents
  auditable?: boolean; // Log all calls
}

export interface PermissionEvaluationContext {
  caller: 'self' | 'admin' | 'user' | 'anon' | string; // UUID for other agents
  action: string;
  target?: string; // Target of the action
  trust?: number; // Caller's trust score
  roles?: string[]; // Caller's roles
  context?: Record<string, any>; // Additional context
}

// Helper functions for Unix permissions
export const PermissionUtils = {
  // Create permission mode from octal string
  fromOctal: (octal: string): number => {
    return parseInt(octal, 8);
  },
  
  // Check if caller has permission
  canExecute: (
    permission: UnixPermission,
    caller: PermissionEvaluationContext
  ): boolean => {
    const mode = permission.mode;
    const ownerPerms = (mode >> 6) & 7;
    const groupPerms = (mode >> 3) & 7;
    const otherPerms = mode & 7;
    
    // Check owner permissions
    if (caller.caller === 'self' || caller.caller === permission.owner) {
      return (ownerPerms & 1) !== 0;
    }
    
    // Check group permissions
    if (caller.caller === 'admin' || 
        (permission.group === 'trusted' && (caller.trust || 0) >= 80) ||
        caller.roles?.includes(permission.group)) {
      return (groupPerms & 1) !== 0;
    }
    
    // Check other permissions
    return (otherPerms & 1) !== 0;
  },
  
  // Check read permission
  canRead: (
    permission: UnixPermission,
    caller: PermissionEvaluationContext
  ): boolean => {
    const mode = permission.mode;
    const ownerPerms = (mode >> 6) & 7;
    const groupPerms = (mode >> 3) & 7;
    const otherPerms = mode & 7;
    
    if (caller.caller === 'self' || caller.caller === permission.owner) {
      return (ownerPerms & 4) !== 0;
    }
    
    if (caller.caller === 'admin' || 
        (permission.group === 'trusted' && (caller.trust || 0) >= 80) ||
        caller.roles?.includes(permission.group)) {
      return (groupPerms & 4) !== 0;
    }
    
    return (otherPerms & 4) !== 0;
  },
  
  // Check write permission
  canWrite: (
    permission: UnixPermission,
    caller: PermissionEvaluationContext
  ): boolean => {
    const mode = permission.mode;
    const ownerPerms = (mode >> 6) & 7;
    const groupPerms = (mode >> 3) & 7;
    const otherPerms = mode & 7;
    
    if (caller.caller === 'self' || caller.caller === permission.owner) {
      return (ownerPerms & 2) !== 0;
    }
    
    if (caller.caller === 'admin' || 
        (permission.group === 'trusted' && (caller.trust || 0) >= 80) ||
        caller.roles?.includes(permission.group)) {
      return (groupPerms & 2) !== 0;
    }
    
    return (otherPerms & 2) !== 0;
  }
};
