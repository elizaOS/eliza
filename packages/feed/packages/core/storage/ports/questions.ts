/**
 * Question Storage Port
 *
 * Defines the interface for question data access.
 */

import type { QuestionRecord } from "../types";

export interface QuestionPort {
  // Question Operations
  getQuestion(id: string): Promise<QuestionRecord | null>;
  getQuestionByNumber(questionNumber: number): Promise<QuestionRecord | null>;

  // Query Operations
  getActiveQuestions(timeframe?: string): Promise<QuestionRecord[]>;
  getQuestionsToResolve(beforeTime?: Date): Promise<QuestionRecord[]>;
  getAllQuestions(): Promise<QuestionRecord[]>;

  // Create/Update Operations
  createQuestion(
    question: Omit<QuestionRecord, "id" | "createdAt" | "updatedAt">,
  ): Promise<QuestionRecord>;
  resolveQuestion(
    id: string,
    resolvedOutcome: boolean,
  ): Promise<QuestionRecord>;
  updateQuestion(
    id: string,
    updates: Partial<QuestionRecord>,
  ): Promise<QuestionRecord>;

  // Statistics
  getActiveQuestionCount(): Promise<number>;
}
