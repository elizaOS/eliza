/**
 * Trust Security Benchmark Types
 *
 * Defines the interfaces for adversarial testing of trust plugin
 * security detection capabilities.
 */

export type ThreatCategory =
  | "prompt_injection"
  | "social_engineering"
  | "impersonation"
  | "credential_theft"
  | "benign";

export interface TestCase {
  id: string;
  category: ThreatCategory;
  /** The message or input to test */
  input: string;
  /** For impersonation tests: existing usernames */
  existingUsers?: string[];
  /** Whether the input is actually malicious */
  expectedMalicious: boolean;
  /** Expected detection type if malicious */
  expectedType?: string;
  /** Description of what this test covers */
  description: string;
  /** Difficulty level */
  difficulty: "easy" | "medium" | "hard";
}

export interface DetectionResult {
  testId: string;
  detected: boolean;
  confidence: number;
  detectedType?: string;
}

export interface CategoryScore {
  category: ThreatCategory;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  total: number;
}

export interface BenchmarkResult {
  categories: CategoryScore[];
  overallF1: number;
  falsePositiveRate: number;
  totalTests: number;
  timestamp: number;
}

export interface TrustBenchmarkHandler {
  name: string;

  /** Analyze a message for prompt injection */
  detectInjection(message: string): Promise<{ detected: boolean; confidence: number }>;

  /** Analyze a message for social engineering */
  detectSocialEngineering(message: string): Promise<{ detected: boolean; confidence: number }>;

  /** Check if a username is impersonating an existing user */
  detectImpersonation(
    username: string,
    existingUsers: string[],
  ): Promise<{ detected: boolean; confidence: number }>;

  /** Analyze a message for credential theft */
  detectCredentialTheft(message: string): Promise<{ detected: boolean; confidence: number }>;
}
