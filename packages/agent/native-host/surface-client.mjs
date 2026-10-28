/** Browser-safe client. The host supplies its authenticated request adapter and
 * a native handler which rechecks task, selected-page and document authority.
 * There is no reconnect or command retry. A new connection needs a new epoch.
 */
export async function connectSurfaceCommandClient({
  request,
  clientId,
  epoch,
  handleCommand,
  signal,
}) {
  if (typeof request !== "function" || typeof handleCommand !== "function")
    throw new TypeError("Surface transport and native handler are required");
  signal?.throwIfAborted();
  const connection = await request(
    "/browser/surface/connect",
    { clientId, epoch },
    signal,
  );
  if (typeof connection?.connectionId !== "string" || !connection.connectionId)
    throw new Error("Invalid surface connection reply");
  const lifetime = new AbortController(),
    active = new Map();
  let sequence = 0,
    transportError = null;
  const stop = () => {
    lifetime.abort();
    for (const entry of active.values()) entry.controller.abort();
  };
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  const failure = (code, message) =>
    Object.assign(new Error(message), { code });
  const execute = async (command) => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(0, command.expiresAt - Date.now()),
    );
    active.set(command.id, { controller });
    let started = false;
    try {
      let reply;
      try {
        if (
          lifetime.signal.aborted ||
          controller.signal.aborted ||
          command.expiresAt <= Date.now()
        )
          throw failure("STALE_REF", "Surface command expired before dispatch");
        started = true;
        const result = await handleCommand(command.input, {
          signal: controller.signal,
          expiresAt: command.expiresAt,
        });
        if (lifetime.signal.aborted || controller.signal.aborted)
          throw failure(
            command.effect ? "UNCERTAIN_OUTCOME" : "STALE_REF",
            "Surface command context ended",
          );
        reply = { result };
      } catch (error) {
        const fallback =
          started && command.effect ? "UNCERTAIN_OUTCOME" : "STALE_REF";
        reply = {
          error: {
            code: /^[A-Z_]{1,64}$/.test(error?.code ?? "")
              ? error.code
              : fallback,
            message:
              typeof error?.message === "string" && error.message.length <= 1024
                ? error.message
                : "Surface command failed",
          },
        };
      }
      if (!lifetime.signal.aborted) {
        try {
          await request(
            "/browser/surface/reply",
            { ...connection, id: command.id, ...reply },
            lifetime.signal,
          );
        } catch (error) {
          if (error?.code !== "STALE_REF") throw error;
        }
      }
    } catch (error) {
      transportError = error;
      stop();
    } finally {
      clearTimeout(timer);
      active.delete(command.id);
    }
  };
  const completion = (async () => {
    let completionError = null;
    try {
      while (!lifetime.signal.aborted) {
        const response = await request(
          "/browser/surface/pull",
          connection,
          lifetime.signal,
        );
        if (lifetime.signal.aborted) break;
        if (
          !Array.isArray(response?.cancellations) ||
          response.cancellations.some((id) => typeof id !== "string")
        )
          throw new Error("Invalid surface cancellation reply");
        for (const id of response.cancellations)
          active.get(id)?.controller.abort();
        const command = response.command;
        if (command === null) continue;
        if (
          !command ||
          typeof command.id !== "string" ||
          !Number.isSafeInteger(command.sequence) ||
          command.sequence <= sequence ||
          !Number.isSafeInteger(command.expiresAt) ||
          command.expiresAt > Date.now() + 30000 ||
          typeof command.effect !== "boolean" ||
          active.size >= 16
        )
          throw new Error("Invalid or repeated surface command");
        sequence = command.sequence;
        void execute(command);
      }
      if (transportError) throw transportError;
    } catch (error) {
      if (!lifetime.signal.aborted || transportError)
        completionError = transportError ?? error;
    } finally {
      stop();
      signal?.removeEventListener("abort", stop);
      // Closing the host connection retires delivered effects as uncertain even
      // if a native operation has not yet returned. It does not claim to undo it.
      try {
        await request(
          "/browser/surface/close",
          connection,
          AbortSignal.timeout(3000),
        );
      } catch (error) {
        if (error?.code !== "STALE_REF") completionError ??= error;
      }
    }
    if (completionError) throw completionError;
  })();
  // The caller can await the original rejection without a detached-loop warning.
  void completion.catch(() => {});
  return {
    connectionId: connection.connectionId,
    completion,
    async close() {
      stop();
      await completion;
    },
  };
}
