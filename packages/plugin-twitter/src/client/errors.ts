/**
 * Class representing an API error.
 */

export class ApiError extends Error {
  /**
   * Constructor for creating a new instance of the class.
   *
   * @param response The response object.
   * @param data The data object.
   * @param message The message string.
   */
  private constructor(
    readonly response: Response,
    readonly data: any,
    message: string
  ) {
    super(message);
  }

  /**
   * Creates an instance of ApiError based on a Response object.
   *
   * @param {Response} response The Response object to parse.
   * @returns {Promise<ApiError>} A new instance of ApiError with the parsed data and status.
   */
  static async fromResponse(response: Response) {
    // Try our best to parse the result, but don't bother if we can't
    let data: string | object | undefined = undefined;
    try {
      data = await response.json();
    } catch {
      try {
        data = await response.text();
      } catch {}
    }

    return new ApiError(response, data, `Response status: ${response.status}`);
  }
}

/**
 * Represents a position in a file with line and column information.
 * @interface Position
 * @property {number} line - The line number of the position.
 * @property {number} column - The column number of the position.
 */
interface Position {
  line: number;
  column: number;
}

/**
 * Interface representing trace information.
 * @property { string } trace_id - The ID of the trace.
 */
interface TraceInfo {
  trace_id: string;
}

/**
 * Interface representing additional information that can be included in Twitter API error objects.
 * @typedef { Object } TwitterApiErrorExtensions
 * @property { number } [code] - The error code associated with the error.
 * @property { string } [kind] - The kind of error that occurred.
 * @property { string } [name] - The name of the error.
 * @property { string } [source] - The source of the error.
 * @property { TraceInfo } [tracing] - Information about the tracing of the error.
 */
interface TwitterApiErrorExtensions {
  code?: number;
  kind?: string;
  name?: string;
  source?: string;
  tracing?: TraceInfo;
}

/**
 * Interface representing a raw Twitter API error object.
 * @interface
 * @extends {TwitterApiErrorExtensions}
 * @property {string} [message] The error message.
 * @property {Position[]} [locations] An array of positions.
 * @property {string[]} [path] An array representing the path of the error.
 * @property {TwitterApiErrorExtensions} [extensions] Additional error extensions.
 */
export interface TwitterApiErrorRaw extends TwitterApiErrorExtensions {
  message?: string;
  locations?: Position[];
  path?: string[];
  extensions?: TwitterApiErrorExtensions;
}
