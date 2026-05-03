declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

declare const Bun: {
  serve(options: { port: number; fetch(request: Request): Response | Promise<Response> }): {
    stop(): void;
  };
};
