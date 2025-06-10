/**
 * Interface for defining the structure of an API response.
 * @template T - The type of data included in the response.
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Defines the structure of AgentBasic interface.
 */
export interface AgentBasic {
  id: string;
  name: string;
  status?: string;
  [key: string]: unknown;
}
