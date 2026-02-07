import type { UUID } from '@elizaos/core';
import type { PermissionContext } from './permissions';

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
  CREDENTIAL_THEFT_ATTEMPT = 'credential_theft_attempt',
  PHISHING_ATTEMPT = 'phishing_attempt',
  IMPERSONATION_ATTEMPT = 'impersonation_attempt',
  COORDINATED_ATTACK = 'coordinated_attack',
  MALICIOUS_LINK_CAMPAIGN = 'malicious_link_campaign',
}

export interface PatternDetection {
  type: 'multi_account' | 'phishing' | 'impersonation' | 'coordination' | 'credential_theft';
  confidence: number;
  evidence: string[];
  relatedEntities?: UUID[];
  recommendation: string;
}

export interface MultiAccountDetection extends PatternDetection {
  type: 'multi_account';
  primaryAccount: UUID;
  linkedAccounts: UUID[];
  linkageEvidence: {
    typingPattern: number;
    timingPattern: number;
    vocabularyPattern: number;
    behaviorPattern: number;
  };
}

export interface PhishingDetection extends PatternDetection {
  type: 'phishing';
  maliciousLinks?: string[];
  targetedEntities: UUID[];
  campaignId?: string;
}

export interface ImpersonationDetection extends PatternDetection {
  type: 'impersonation';
  impersonator: string;
  impersonated: string;
  visualSimilarity: number;
  timingCoincidence: number;
}

export interface CoordinationDetection extends PatternDetection {
  type: 'coordination';
  coordinatedEntities: UUID[];
  timeWindow: number;
  correlationScore: number;
}

export interface CredentialTheftDetection extends PatternDetection {
  type: 'credential_theft';
  sensitivePatterns: string[];
  attemptedTheft: string[];
  potentialVictims: UUID[];
}

export interface BehavioralProfile {
  entityId: UUID;
  typingSpeed: number;
  vocabularyComplexity: number;
  messageLength: { mean: number; stdDev: number };
  activeHours: number[];
  commonPhrases: string[];
  interactionPatterns: Map<string, number>;
}

export interface Message {
  id: UUID;
  entityId: UUID;
  content: string;
  timestamp: number;
  roomId?: UUID;
  replyTo?: UUID;
}

export interface Action {
  id: UUID;
  entityId: UUID;
  type: string;
  timestamp: number;
  target?: string;
  result?: 'success' | 'failure';
}
