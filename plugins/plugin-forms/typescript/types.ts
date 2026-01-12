import type { UUID } from "@elizaos/core";

export interface PromptFieldInfo {
  id: string;
  type: string;
  label: string;
  description?: string;
  criteria?: string;
}

export type FormFieldType =
  | "text"
  | "number"
  | "email"
  | "tel"
  | "url"
  | "textarea"
  | "choice"
  | "checkbox"
  | "date"
  | "time"
  | "datetime";

export interface FormField {
  id: string;
  label: string;
  type: FormFieldType;
  description?: string;
  criteria?: string;
  optional?: boolean;
  secret?: boolean;
  value?: string | number | boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface FormStep {
  id: string;
  name: string;
  fields: FormField[];
  completed?: boolean;
  onComplete?: (form: Form, stepId: string) => Promise<void>;
}

export type FormStatus = "active" | "completed" | "cancelled";

export interface Form {
  id: UUID;
  name: string;
  description?: string;
  steps: FormStep[];
  currentStepIndex: number;
  status: FormStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  agentId: UUID;
  onComplete?: (form: Form) => Promise<void>;
  metadata?: Record<string, unknown>;
}

export interface FormTemplate {
  name: string;
  description?: string;
  steps: FormStep[];
  metadata?: Record<string, unknown>;
}

export interface FormUpdateResult {
  success: boolean;
  form?: Form;
  updatedFields?: string[];
  errors?: Array<{ fieldId: string; message: string }>;
  stepCompleted?: boolean;
  formCompleted?: boolean;
  currentStep?: string;
  message?: string;
}
