/**
 * A simple in-memory message bus for distributing messages from the server
 * to subscribed MessageBusService instances within the same process.
 *
 * For multi-process or multi-server deployments, this would need to be replaced
 * with a more robust solution like Redis Pub/Sub, Kafka, RabbitMQ, etc.
 *
 * Uses Bun-native EventTarget internally but maintains EventEmitter-like API.
 *
 * NOTE: This implementation uses a class extending EventTarget rather than functional
 * patterns because EventTarget is a native browser/Bun API that requires class inheritance.
 * This is an intentional architectural decision to leverage Bun's native capabilities
 * instead of Node.js EventEmitter for better compatibility.
 *
 * NOTE: Unlike standard EventEmitter, this implementation prevents duplicate handler
 * registration. This is an intentional design choice to prevent memory leaks and
 * unintended multiple executions of the same handler.
 */
class InternalMessageBus extends EventTarget {
  private maxListeners: number = 50;
  private handlers = new Map<string, Map<(data: unknown) => void, EventListener>>();

  emit(event: string, data: unknown): boolean {
    return this.dispatchEvent(new CustomEvent(event, { detail: data }));
  }

  on(event: string, handler: (data: unknown) => void): this {
    // Check if handler is already registered
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Map());
    }

    const eventHandlers = this.handlers.get(event)!;

    // If handler already exists, don't add it again
    if (eventHandlers.has(handler)) {
      return this;
    }

    // Wrap the handler to extract data from CustomEvent
    const wrappedHandler = ((e: Event) => {
      if (e instanceof CustomEvent) {
        handler(e.detail);
      } else {
        handler(undefined);
      }
    }) as EventListener;

    // Store mapping for removal later
    eventHandlers.set(handler, wrappedHandler);

    this.addEventListener(event, wrappedHandler);
    return this;
  }

  off(event: string, handler: (data: unknown) => void) {
    const eventHandlers = this.handlers.get(event);
    const wrappedHandler = eventHandlers?.get(handler);

    if (wrappedHandler) {
      this.removeEventListener(event, wrappedHandler);
      eventHandlers?.delete(handler);

      // Clean up empty maps
      if (eventHandlers && eventHandlers.size === 0) {
        this.handlers.delete(event);
      }
    }
  }

  setMaxListeners(n: number) {
    this.maxListeners = n;
    // EventTarget doesn't have a built-in max listeners concept,
    // but we keep this for API compatibility
  }

  removeAllListeners(event?: string) {
    if (event) {
      // Remove all listeners for a specific event
      const eventHandlers = this.handlers.get(event);
      if (eventHandlers) {
        for (const [handler, wrappedHandler] of eventHandlers) {
          this.removeEventListener(event, wrappedHandler);
        }
        this.handlers.delete(event);
      }
    } else {
      // Remove all listeners for all events
      for (const [eventName, eventHandlers] of this.handlers) {
        for (const [handler, wrappedHandler] of eventHandlers) {
          this.removeEventListener(eventName, wrappedHandler);
        }
      }
      this.handlers.clear();
    }
  }
}

const internalMessageBus = new InternalMessageBus();

// Increase the default max listeners if many agents might be running in one process
internalMessageBus.setMaxListeners(50);

export default internalMessageBus;
