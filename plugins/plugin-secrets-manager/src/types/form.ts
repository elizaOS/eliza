import type { SecretConfig } from "../types";

/**
 * Form field types
 */
export type FormFieldType =
  | "text"
  | "password"
  | "email"
  | "tel"
  | "number"
  | "url"
  | "textarea"
  | "select"
  | "radio"
  | "checkbox"
  | "file"
  | "date"
  | "creditcard"
  | "json"
  | "code";

/**
 * Validation rules for form fields
 */
export interface ValidationRule {
  type:
    | "required"
    | "minLength"
    | "maxLength"
    | "pattern"
    | "min"
    | "max"
    | "custom";
  value?: any;
  message: string;
  validator?: (value: any) => boolean;
}

/**
 * Individual form field definition
 */
export interface FormField {
  name: string;
  label: string;
  type: FormFieldType;
  placeholder?: string;
  description?: string;
  defaultValue?: any;
  required?: boolean;
  validation?: ValidationRule[];
  options?: Array<{
    label: string;
    value: string;
  }>;
  multiple?: boolean;
  accept?: string; // For file inputs
  autoComplete?: string;
  sensitive?: boolean; // Should be masked/hidden
  rows?: number; // For textarea
}

/**
 * Form schema definition
 */
export interface FormSchema {
  id: string;
  title: string;
  description?: string;
  fields: FormField[];
  submitLabel?: string;
  mode: "requester" | "inline";
  theme?: "light" | "dark" | "auto";
  expiresAt?: number;
  maxSubmissions?: number;
  successMessage?: string;
  styling?: {
    primaryColor?: string;
    fontFamily?: string;
    width?: "sm" | "md" | "lg" | "xl" | "full";
  };
}

/**
 * Form submission data
 */
export interface FormSubmission {
  formId: string;
  sessionId: string;
  data: Record<string, any>;
  submittedAt: number;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Form request configuration
 */
export interface SecretFormRequest {
  // What secrets are being requested
  secrets: Array<{
    key: string;
    config: Partial<SecretConfig>;
    field?: Partial<FormField>;
  }>;

  // Form configuration
  title?: string;
  description?: string;
  mode?: "requester" | "inline";

  // Security options
  expiresIn?: number; // milliseconds
  maxSubmissions?: number;
  requireAuth?: boolean;

  // Callback configuration
  callbackId?: string;
  metadata?: Record<string, any>;
}

/**
 * Form session tracking
 */
export interface FormSession {
  id: string;
  formId: string;
  tunnelId: string;
  port: number;
  url: string;
  schema: FormSchema;
  request: SecretFormRequest;
  createdAt: number;
  expiresAt: number;
  submissions: FormSubmission[];
  status: "active" | "completed" | "expired" | "cancelled";
  callback?: (submission: FormSubmission) => Promise<void>;
}

/**
 * Common form field presets
 */
export const FormFieldPresets: Record<string, Partial<FormField>> = {
  apiKey: {
    type: "password",
    label: "API Key",
    placeholder: "Enter your API key",
    required: true,
    sensitive: true,
    validation: [
      {
        type: "required",
        message: "API key is required",
      },
      {
        type: "minLength",
        value: 10,
        message: "API key must be at least 10 characters",
      },
    ],
  },

  email: {
    type: "email",
    label: "Email Address",
    placeholder: "your@email.com",
    required: true,
    validation: [
      {
        type: "required",
        message: "Email is required",
      },
      {
        type: "pattern",
        value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        message: "Please enter a valid email address",
      },
    ],
  },

  webhookUrl: {
    type: "url",
    label: "Webhook URL",
    placeholder: "https://your-webhook.com/endpoint",
    required: true,
    validation: [
      {
        type: "required",
        message: "Webhook URL is required",
      },
      {
        type: "pattern",
        value: /^https?:\/\/.+/,
        message: "Please enter a valid URL starting with http:// or https://",
      },
    ],
  },

  creditCard: {
    type: "creditcard",
    label: "Credit Card Number",
    placeholder: "1234 5678 9012 3456",
    required: true,
    sensitive: true,
    autoComplete: "cc-number",
    validation: [
      {
        type: "required",
        message: "Credit card number is required",
      },
      {
        type: "custom",
        message: "Please enter a valid credit card number",
        validator: (value: string) => {
          // Basic Luhn algorithm check
          const digits = value.replace(/\D/g, "");
          if (digits.length < 13 || digits.length > 19) return false;

          let sum = 0;
          let isEven = false;
          for (let i = digits.length - 1; i >= 0; i--) {
            let digit = parseInt(digits[i], 10);
            if (isEven) {
              digit *= 2;
              if (digit > 9) digit -= 9;
            }
            sum += digit;
            isEven = !isEven;
          }
          return sum % 10 === 0;
        },
      },
    ],
  },

  privateKey: {
    type: "textarea",
    label: "Private Key",
    placeholder: "Paste your private key here",
    required: true,
    sensitive: true,
    rows: 10,
    validation: [
      {
        type: "required",
        message: "Private key is required",
      },
    ],
  },

  jsonConfig: {
    type: "code",
    label: "JSON Configuration",
    placeholder: '{\n  "key": "value"\n}',
    required: true,
    validation: [
      {
        type: "required",
        message: "Configuration is required",
      },
      {
        type: "custom",
        message: "Must be valid JSON",
        validator: (value: string) => {
          try {
            JSON.parse(value);
            return true;
          } catch {
            return false;
          }
        },
      },
    ],
  },
};
