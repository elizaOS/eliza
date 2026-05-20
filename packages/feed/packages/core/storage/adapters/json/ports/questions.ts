/**
 * JSON Question Adapter
 */

import type { QuestionPort } from '../../../ports/questions';
import type { QuestionRecord } from '../../../types';
import type { JsonIdGenerator } from '../id-generator';
import type { JsonStorageState } from '../types';

export class JsonQuestionAdapter implements QuestionPort {
  constructor(
    private state: JsonStorageState,
    private idGen: JsonIdGenerator,
    private onChange: () => void
  ) {}

  async getQuestion(id: string): Promise<QuestionRecord | null> {
    return this.state.questions[id] ?? null;
  }

  async getQuestionByNumber(
    questionNumber: number
  ): Promise<QuestionRecord | null> {
    return (
      Object.values(this.state.questions).find(
        (q) => q.questionNumber === questionNumber
      ) ?? null
    );
  }

  async getActiveQuestions(timeframe?: string): Promise<QuestionRecord[]> {
    let questions = Object.values(this.state.questions).filter(
      (q) => q.status === 'active'
    );

    if (timeframe) {
      const now = new Date();
      let endDate: Date | undefined;

      switch (timeframe) {
        case '24h':
          endDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
          questions = questions.filter(
            (q) => q.resolutionDate >= now && q.resolutionDate <= endDate!
          );
          break;
        case '7d':
          endDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
          questions = questions.filter(
            (q) => q.resolutionDate >= now && q.resolutionDate <= endDate!
          );
          break;
        case '30d':
          endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
          questions = questions.filter(
            (q) => q.resolutionDate >= now && q.resolutionDate <= endDate!
          );
          break;
        case '30d+':
          const startDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
          questions = questions.filter((q) => q.resolutionDate >= startDate);
          break;
      }
    }

    return questions.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );
  }

  async getQuestionsToResolve(beforeTime?: Date): Promise<QuestionRecord[]> {
    const time = beforeTime ?? new Date();
    return Object.values(this.state.questions).filter(
      (q) => q.status === 'active' && q.resolutionDate <= time
    );
  }

  async getAllQuestions(): Promise<QuestionRecord[]> {
    return Object.values(this.state.questions).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );
  }

  async createQuestion(
    question: Omit<QuestionRecord, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<QuestionRecord> {
    const now = new Date();
    const id = this.idGen.generate('question');
    const record: QuestionRecord = {
      ...question,
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.state.questions[id] = record;
    this.onChange();
    return record;
  }

  async resolveQuestion(
    id: string,
    resolvedOutcome: boolean
  ): Promise<QuestionRecord> {
    const question = this.state.questions[id];
    if (!question) {
      throw new Error(`Question not found: ${id}`);
    }

    question.status = 'resolved';
    question.resolvedOutcome = resolvedOutcome;
    question.updatedAt = new Date();
    this.onChange();
    return question;
  }

  async updateQuestion(
    id: string,
    updates: Partial<QuestionRecord>
  ): Promise<QuestionRecord> {
    const question = this.state.questions[id];
    if (!question) {
      throw new Error(`Question not found: ${id}`);
    }

    Object.assign(question, updates, { updatedAt: new Date() });
    this.onChange();
    return question;
  }

  async getActiveQuestionCount(): Promise<number> {
    return Object.values(this.state.questions).filter(
      (q) => q.status === 'active'
    ).length;
  }
}
