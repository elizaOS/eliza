/**
 * A simple in-memory message bus for distributing messages from the server
 * to subscribed MessageBusService instances within the same process.
 *
 * For multi-process or multi-server deployments, this would need to be replaced
 * with a more robust solution like Redis Pub/Sub, Kafka, RabbitMQ, etc.
 * 
 * Uses Bun-native EventTarget internally but maintains EventEmitter-like API.
 */
class InternalMessageBus extends EventTarget {
    private maxListeners: number = 50;
    private handlers = new Map<string, Map<Function, EventListener>>();

    emit(event: string, data: any) {
        this.dispatchEvent(new CustomEvent(event, { detail: data }));
    }

    on(event: string, handler: (data: any) => void) {
        // Wrap the handler to extract data from CustomEvent
        const wrappedHandler = ((e: CustomEvent) => handler(e.detail)) as EventListener;
        
        // Store mapping for removal later
        if (!this.handlers.has(event)) {
            this.handlers.set(event, new Map());
        }
        this.handlers.get(event)!.set(handler, wrappedHandler);
        
        this.addEventListener(event, wrappedHandler);
    }

    off(event: string, handler: (data: any) => void) {
        const eventHandlers = this.handlers.get(event);
        const wrappedHandler = eventHandlers?.get(handler);
        
        if (wrappedHandler) {
            this.removeEventListener(event, wrappedHandler);
            eventHandlers!.delete(handler);
        }
    }

    setMaxListeners(n: number) {
        this.maxListeners = n;
        // EventTarget doesn't have a built-in max listeners concept,
        // but we keep this for API compatibility
    }
}

const internalMessageBus = new InternalMessageBus();

// Increase the default max listeners if many agents might be running in one process
internalMessageBus.setMaxListeners(50);

export default internalMessageBus;
