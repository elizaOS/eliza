/**
 * Acquire a local gateway's resources in order and release all of them, even if
 * an earlier release throws. Factories retain authentication and domain policy.
 * Importing this module does not start a host or read account configuration.
 */
export async function startGatewayLifecycle({
  createHelper,
  createTaskGateway,
  startCapture,
  createReputation,
  createServer,
  port,
  hostname = "127.0.0.1",
  onCleanupError = () => {},
}) {
  const releases = [];
  let cleanup;
  let server;
  let serverClosed = false;
  let closing;
  const release = () => {
    cleanup ??= (async () => {
      const errors = [];
      for (const dispose of releases.toReversed()) {
        try {
          await dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, "Gateway cleanup failed");
    })();
    return cleanup;
  };
  const reportCleanup = () => {
    void release().catch((error) => {
      // An observer must not create an unhandled rejection during shutdown.
      try {
        onCleanupError(error);
      } catch {}
    });
  };
  const close = () => {
    closing ??= (async () => {
      if (server && !serverClosed && server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
      await release();
    })();
    return closing;
  };
  try {
    const helper = await createHelper?.();
    if (helper?.close) releases.push(() => helper.close());
    const taskGateway = await createTaskGateway(helper);
    if (taskGateway?.close) releases.push(() => taskGateway.close());
    const capture = await startCapture?.(taskGateway);
    if (capture?.stop) releases.push(() => capture.stop());
    const reputation = await createReputation?.();
    if (reputation?.stop) releases.push(() => reputation.stop());
    await reputation?.start?.();
    server = await createServer({ taskGateway, reputation });
    server.once("close", () => {
      serverClosed = true;
      reportCleanup();
    });
    await new Promise((resolve, reject) => {
      const failed = (error) => {
        server.off("listening", ready);
        reject(error);
      };
      const ready = () => {
        server.off("error", failed);
        resolve();
      };
      server.once("error", failed);
      server.once("listening", ready);
      try {
        server.listen(port, hostname);
      } catch (error) {
        server.off("error", failed);
        server.off("listening", ready);
        reject(error);
      }
    });
    return { server, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Gateway startup failed and cleanup requires attention",
        { cause: error },
      );
    }
    throw error;
  }
}
