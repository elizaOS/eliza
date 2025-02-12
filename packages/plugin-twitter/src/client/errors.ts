export class ApiError extends Error {
  private constructor(
    readonly response: Response,
    readonly data: any,
    message: string,
  ) {
    super(message);
  }

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

interface Position {
  line: number;
  column: number;
}

interface TraceInfo {
  trace_id: string;
}

interface TwitterApiErrorExtensions {
  code?: number;
  kind?: string;
  name?: string;
  source?: string;
  tracing?: TraceInfo;
}

export interface TwitterApiErrorRaw extends TwitterApiErrorExtensions {
  message?: string;
  locations?: Position[];
  path?: string[];
  extensions?: TwitterApiErrorExtensions;
}
