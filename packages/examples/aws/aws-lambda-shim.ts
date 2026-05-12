declare module "aws-lambda" {
  export interface Context {
    callbackWaitsForEmptyEventLoop: boolean;
    functionName: string;
    functionVersion: string;
    invokedFunctionArn: string;
    memoryLimitInMB: string;
    awsRequestId: string;
    logGroupName: string;
    logStreamName: string;
    getRemainingTimeInMillis(): number;
    done(error?: Error | string | null, result?: unknown): void;
    fail(error: Error | string): void;
    succeed(messageOrObject: unknown): void;
  }

  export interface APIGatewayProxyEventV2 {
    version: string;
    routeKey: string;
    rawPath: string;
    rawQueryString: string;
    headers: Record<string, string>;
    requestContext?: {
      accountId: string;
      apiId: string;
      domainName: string;
      domainPrefix: string;
      http?: {
        method: string;
        path: string;
        protocol: string;
        sourceIp: string;
        userAgent: string;
      };
      requestId: string;
      routeKey: string;
      stage: string;
      time: string;
      timeEpoch: number;
    };
    body?: string;
    isBase64Encoded?: boolean;
  }

  export type APIGatewayProxyResultV2 =
    | string
    | {
        statusCode: number;
        headers?: Record<string, string>;
        body?: string;
        isBase64Encoded?: boolean;
      };
}
