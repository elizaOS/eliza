import type { UUID } from '@elizaos/core';

/**
 * Possible types for form fields
 */
export type FormFieldType =
  | 'text'
  | 'number'
  | 'email'
  | 'tel'
  | 'url'
  | 'textarea'
  | 'choice'
  | 'checkbox'
  | 'date'
  | 'time'
  | 'datetime';

/**
 * Represents a single field in a form
 */
export interface FormField {
  /** Unique identifier for the field */
  id: string;

  /** Display label for the field */
  label: string;

  /** Field type */
  type: FormFieldType;

  /** Optional field description */
  description?: string;

  /** Optional validation criteria */
  criteria?: string;

  /** Whether this field is optional */
  optional?: boolean;

  /** Whether this field contains sensitive data (will be masked in UI) */
  secret?: boolean;

  /** Current value of the field */
  value?: string | number | boolean;

  /** Validation error message */
  error?: string;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Represents a step in a multi-step form
 */
export interface FormStep {
  /** Unique identifier for the step */
  id: string;

  /** Display name for the step */
  name: string;

  /** Fields in this step */
  fields: FormField[];

  /** Whether this step is completed */
  completed?: boolean;

  /** Optional callback when step is completed */
  onComplete?: (form: Form, stepId: string) => Promise<void>;
}

/**
 * Possible statuses for a form
 */
export type FormStatus = 'active' | 'completed' | 'cancelled';

/**
 * Represents a complete form instance
 */
export interface Form {
  /** Unique identifier for the form */
  id: UUID;

  /** Form name/type */
  name: string;

  /** Optional form description */
  description?: string;

  /** Steps in the form */
  steps: FormStep[];

  /** Current step index */
  currentStepIndex: number;

  /** Form status */
  status: FormStatus;

  /** Creation timestamp */
  createdAt: number;

  /** Last update timestamp */
  updatedAt: number;

  /** Completion timestamp */
  completedAt?: number;

  /** Agent that owns this form */
  agentId: UUID;

  /** Optional callback when form is completed */
  onComplete?: (form: Form) => Promise<void>;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Template for creating forms
 */
export interface FormTemplate {
  /** Template name */
  name: string;

  /** Template description */
  description?: string;

  /** Template steps */
  steps: FormStep[];

  /** Template metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result of a form update operation
 */
export interface FormUpdateResult {
  /** Whether the update was successful */
  success: boolean;

  /** Optional form data */
  form?: Form;

  /** Fields that were updated */
  updatedFields?: string[];

  /** Validation errors */
  errors?: Array<{ fieldId: string; message: string }>;

  /** Whether the current step was completed */
  stepCompleted?: boolean;

  /** Whether the entire form was completed */
  formCompleted?: boolean;

  /** Current step name */
  currentStep?: string;

  /** Optional message */
  message?: string;
}
